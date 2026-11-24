// @ts-check
// build_robot_image: build the robot image on the robot when it cannot be pulled (no
// Cloudsmith credentials). Background job; action=status reports progress.
import { config, kv, run, sections, selectedTarget } from "./ssh.mjs";

/** Free space below this on the docker data disk makes the build likely to fail. */
const MIN_FREE_GB = 15;
const EXIT_REASONS = {
  10: "git clone failed (no internet on the robot, or the ref does not exist)",
  20: "building the system package failed",
  21: "the system package .deb was not produced",
  30: "docker build failed - often disk space or the network (Docker Hub, apt, GitHub); see tail",
  143: "the build was stopped",
};

/** @param {string} image */
async function status(image) {
  const s = sections(await run("image", ["status", image], { timeout: 60000 }));
  const k = kv(s._);
  const running = k.running === "1";
  const exit = !running && k.exit !== undefined ? Number(k.exit) : undefined;
  return {
    running,
    ...(exit !== undefined ? { exitCode: exit, ...(exit ? { reason: /** @type {any} */ (EXIT_REASONS)[exit] || "see tail" } : {}) } : {}),
    ref: k.ref,
    image,
    imagePresent: !!k.image_created,
    imageCreated: k.image_created,
    step: k.step || undefined,
    elapsedMin: k.elapsed_min ? Number(k.elapsed_min) : undefined,
    systemPackageDeb: k.deb,
    freeGB: k.free_gb ? Number(k.free_gb) : null,
    log: k.log,
    tail: (s.tail || "").split("\n").filter(Boolean),
  };
}

/** @param {{action?: string, ref?: string, image?: string, target?: string, system_package?: boolean, install_prerequisites?: boolean, dry_run?: boolean}} a */
export async function buildRobotImage(a) {
  const image = a.image || config.dockerImage;
  const action = a.action || "status";
  if (action === "status") return status(image);
  if (action === "stop") return { result: await run("image", ["stop"]), status: await status(image) };

  if (action === "install_system_package") {
    const s = await status(image);
    if (!s.systemPackageDeb) throw new Error("No built ad-r1m-system-rpi5 .deb on the robot - run action=start with system_package=true first.");
    if (a.dry_run !== false) {
      return {
        dryRun: true,
        deb: s.systemPackageDeb,
        effect: "apt-get install of the locally built package: installs the AD-R1M systemd services, compose config and ad-r1m CLI, and edits the boot config.txt (dtoverlays, UART0) - reboot afterwards.",
        nextStep: "Confirm with the user, then call with dry_run=false, then reboot (provision_robot reboot=true).",
      };
    }
    const output = await run("image", ["install_deb", s.systemPackageDeb], { root: true, timeout: 15 * 60000 });
    return { installed: !/^E: /m.test(output), output };
  }
  if (action !== "start") throw new Error(`Unknown action "${action}" - use status, start, stop or install_system_package`);

  const target = a.target || "runner";
  const sys = !!a.system_package;
  const current = await status(image);
  if (current.running) return { started: false, reason: "A build is already running", status: current };

  const t = selectedTarget();
  const p = kv(await run("image", ["preflight", image], { timeout: 60000 }));
  const ref = a.ref || p.latest;
  if (!ref) throw new Error("Could not read the latest ad-r1m-ros2 release tag from the robot (no internet?). Pass ref explicitly, e.g. ref=1.0.0.");
  const apt = [];
  if (p.git !== "1") apt.push("git");
  if (p.docker_pkg === "none") apt.push("docker.io", "docker-compose", "docker-buildx");
  else if (p.buildx !== "1") apt.push(p.docker_pkg === "docker-ce" ? "docker-buildx-plugin" : "docker-buildx");
  if (sys && p.deb_tools !== "1") apt.push("build-essential", "devscripts", "debhelper");
  const freeGB = p.free_gb ? Number(p.free_gb) : null;
  const warnings = [
    ...(p.arch && p.arch !== "aarch64" ? [`Robot architecture is ${p.arch}, not aarch64 - the image will be built for ${p.arch}.`] : []),
    ...(freeGB !== null && freeGB < MIN_FREE_GB ? [`Only ${freeGB} GB free for Docker - the build needs about ${MIN_FREE_GB} GB.`] : []),
    ...(p.image === "1" ? [`${image} already exists on the robot - building replaces it with the local build.`] : []),
  ];
  const plan = {
    ref,
    image,
    target,
    systemPackage: sys,
    preflight: p,
    steps: [
      ...(apt.length ? [`sudo apt-get install ${apt.join(" ")}`] : []),
      ...(p.access !== "1" ? [`add ${t.user} to the docker group`] : []),
      `git clone --depth 1 --branch ${ref} https://github.com/analogdevicesinc/ad-r1m-ros2.git`,
      ...(sys ? ["packaging/build_debian.sh -1 (unsigned, lintian off) -> ad-r1m-system-rpi5_*_all.deb"] : []),
      `docker build -f docker/Dockerfile --target ${target} --build-arg BUILDKIT_SYNTAX=docker/dockerfile:1 --build-arg ROS_DISTRO=${config.rosDistro} --build-arg BUILD_PACKAGES=ad_r1m_robot -t ${image} .`,
    ],
    estimate: "About 10-30 minutes on a Raspberry Pi 5 (release 1.0.0 took 9 min); needs internet (GitHub, Docker Hub, Ubuntu/ROS apt).",
    warnings,
  };
  if (a.dry_run !== false) return { dryRun: true, ...plan, nextStep: "Show the plan to the user and get confirmation, then call with dry_run=false." };

  if ((apt.length || p.access !== "1") && !a.install_prerequisites) {
    throw new Error(
      `The robot needs ${[...apt, ...(p.access !== "1" ? ["docker group membership"] : [])].join(", ")} first. ` +
        "Confirm with the user, then call again with install_prerequisites=true (uses sudo on the robot)."
    );
  }
  if (apt.length || p.access !== "1") await run("image", ["prereq", t.user, ...apt], { root: true, timeout: 20 * 60000 });
  await run("image", ["start", ref, image, config.rosDistro, target, sys ? "1" : "0"], { timeout: 60000 });
  return { started: true, ...plan, status: await status(image), nextStep: "Poll action=status every few minutes (about 10-30 min)." };
}
