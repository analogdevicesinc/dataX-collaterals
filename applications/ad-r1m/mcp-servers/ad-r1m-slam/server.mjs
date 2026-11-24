#!/usr/bin/env node
// @ts-check
// AD-R1M robot MCP server: connect, provision, check and run SLAM / Nav2 on an AD-R1M over
// SSH (sshpass). Robot-side work is in scripts/*.sh; how to use the tools is in the skills
// (plugins/datax/skills/ad-r1m-*).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { packageEvidence } from "./lib/evidence.mjs";
import { buildRobotImage } from "./lib/image.mjs";
import { kuiperSdCard, rviz } from "./lib/local.mjs";
import * as robot from "./lib/robot.mjs";
import { config, selectRobot } from "./lib/ssh.mjs";

const str = (/** @type {string} */ description, /** @type {string[]} */ values) => ({ type: "string", description, ...(values ? { enum: values } : {}) });
const bool = (/** @type {string} */ description) => ({ type: "boolean", description });
const obj = (/** @type {Record<string, any>} */ properties, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: false });
const HOST = { host: str("Switch to this robot first (hostname or IP); it stays selected.") };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const CHANGES = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

/** @type {{name: string, description: string, inputSchema: any, annotations: any, run: (a: any) => Promise<any>}[]} */
const TOOLS = [
  {
    name: "connect_robot",
    description:
      "Connect to an AD-R1M over SSH and make it the selected robot (saved across restarts). Bare names get .local " +
      "(ad-r1m-42 -> ad-r1m-42.local). Returns the onboarding state (fresh_kuiper / no_stack / stack_stopped / ready, or " +
      "ssh_auth_failed / unreachable), hostname, packages and containers. The selection is unchanged if SSH fails.",
    inputSchema: obj({ host: str("Hostname or IP, e.g. ad-r1m-42, analog.local, 192.168.1.50"), password: str("SSH password, as given by the user"), user: str("SSH user (default analog)") }, ["host", "password"]),
    annotations: { ...CHANGES, idempotentHint: true },
    run: robot.connectRobot,
  },
  {
    name: "robot_status",
    description:
      "AD-R1M health in one call: onboarding state, containers, ROS topics, sensor flags (ToF /cam1, /scan, " +
      "/odometry/filtered) and wheel drives (ros2_control controllers, /joint_states, CAN heartbeats when unhealthy). " +
      "detail=full adds systemd services, packages, images, network, disk and temperature.",
    inputSchema: obj({ ...HOST, detail: str("status (default) or full", ["status", "full"]) }),
    annotations: RO,
    run: robot.robotStatus,
  },
  {
    name: "ros2_query",
    description:
      "Read-only robot queries. kind: topics (ros2 topic list -t), nodes, topic_info (name=topic, verbose), params " +
      "(name=node, ros2 param dump), logs (name=container, lines), read_file (path; target=slam container or host, ~ = " +
      "the robot user's home). filter: regex for topics/nodes.",
    inputSchema: obj({
      ...HOST,
      kind: str("What to read", ["topics", "nodes", "topic_info", "params", "logs", "read_file"]),
      name: str("Topic, node or container name"),
      filter: str("Regex filter for topics / nodes"),
      lines: { type: "number", description: "Log lines (default 50)" },
      path: str("File path for read_file"),
      target: str("read_file location: slam (default, the SLAM container) or host", ["slam", "host"]),
    }, ["kind"]),
    annotations: RO,
    run: robot.ros2Query,
  },
  {
    name: "diagnostics",
    description:
      "Measurements for a running stack. target=slam: SLAM nodes, publishers and rates of /map, /scan, /cam1/point_cloud, " +
      "/odometry/filtered (6 s sample), TF map->odom and odom->base_link, wheel drives, RTAB-Map CPU/memory and key " +
      "parameters. target=nav: Nav2 lifecycle states and costmap / plan / map publishers.",
    inputSchema: obj({ ...HOST, target: str("slam (default) or nav", ["slam", "nav"]) }),
    annotations: RO,
    run: robot.diagnostics,
  },
  {
    name: "slam",
    description:
      "SLAM in the slam_workspace container (create it with setup_workspace). action=start deploys a tested RTAB-Map " +
      "template as launch.py (template depth_rgb, the default, or depth_pointcloud; 'deployed' runs what is already " +
      "deployed) and launches it; action=stop kills all SLAM processes; action=deploy writes a custom launch_file " +
      "(plus helpers and params_yaml) or a template into the slam_integration package and builds it.",
    inputSchema: obj({
      ...HOST,
      action: str("start, stop or deploy", ["start", "stop", "deploy"]),
      template: str("Tested template (default depth_rgb); start also accepts 'deployed'", ["depth_rgb", "depth_pointcloud", "deployed"]),
      launch_file: str("deploy: launch file content (Python)"),
      filename: str("deploy: launch file name (default launch.py; slam start runs launch.py)"),
      helpers: { type: "object", additionalProperties: { type: "string" }, description: "deploy: extra scripts for launch/, filename -> content" },
      params_yaml: str("deploy: parameter file content, written to config/params.yaml"),
    }, ["action"]),
    annotations: CHANGES,
    run: robot.slam,
  },
  {
    name: "slam_set_params",
    description: "Set RTAB-Map parameters on the running /rtabmap node (e.g. {\"Rtabmap/DetectionRate\": \"0.5\"}). Reports per parameter whether the node accepted it.",
    inputSchema: obj({ ...HOST, params: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] }, description: "RTAB-Map parameter -> value" } }, ["params"]),
    annotations: { ...CHANGES, idempotentHint: true },
    run: robot.slamSetParams,
  },
  {
    name: "nav",
    description:
      "Nav2 in the robot's nav compose service. action=start (on /scan), start_pointcloud (on the ToF cloud, strided to " +
      "/cam1/point_cloud_nav at 5 Hz for the RPi 5, via an override file), stop.",
    inputSchema: obj({ ...HOST, action: str("start, start_pointcloud or stop", ["start", "start_pointcloud", "stop"]) }, ["action"]),
    annotations: CHANGES,
    run: robot.nav,
  },
  {
    name: "restart",
    description:
      "Restart robot software or hardware. target=stack: docker compose stop + start in the active config folder " +
      "(re-runs the CANopen drive boot). slcan / crsf / imu / tof: restart that ad-r1m-* unit (sudo) after stopping the " +
      "compose services that hold it; slcan resets can0 and all drives and reports which CANopen nodes answer.",
    inputSchema: obj({ ...HOST, target: str("stack (default), slcan, crsf, imu or tof", ["stack", "slcan", "crsf", "imu", "tof"]) }),
    annotations: { ...CHANGES, idempotentHint: true },
    run: robot.restart,
  },
  {
    name: "setup_workspace",
    description:
      "Create or reuse the slam_workspace container (from the shared robot-slam image, else the stock robot image) and " +
      "install a SLAM package with rosdep, then its Debian binary, then, with repo, a source build. Commits the result " +
      "to robot-slam. Recreates the container if it runs another image. Can take 10+ minutes.",
    inputSchema: obj({ ...HOST, package: str("ROS 2 package (default rtabmap_ros)"), repo: str("Git URL to build from when no binary exists") }),
    annotations: CHANGES,
    run: robot.setupWorkspace,
  },
  {
    name: "robot_config",
    description: "The robot's ad-r1m config folders. action=list, active, mkconfig (folder), enable (folder, sudo; restart=true restarts ad-r1m-bringup now).",
    inputSchema: obj({ ...HOST, action: str("list, active, mkconfig or enable", ["list", "active", "mkconfig", "enable"]), folder: str("Config folder, e.g. ~/demo"), restart: bool("enable: restart ad-r1m-bringup now") }, ["action"]),
    annotations: CHANGES,
    run: robot.robotConfig,
  },
  {
    name: "collect_support_bundle",
    description: "Collect versions, services, journal, compose logs, ROS topics/nodes, network and disk from the robot into a .tar.gz on this PC.",
    inputSchema: obj({ ...HOST, output_dir: str("Where to save it (default: temp dir)") }),
    annotations: RO,
    run: robot.supportBundle,
  },
  {
    name: "provision_robot",
    description:
      "First-time setup of a Kuiper-flashed robot, in order: wifi, hostname, upgrade, install_system_package and " +
      "docker_image (both need Cloudsmith credentials), demo_config (~/demo from ad-r1m-ros2 at config_ref, enabled), " +
      "reboot. dry_run defaults to true and only returns the plan: show it and get confirmation first.",
    inputSchema: obj({
      ...HOST,
      hostname: str("New hostname, e.g. ad-r1m-42"),
      wifi: obj({ ssid: str("Network"), password: str("Password") }, ["ssid"]),
      upgrade: bool("apt-get upgrade"),
      install_system_package: bool("Install ad-r1m-system-rpi5 from the Cloudsmith apt repo"),
      system_package: str("Default ad-r1m-system-rpi5"),
      cloudsmith: obj({ user: str("Service user"), token: str("Token") }, ["user", "token"]),
      docker_image: bool("docker login + pull the robot image (prune -a removes all existing images)"),
      demo_config: bool("Create, refresh and enable ~/demo"),
      config_ref: str("ad-r1m-ros2 tag or branch for demo_config (default main); use the robot image's ref"),
      reboot: bool("Reboot at the end and wait for the robot"),
      dry_run: bool("Only describe the steps (default true)"),
    }),
    annotations: DESTRUCTIVE,
    run: robot.provisionRobot,
  },
  {
    name: "build_robot_image",
    description:
      "Build the robot image on the robot from ad-r1m-ros2's Dockerfile (as the release CI does) when it cannot be pulled " +
      "from Cloudsmith; optionally the ad-r1m-system-rpi5 .deb too (system_package=true). action=status (default), start, " +
      "stop, install_system_package. start and install_system_package default to dry_run=true. Background job, 10-30 min.",
    inputSchema: obj({
      ...HOST,
      action: str("status, start, stop or install_system_package", ["status", "start", "stop", "install_system_package"]),
      ref: str("ad-r1m-ros2 tag or branch (default: latest release)"),
      image: str("Image tag (default: the robot image name)"),
      target: str("Dockerfile target (default runner)"),
      system_package: bool("Also build the ad-r1m-system-rpi5 .deb"),
      install_prerequisites: bool("Allow sudo apt-get install / docker group changes the build needs"),
      dry_run: bool("Only return the plan (default true for start and install_system_package)"),
    }),
    annotations: DESTRUCTIVE,
    run: buildRobotImage,
  },
  {
    name: "kuiper_sd_card",
    description:
      "On this PC: download the ADI Kuiper image and flash an SD card for the AD-R1M. action=status, download, " +
      "list_devices (removable disks without system mounts only), flash (ERASES the card; dry_run defaults to true), " +
      "add_wifi (NetworkManager profile on a flashed card). Needs passwordless sudo for dd.",
    inputSchema: obj({
      action: str("status, download, list_devices, flash or add_wifi", ["status", "download", "list_devices", "flash", "add_wifi"]),
      device: str("SD card device, e.g. /dev/mmcblk0"),
      wifi: obj({ ssid: str("Network"), password: str("Password") }, ["ssid"]),
      url: str("Image URL (default: Kuiper 2026.1.1 full 64-bit)"),
      dir: str("Download folder (default ~/Downloads)"),
      dry_run: bool("flash: only describe it (default true)"),
    }, ["action"]),
    annotations: DESTRUCTIVE,
    run: kuiperSdCard,
  },
  {
    name: "rviz",
    description:
      "RViz on this PC, joined to the robot's Zenoh router (tcp/<robot>:7447). action=start (default), stop, status, " +
      "setup (create a pixi workspace with ROS 2 desktop + rmw_zenoh, ~2 GB: confirm first). runtime auto prefers pixi, then native /opt/ros.",
    inputSchema: obj({ action: str("start, stop, status or setup", ["start", "stop", "status", "setup"]), runtime: str("auto, pixi or native", ["auto", "pixi", "native"]), config: str("RViz config (default templates/rtab.rviz)") }),
    annotations: CHANGES,
    run: rviz,
  },
  {
    name: "package_evidence",
    description:
      "Facts for evaluating ROS 2 SLAM packages on this robot, no scores: robot sensors, compute and apt binaries; each " +
      "package's repo (local sparse clone: ROS 1/2 build types, CUDA, x86-only flags, message types in code, launch " +
      "files, README); field notes and tested templates from catalog.json; matching research lines. Default: every catalog package.",
    inputSchema: obj({
      packages: { type: "array", items: { anyOf: [{ type: "string" }, obj({ name: str("Package"), repo: str("Git URL") }, ["name"])] }, description: "Names, catalog aliases or {name, repo}" },
      live: bool("Probe the robot (default true; false uses ROBOT_SPEC.md)"),
      github: bool("Read the repositories (default true)"),
      readme_chars: { type: "number", description: "README excerpt length (default 1200)" },
      refresh: bool("Re-fetch cached repositories"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    run: packageEvidence,
  },
];

const server = new Server({ name: "ad-r1m-slam", version: "0.7.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  const args = /** @type {any} */ (req.params.arguments || {});
  try {
    if (!tool) throw new Error(`Unknown tool ${req.params.name}`);
    // host switches the selected robot for this and later calls (not for connect / provisioning).
    if (args.host && !["connect_robot", "provision_robot"].includes(tool.name) && args.host !== config.host) selectRobot({ host: args.host });
    const result = await tool.run(args);
    return { content: [{ type: "text", text: typeof result === "string" ? result || "(no output)" : JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: /** @type {Error} */ (e).message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error("ad-r1m-slam MCP server running on stdio");
