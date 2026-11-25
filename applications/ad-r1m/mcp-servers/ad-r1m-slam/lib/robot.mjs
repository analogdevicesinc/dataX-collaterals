// @ts-check
// Tools that run scripts/*.sh on the robot. Results are measurements; how to read them and
// what to do next is in the skills (ad-r1m-robot, ad-r1m-bringup).
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config, kv, lines, run, sections, selectRobot, selectedTarget, slamImage, ssh, shq, SshError, NO_ROBOT_HINT, TEMPLATES_DIR } from "./ssh.mjs";

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const list = (/** @type {string|undefined} */ s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
const b64file = (/** @type {string} */ f) => fs.readFileSync(path.join(TEMPLATES_DIR, f)).toString("base64");

// --- probe / status -------------------------------------------------------------------

/** Onboarding state: flash Kuiper (hostname "analog") -> ad-r1m-system-* installed -> stack running. */
function classify(/** @type {Record<string,string>} */ p) {
  const containers = list(p.containers);
  if (!p.pkgs) return p.hostname === "analog" ? "fresh_kuiper" : "no_stack";
  return containers.some((c) => c.includes("robot") && !c.includes("zenoh")) ? "ready" : "stack_stopped";
}

function probeResult(/** @type {string} */ out) {
  const p = kv(sections(out).probe);
  return {
    state: classify(p),
    hostname: p.hostname,
    os: p.os,
    model: p.model,
    systemPackages: list(p.pkgs),
    cliVersion: p.cli || undefined,
    containers: list(p.containers),
    configDir: p.configdir || undefined,
    interfaces: list(p.ifaces),
  };
}

/** CANopen heartbeats: node -> last NMT state. drive_right 0x14, drive_left 0x16. */
function canBus(/** @type {string} */ text) {
  const nmt = { "00": "boot-up", "04": "stopped", "05": "operational", "7F": "pre-operational" };
  const last = new Map();
  for (const m of text.matchAll(/\bcan0 7([0-7][0-9A-Fa-f])#([0-9A-Fa-f]{2})/g)) {
    const id = parseInt(m[1], 16);
    if (id > 0) last.set(id, m[2].toUpperCase());
  }
  const nodes = [...last.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, s]) => ({ id: `0x${id.toString(16).padStart(2, "0")}`, state: /** @type {any} */ (nmt)[s] || `0x${s}` }));
  const can = kv(text).can || "unknown";
  const ids = nodes.map((n) => n.id);
  const issues = [];
  if (can !== "up") issues.push(`can0 is ${can}`);
  for (const [id, name] of [["0x14", "drive_right"], ["0x16", "drive_left"]]) if (!ids.includes(id)) issues.push(`${name} (${id}) sends no heartbeat`);
  if (ids.includes("0x17")) issues.push("a node is at 0x17, the ADRD3161 factory DIP setting");
  return { can, nodes, issues };
}

function driveResult(/** @type {Record<string,string>} */ s) {
  const controllers = lines(s.controllers).map((l) => {
    const c = l.split(/\s+/);
    return { name: c[0], state: c[c.length - 1] };
  });
  const active = (/** @type {string} */ n) => controllers.some((c) => c.name === n && c.state === "active");
  const publishers = Number(s.joint_states?.match(/Publisher count: (\d+)/)?.[1] || 0);
  const healthy = active("joint_state_broadcaster") && active("diff_drive_controller") && publishers > 0;
  const managerDown = /Could not contact service \/controller_manager/.test(s.drive_log || "");
  const detail = healthy
    ? `${controllers.filter((c) => c.state === "active").length} controllers active`
    : managerDown
      ? "controller_manager unreachable - spawners looping"
      : !controllers.length
        ? "no controllers loaded - a drive likely failed its CANopen boot"
        : !publishers
          ? "/joint_states has no publisher"
          : "controllers loaded but not active";
  // On a healthy robot the drive log lines are normal startup noise, so they are left out.
  return { healthy, detail, controllers, ...(healthy ? {} : { driveLog: lines(s.drive_log), ...(s.can ? { canBus: canBus(s.can) } : {}) }) };
}

/** ToF stamps vs robot clock (drive.sh tof_clock, COMMON_FIXES.md Issue 14). */
function clockResult(/** @type {Record<string,string>} */ s) {
  if (s.clock === undefined) return undefined;
  const c = kv(s.clock);
  const robotNtp = c.robot_ntp === "yes";
  if (!c.tof_offset_s) return { ok: null, robotNtp, detail: "no /cam1/camera_info message" };
  const offsetS = Number(c.tof_offset_s);
  if (Math.abs(offsetS) <= 2) return { ok: true, offsetS, robotNtp };
  const fix = `${robotNtp ? "" : "wait for the robot's NTP sync, then "}restart target=tof, then check drives`;
  return { ok: false, offsetS, robotNtp, detail: `ToF stamps are ${offsetS} s off the robot clock, so TF, SLAM and costmaps drop them: ${fix} (COMMON_FIXES.md Issue 14)` };
}

/** @param {{detail?: string}} a */
export async function robotStatus({ detail } = {}) {
  const out = await run(["drive", "status"], [detail === "full" ? "full" : "status"], { timeout: 90000 });
  const s = sections(out);
  const topics = lines(s.topics);
  const probe = probeResult(out);
  return {
    host: config.host,
    ...probe,
    rosContainer: kv(s.probe).ros_container,
    sensors: {
      tof: topics.some((t) => t.startsWith("/cam1/")),
      scan: topics.includes("/scan"),
      odometry: topics.includes("/odometry/filtered"),
    },
    topics,
    ...(s.controllers !== undefined ? { drives: driveResult(s) } : {}),
    tofClock: clockResult(s),
    ...(detail === "full"
      ? {
          services: kv(s.services),
          packages: lines(s.packages),
          upgradable: lines(s.upgradable),
          images: lines(s.images),
          network: lines(s.network),
          system: kv(s.system),
        }
      : {}),
  };
}

// --- connect ----------------------------------------------------------------------------

/** IPv4 for a name (incl. .local via nss-mdns), or null. @param {string} host */
async function resolveIPv4(host, ms = 4000) {
  if (net.isIPv4(host)) return host;
  return Promise.race([
    dns.promises.lookup(host, { family: 4 }).then((r) => r.address, () => null),
    sleep(ms).then(() => null),
  ]);
}

/** @param {string} ip @param {number} port */
const portOpen = (ip, port, ms = 1500) =>
  new Promise((resolve) => {
    const s = net.connect(port, ip);
    const done = (/** @type {boolean} */ v) => (s.destroy(), resolve(v));
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });

/** @param {import("./ssh.mjs").Target} t */
async function probe(t) {
  try {
    return { reachable: true, ...probeResult(await run("status", ["probe"], { target: t, timeout: 20000 })) };
  } catch (e) {
    const err = /** @type {SshError} */ (e);
    return { reachable: false, state: err.kind === "auth_failed" ? "ssh_auth_failed" : "unreachable", error: err.message };
  }
}

/** Bare names ("analog", "ad-r1m-42") are tried as <name>.local first (mDNS), then as is. */
export async function connectRobot(/** @type {{host: string, password: string, user?: string}} */ a) {
  if (!a.host || !a.password) throw new Error(`host and password are required. ${NO_ROBOT_HINT}`);
  const h = a.host.trim().replace(/\.$/, "");
  let host = h.includes(".") || net.isIPv4(h) ? h : `${h}.local`;
  if (!h.includes(".")) for (const c of [`${h}.local`, h]) if (await resolveIPv4(c)) { host = c; break; }
  const t = { host, user: a.user || config.user, password: a.password };
  const p = await probe(t);
  if (p.reachable) selectRobot(t);
  return { connected: p.reachable, host, ...p, ...(p.reachable ? {} : { selectedRobot: config.host || null }) };
}

// --- small tools ------------------------------------------------------------------------------

/** @param {{kind: string, name?: string, filter?: string, lines?: number, target?: string, path?: string}} a */
export async function ros2Query(a) {
  const args = {
    topics: [],
    nodes: [],
    topic_info: [a.name],
    params: [a.name],
    logs: [a.name, String(a.lines || 50)],
    read_file: [a.target === "host" ? "host" : "slam", a.path],
  }[a.kind];
  if (!args) throw new Error("kind must be topics, nodes, topic_info, params, logs or read_file");
  if (args.some((x) => !x)) throw new Error(`kind=${a.kind} needs ${a.kind === "read_file" ? "path" : "name"}`);
  let out = await run("query", [a.kind === "read_file" ? "read" : a.kind, .../** @type {string[]} */ (args)], { timeout: 45000 });
  if (a.filter && (a.kind === "topics" || a.kind === "nodes")) {
    const re = new RegExp(a.filter, "i");
    out = out.split("\n").filter((l) => re.test(l)).join("\n");
  }
  return out;
}

/** @param {{params: Record<string, string|number|boolean>}} a */
export async function slamSetParams(a) {
  const entries = Object.entries(a.params || {});
  if (!entries.length) throw new Error("params is required, e.g. {\"Rtabmap/DetectionRate\": \"0.5\"}");
  const out = await run("params", entries.flatMap(([k, v]) => [k, String(v)]), { timeout: 20000 * entries.length });
  return entries.map(([param, value]) => {
    const line = out.split("\n").find((l) => l.split(" ")[1] === param);
    return { param, value: String(value), ok: line?.startsWith("ok ") ?? false, ...(line?.startsWith("fail ") ? { error: line.slice(6 + param.length) } : line ? {} : { error: "no reply" }) };
  });
}

/** @param {{action: string, folder?: string, restart?: boolean}} a */
export async function robotConfig(a) {
  if (a.action === "active" || a.action === "list") {
    const s = sections(await run("config", [a.action]));
    return { ...kv(s._), ...(s.folders !== undefined ? { folders: lines(s.folders) } : {}) };
  }
  if (!a.folder) throw new Error("folder is required");
  if (a.action === "mkconfig") return { output: await run("config", ["mkconfig", a.folder]) };
  if (a.action !== "enable") throw new Error("action must be list, active, mkconfig or enable");
  const r = kv(await run("config", ["resolve", a.folder]));
  if (r.config !== "yes") throw new Error(`${r.path} is not an AD-R1M config folder (no ad-r1m.env). Create it with action=mkconfig.`);
  const output = await run("config", ["enable", r.path, a.restart ? "1" : "0"], { root: true, timeout: a.restart ? 180000 : 30000 });
  return { enabled: r.path, restarted: !!a.restart, output };
}

/** @param {{target?: string}} a */
export async function restart(a) {
  const target = a.target || "stack";
  if (!["stack", "slcan", "crsf", "imu", "tof"].includes(target)) throw new Error("target must be stack, slcan, crsf, imu or tof");
  const out = await run(["drive", "restart"], [target], { root: true, timeout: 300000 });
  const s = sections(out);
  return {
    target,
    ...kv(s._),
    ...(s.unit !== undefined ? { unit: s.unit } : {}),
    ...kv(s.result),
    ...(s.can !== undefined ? { canBus: canBus(s.can) } : {}),
    tofClock: clockResult(s),
    ...(s.crsf !== undefined ? kv(s.crsf) : {}),
    ...(s.containers !== undefined ? { containers: lines(s.containers) } : {}),
    ...(s._ && target === "stack" ? { output: s._ } : {}),
  };
}

// --- SLAM / Nav2 ------------------------------------------------------------------------------

/**
 * Tested RTAB-Map templates for the ADTF3175D (skills/ad-r1m-robot/templates), deployed as
 * launch.py. depth_rgb is the default; depth_pointcloud adds the ToF cloud for ICP. Both feed
 * the camera data unflipped: the optical-frame TF already models the inverted mount.
 */
export const SLAM_TEMPLATES = {
  depth_rgb: { launch: "rtabmap_depth_rgb_launch.py", helpers: ["image_preprocess.py"] },
  depth_pointcloud: { launch: "rtabmap_depth_pointcloud_launch.py", helpers: ["image_preprocess.py", "cloud_preprocess.py"] },
};

/** @param {string} name */
function templatePairs(name) {
  const t = /** @type {any} */ (SLAM_TEMPLATES)[name];
  if (!t) throw new Error(`template must be one of ${Object.keys(SLAM_TEMPLATES).join(", ")}, or "deployed"`);
  return ["launch/launch.py", b64file(t.launch), ...t.helpers.flatMap((/** @type {string} */ f) => [`launch/${f}`, b64file(f)])];
}

/** @param {{launch_file?: string, filename?: string, helpers?: Record<string,string>, params_yaml?: string}} a */
function customPairs(a) {
  if (!a.launch_file) throw new Error("deploy needs launch_file (or a template)");
  const b = (/** @type {string} */ s) => Buffer.from(s).toString("base64");
  const name = path.basename(a.filename || "launch.py");
  return [
    `launch/${name}`, b(a.launch_file),
    ...Object.entries(a.helpers || {}).flatMap(([f, c]) => [`launch/${path.basename(f)}`, b(c)]),
    ...(a.params_yaml ? ["config/params.yaml", b(a.params_yaml)] : []),
  ];
}

/** @param {{action: string, template?: string, launch_file?: string, filename?: string, helpers?: Record<string,string>, params_yaml?: string}} a */
export async function slam(a) {
  const action = a.action;
  if (!["start", "stop", "deploy"].includes(action)) throw new Error("action must be start, stop or deploy");
  const pairs =
    action === "stop" ? [] : action === "deploy" ? (a.launch_file ? customPairs(a) : templatePairs(a.template || "depth_rgb")) : a.template === "deployed" ? [] : templatePairs(a.template || "depth_rgb");
  const out = await run("slam", [action, ...pairs], { timeout: 180000 });
  const s = sections(out);
  if (/container=missing/.test(out)) throw new Error(`Container ${config.slamContainer} not found. Run setup_workspace first.`);
  if (/launch=missing/.test(out)) throw new Error("slam_integration has no launch.py. Deploy one first (slam action=deploy, or start with a template).");
  const deploy = s.deploy !== undefined ? { deployed: /build_exit=0/.test(s.deploy), deployOutput: s.deploy } : {};
  if (action === "deploy" || action === "stop") return { action, ...deploy, ...(action === "stop" ? { stopped: true } : {}) };
  const pid = s.launch?.trim();
  return {
    action,
    ...deploy,
    // The launch process is the signal, not the node count.
    started: !!pid && pid !== "none",
    nodes: lines(s.nodes),
    inputTopics: lines(s.topics),
    ...(s.log ? { logTail: s.log } : {}),
    log: "/tmp/slam.log in the SLAM container",
  };
}

/** Nav2 on the ToF point cloud: these files go to the config folder's ros_data. */
const NAV_POINTCLOUD_FILES = ["nav_cloud_filter.py", "nav_pointcloud_launch.py", "navigation_params_pointcloud.yaml"];

/** @param {{action: string}} a */
export async function nav(a) {
  if (!["start", "stop", "start_pointcloud"].includes(a.action)) throw new Error("action must be start, stop or start_pointcloud");
  const pairs = a.action === "start_pointcloud" ? NAV_POINTCLOUD_FILES.flatMap((f) => [f, b64file(f)]) : [];
  const s = sections(await run("nav", [a.action, ...pairs], { timeout: 120000 }));
  return { action: a.action, output: s._, containers: lines(s.containers) };
}

/** @param {{target?: string}} a */
export async function diagnostics(a) {
  const target = a.target === "nav" ? "nav" : "slam";
  const out = await run(["drive", "diag"], [target], { timeout: 90000 });
  const s = sections(out);
  const num = (/** @type {Record<string,string>} */ o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v) || 0]));
  if (target === "nav") return { target, lifecycle: kv(s.lifecycle), publishers: num(kv(s.publishers)) };
  return {
    target,
    slamNodes: lines(s.nodes),
    publishers: num(kv(s.publishers)),
    hz: num(kv(s.hz)),
    tf: kv(s.tf),
    drives: driveResult(s),
    tofClock: clockResult(s),
    rtabmap: s.rtabmap || "SLAM container not running",
  };
}

/**
 * Extra ROS packages a tested launch file starts, installed with the SLAM package.
 * mola: octomap_server builds the 2D /map that MOLA-LO does not publish.
 */
const SLAM_EXTRA_DEPS = { mola_lidar_odometry: ["octomap_server"] };

/** @param {{package?: string, repo?: string}} a */
export async function setupWorkspace(a) {
  const pkg = a.package || "rtabmap_ros";
  const extra = /** @type {any} */ (SLAM_EXTRA_DEPS)[pkg] || [];
  const out = await run("workspace", [pkg, a.repo || "", slamImage(), config.dockerImage, config.rmw, extra.join(" ")], { timeout: 1800000 });
  const s = sections(out);
  const img = kv(s.image);
  if (img.stock_image === "missing") {
    throw new Error(
      `The robot image ${config.dockerImage} is not on the robot. Pull it with provision_robot docker_image=true ` +
        "(Cloudsmith credentials), or build it on the robot with build_robot_image (no credentials needed), then retry."
    );
  }
  const r = { ...kv(s.rosdep), ...kv(s.clone), ...kv(s.build), ...kv(s.result) };
  const all = (/** @type {string} */ key) => [...out.matchAll(new RegExp(`^${key}=(\\S+)`, "gm"))].map((m) => m[1]);
  return {
    package: pkg,
    ready: r.package === "installed",
    container: config.slamContainer,
    image: img.image,
    containerState: img.container,
    committedImage: kv(s.result).committed || out.match(/^committed=(\S+)/m)?.[1],
    unresolvedKeys: all("unresolved"),
    resolvedViaApt: all("resolved_via_apt"),
    ...(r.installed_via_apt ? { installedViaApt: r.installed_via_apt } : {}),
    ...(s.build !== undefined ? { built: all("built"), notBuilt: all("not_built"), buildLog: s.build.slice(-3000) } : {}),
    ...(r.rosdep_unavailable ? { rosdep: "unavailable on this image" } : {}),
    ...(r.skipped ? { skipped: r.skipped } : {}),
  };
}

/** @param {{output_dir?: string}} a */
export async function supportBundle(a) {
  const t = selectedTarget();
  const remote = kv(await run("bundle", [], { timeout: 180000 })).bundle;
  if (!remote) throw new Error("Bundle creation failed on the robot");
  const dir = a.output_dir || os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  const local = path.join(dir, `${path.basename(remote, ".tar.gz")}-${t.host.replace(/[^\w.-]/g, "_")}.tar.gz`);
  const fd = fs.openSync(local, "w");
  try {
    await ssh(t, `cat ${shq(remote)} && rm -f ${shq(remote)}`, { timeout: 120000, stdout: fd });
  } finally {
    fs.closeSync(fd);
  }
  const contents = (spawnSync("tar", ["tzf", local], { encoding: "utf-8" }).stdout || "").split("\n").filter((l) => l && !l.endsWith("/"));
  return { path: local, bytes: fs.statSync(local).size, contents };
}

// --- provision_robot ------------------------------------------------------------------------

/** Poll hosts until one answers the probe over SSH. @param {import("./ssh.mjs").Target} t @param {string[]} hosts */
async function waitForRobot(t, hosts, ms) {
  const deadline = Date.now() + ms;
  await sleep(15000); // let it actually go down first
  while (Date.now() < deadline) {
    for (const host of hosts) {
      const ip = await resolveIPv4(host, 3000);
      if (!ip || !(await portOpen(ip, 22))) continue;
      const p = await probe({ ...t, host });
      if (p.reachable) return { host, ...p };
    }
    await sleep(5000);
  }
  return null;
}

/**
 * First-time setup of a Kuiper image into an AD-R1M (setup-rpi.rst). Steps run in order and
 * stop at the first failure; all talk to the robot's IP, since a hostname change drops the
 * old .local name. Defaults to a dry run that only reports the plan.
 * @param {any} o
 */
export async function provisionRobot(o) {
  const dryRun = o.dry_run !== false;
  const origHost = o.host || config.host;
  if (!origHost) throw new SshError("no_robot_selected", "", `No robot selected. ${NO_ROBOT_HINT}`);
  if (o.hostname && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(o.hostname)) throw new Error(`Invalid hostname "${o.hostname}" - letters, digits and '-' only (e.g. ad-r1m-42)`);
  const pkg = o.system_package || "ad-r1m-system-rpi5";
  if (!/^ad-r1m-system-[a-z0-9-]+$/.test(pkg)) throw new Error(`Invalid system package "${pkg}"`);
  if (o.wifi && !o.wifi.ssid) throw new Error("wifi.ssid is required");
  const ref = o.config_ref || "main";
  // Cloudsmith credentials: argument, else the server's environment. Never echoed.
  const cs = o.cloudsmith?.user && o.cloudsmith?.token ? o.cloudsmith
    : process.env.CLOUDSMITH_USER && process.env.CLOUDSMITH_TOKEN ? { user: process.env.CLOUDSMITH_USER, token: process.env.CLOUDSMITH_TOKEN } : null;
  if ((o.install_system_package || o.docker_image) && !cs) {
    throw new Error(
      "Cloudsmith credentials are needed for the AD-R1M apt repo and docker registry: ask the user for the Cloudsmith " +
        "service user and token and pass cloudsmith={user, token}, or set CLOUDSMITH_USER/CLOUDSMITH_TOKEN for the MCP server. " +
        "Without credentials, run the other steps here and build both on the robot with build_robot_image system_package=true."
    );
  }
  const ip = (await resolveIPv4(origHost)) || origHost;
  const t = { host: ip, user: config.user, password: config.password };

  /** @type {{step: string, description: string, ok?: boolean, output?: string}[]} */
  const steps = [];
  const add = (/** @type {string} */ step, /** @type {string} */ description) => steps.push({ step, description });
  if (o.wifi) add("wifi", `Join Wi-Fi "${o.wifi.ssid}" with nmcli (password ${o.wifi.password ? "provided, sent over stdin" : "none"}). May drop the connection if the robot is reached over Wi-Fi.`);
  if (o.hostname) add("hostname", `Set hostname to "${o.hostname}" (hostnamectl + /etc/hosts), restart avahi.`);
  if (o.upgrade) add("upgrade", "apt-get update && apt-get upgrade -y (needs internet; can take 10+ minutes on a fresh image).");
  if (o.install_system_package) {
    add("cloudsmith_apt", "Add the AD-R1M Cloudsmith apt repository (credentials over stdin).");
    add("install", `apt-get install -y ${pkg} (needs internet; several minutes).`);
  }
  if (o.docker_image) add("docker", `Add ${t.user} to the docker group, clear a stuck docker daemon (docker system prune -a removes ALL existing images), docker login docker.cloudsmith.io (root and ${t.user}), docker pull ${config.dockerImage} (~10 GB).`);
  if (o.demo_config) {
    add("demo_config", `ad-r1m mkconfig ~/demo, clone ad-r1m-ros2 and check out ${ref}, copy its default-config into ~/demo (replaced files kept as *.bak). Warns if the robot image comes from a different ref.`);
    add("enable_config", `ad-r1m enable ~/demo (sudo)${o.reboot ? "; applied by the reboot" : ", then restart ad-r1m-bringup (restarts the ROS containers)"}.`);
  }
  if (o.reboot) add("reboot", "Reboot and wait up to 4 minutes for SSH to come back.");
  if (!steps.length) throw new Error("Nothing to do - pass hostname, wifi, upgrade, install_system_package, docker_image, demo_config and/or reboot");
  if (dryRun) return { dryRun, target: `${origHost} (${ip})`, steps, nextStep: "Confirm these steps with the user, then call provision_robot again with dry_run=false." };

  const minutes = (/** @type {number} */ m) => m * 60000;
  const root = (/** @type {string[]} */ args, /** @type {number} */ timeout, secrets = /** @type {string[]} */ ([])) => run("provision", args, { target: t, root: true, timeout, secrets });
  const user = (/** @type {string[]} */ args, /** @type {number} */ timeout, secrets = /** @type {string[]} */ ([])) => run("provision", args, { target: t, timeout, secrets });
  const warnings = [];
  for (const s of steps) {
    try {
      if (s.step === "wifi") s.output = await root(["wifi"], 60000, [o.wifi.ssid, o.wifi.password || ""]);
      else if (s.step === "hostname") s.output = await root(["hostname", o.hostname], 30000);
      else if (s.step === "upgrade") s.output = await root(["upgrade"], minutes(45));
      else if (s.step === "cloudsmith_apt") s.output = await root(["cloudsmith_apt"], minutes(5), [cs.user, cs.token]);
      else if (s.step === "install") s.output = await root(["install", pkg], minutes(20));
      else if (s.step === "docker") {
        s.output = await root(["docker", config.dockerImage, t.user], minutes(60), [cs.user, cs.token]);
        s.output += `\n${t.user}: ` + (await user(["user_docker_login"], 60000, [cs.user, cs.token]));
        if (!/Login Succeeded/.test(s.output)) throw new Error(`docker login failed:\n${s.output}`);
      } else if (s.step === "demo_config") {
        s.output = await user(["demo_config", ref], minutes(10));
        const cfg = s.output.match(/^CONFIG_REF=(\S+)/m)?.[1];
        const img = s.output.match(/^IMAGE_REF=(\S+)/m)?.[1];
        // A newer config on an older image breaks things, e.g. main's compose.yaml passes
        // namespace:=/ to the 1.0.0 scan launch file: frame //cam1_scan, RViz drops every scan.
        if (cfg && img && img !== cfg) warnings.push(`~/demo is from ad-r1m-ros2 ${cfg} but the robot image was built from ${img}. Rebuild the image (build_robot_image ref=${cfg}) or recreate the config (config_ref=${img}).`);
        if (cfg && !img) warnings.push(`~/demo is from ad-r1m-ros2 ${cfg}. A Cloudsmith robot image is built from the latest release tag; if they differ, build the image from the same ref or pass config_ref=<release>.`);
      } else if (s.step === "enable_config") {
        const demo = steps.find((x) => x.step === "demo_config")?.output?.match(/^DEMO=(\S+)/m)?.[1];
        if (!demo) throw new Error("demo_config did not report the ~/demo path");
        s.output = await root(["enable_config", demo, o.reboot ? "0" : "1"], 180000);
        const active = (await user(["active_config"], 30000)).trim();
        s.output = `${s.output}\nactive config: ${active}`.trim();
        if (active !== demo) throw new Error(`ad-r1m enable did not switch to ${demo} (active: ${active}):\n${s.output}`);
      } else if (s.step === "reboot") {
        // The link can drop before SSH exits cleanly; that still means it is rebooting.
        s.output = await root(["reboot"], 20000).catch((e) => {
          if (/unreachable|255|timed out/.test(e.message)) return "rebooting";
          throw e;
        });
      }
      s.ok = true;
    } catch (e) {
      s.ok = false;
      s.output = /** @type {Error} */ (e).message;
      break;
    }
  }

  const failed = steps.find((s) => s.ok === false);
  const newName = o.hostname ? `${o.hostname}.local` : null;
  const back = !failed && o.reboot ? await waitForRobot(t, [...(newName ? [newName] : []), ip, origHost], 240000) : { host: ip, ...(await probe(t)) };
  if (back?.reachable) selectRobot({ host: newName && (await resolveIPv4(newName)) ? newName : back.host });
  return {
    dryRun,
    target: `${origHost} (${ip})`,
    steps,
    ...(warnings.length ? { warnings } : {}),
    robot: back || `did not come back within 4 minutes${newName ? ` (it should now be ${newName})` : ""}`,
    ...(failed ? { failedStep: failed.step } : {}),
  };
}
