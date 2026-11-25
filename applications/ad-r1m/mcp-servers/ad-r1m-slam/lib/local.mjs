// @ts-check
// Tools that run on the user's PC, not on the robot: kuiper_sd_card and rviz.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, NO_ROBOT_HINT, SERVER_DIR, TEMPLATES_DIR } from "./ssh.mjs";

const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ad-r1m-slam");
const IS_WINDOWS = process.platform === "win32";
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const tailOf = (/** @type {string} */ f, n = 6) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").replace(/\r/g, "\n").trim().split("\n").slice(-n) : []);

// --- background jobs: log, pid and exit-code files, so state survives a server restart --------

/** @param {string} dir @param {string} name */
function jobState(dir, name) {
  const f = (/** @type {string} */ ext) => path.join(dir, `${name}.${ext}`);
  let running = false;
  try {
    process.kill(Number(fs.readFileSync(f("pid"), "utf8")), 0);
    running = true;
  } catch {
    // no pid file, or the process is gone
  }
  const code = fs.existsSync(f("exit")) ? Number(fs.readFileSync(f("exit"), "utf8")) : undefined;
  return { running, exitCode: running ? undefined : code, log: f("log"), tail: tailOf(f("log")) };
}

/** Run `command args` detached; its exit code lands in <name>.exit. @param {string} dir @param {string} name @param {string} command @param {string[]} args */
function startJob(dir, name, command, args) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (/** @type {string} */ ext) => path.join(dir, `${name}.${ext}`);
  for (const ext of ["log", "exit", "pid"]) fs.rmSync(f(ext), { force: true });
  const log = fs.openSync(f("log"), "a");
  // A tiny wrapper writes the exit code even if this server is gone by then.
  const child = spawn("bash", ["-c", '"$@"; echo $? > "$0"', f("exit"), command, ...args], { detached: true, stdio: ["ignore", log, log] });
  fs.writeFileSync(f("pid"), String(child.pid));
  child.unref();
}

// --- kuiper_sd_card ---------------------------------------------------------------------------

const KUIPER_URL = process.env.KUIPER_IMAGE_URL || "https://packages.analog.com/public/raw/files/kuiper_full_64_image_2026.1.1.zip";
const KUIPER_DIR = path.join(CACHE, "kuiper");
const SYSTEM_MOUNTS = new Set(["/", "/boot", "/boot/efi", "/home", "/usr", "/var", "[SWAP]"]);
const ASK_WIFI =
  "Ask the user for the Wi-Fi network (SSID) and password the robot should join (no default - do not assume a network " +
  "used before), then call action=add_wifi with device and wifi={ssid, password}; without it the robot is only reachable " +
  "over Ethernet. Then: card into the robot, power up, wait ~2 min, ping analog.local and connect_robot (analog / analog).";

/** Removable or hot-plug disks up to 512 GB that hold none of this PC's system mounts. */
function sdDevices() {
  const out = execFileSync("lsblk", ["-J", "-b", "-o", "NAME,PATH,SIZE,TYPE,TRAN,RM,HOTPLUG,MODEL,LABEL,MOUNTPOINTS"], { encoding: "utf-8" });
  const mountsOf = (/** @type {any} */ n) => [...(n.mountpoints || []).filter(Boolean), ...(n.children || []).flatMap(mountsOf)];
  const yes = (/** @type {any} */ v) => v === true || v === "1";
  return (JSON.parse(out).blockdevices || [])
    .filter((/** @type {any} */ d) => d.type === "disk" && (yes(d.rm) || yes(d.hotplug)) && !mountsOf(d).some((m) => SYSTEM_MOUNTS.has(m)) && Number(d.size) > 0 && Number(d.size) <= 512e9)
    .map((/** @type {any} */ d) => {
      const parts = (d.children || []).map((/** @type {any} */ c) => ({ name: c.path, mountpoints: (c.mountpoints || []).filter(Boolean), label: c.label || undefined }));
      let contents;
      for (const m of parts.flatMap((/** @type {any} */ p) => p.mountpoints)) {
        try {
          const host = fs.readFileSync(path.join(m, "etc/hostname"), "utf8").trim();
          const osr = fs.readFileSync(path.join(m, "etc/os-release"), "utf8").match(/PRETTY_NAME="([^"]+)"/)?.[1];
          contents = `system disk of "${host}" (${osr || "unknown OS"})`;
          break;
        } catch {
          // not a root partition
        }
      }
      if (!contents && parts.length) contents = `${parts.length} partition(s): ${parts.map((/** @type {any} */ p) => p.label || p.name).join(", ")}`;
      return { device: d.path, sizeGB: Math.round(Number(d.size) / 1e8) / 10, model: (d.model || "").trim(), transport: d.tran || (String(d.path).includes("mmcblk") ? "sd" : ""), partitions: parts, contents: contents || "empty / unpartitioned" };
    });
}

/** @param {string} url */
async function remoteSize(url) {
  try {
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
    const n = Number(r.headers.get("content-length"));
    return r.ok && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** The .img inside the zip, or a nested .zip that holds it. @param {string} zip */
function zipEntry(zip) {
  const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf-8" }).split("\n").filter(Boolean);
  const img = entries.find((e) => /\.img$/i.test(e));
  if (img) return { entry: img, nested: false };
  const inner = entries.find((e) => /\.zip$/i.test(e));
  if (inner) return { entry: inner, nested: true };
  throw new Error(`No .img or nested .zip in ${zip}: ${entries.join(", ")}`);
}

/** NetworkManager keyfile (0600) so the flashed robot joins Wi-Fi on first boot. @param {{ssid: string, password?: string}} w */
function wifiProfile(w) {
  const esc = (/** @type {string} */ v) => v.replace(/\\/g, "\\\\").replace(/\n/g, "");
  const file = path.join(KUIPER_DIR, `wifi-${process.pid}-${Date.now()}.nmconnection`);
  fs.mkdirSync(KUIPER_DIR, { recursive: true });
  fs.writeFileSync(
    file,
    [
      "[connection]", `id=${esc(w.ssid)}`, `uuid=${crypto.randomUUID()}`, "type=wifi", "autoconnect=true", "autoconnect-priority=10", "",
      "[wifi]", "mode=infrastructure", `ssid=${esc(w.ssid)}`, "",
      ...(w.password ? ["[wifi-security]", "key-mgmt=wpa-psk", `psk=${esc(w.password)}`, ""] : []),
      "[ipv4]", "method=auto", "", "[ipv6]", "addr-gen-mode=default", "method=auto", "",
    ].join("\n"),
    { mode: 0o600 }
  );
  return [file, `${w.ssid.replace(/[^\w.-]/g, "_")}.nmconnection`];
}

const SD_SCRIPT = path.join(SERVER_DIR, "scripts", "pc-sd.sh");
const passwordlessSudo = () => spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0;

/** @param {{action: string, url?: string, dir?: string, device?: string, dry_run?: boolean, wifi?: {ssid: string, password?: string}}} a */
export async function kuiperSdCard(a) {
  const url = a.url || KUIPER_URL;
  const dir = a.dir || path.join(os.homedir(), "Downloads");
  const zip = path.join(dir, path.basename(new URL(url).pathname));
  const local = fs.existsSync(zip) ? fs.statSync(zip).size : 0;
  const device = () => {
    if (!a.device) throw new Error("device is required, e.g. /dev/mmcblk0 - see action=list_devices");
    const d = sdDevices().find((x) => x.device === a.device);
    if (!d) throw new Error(`${a.device} is not a removable disk without system mounts - refusing. Candidates: ${sdDevices().map((x) => x.device).join(", ") || "none"}`);
    return d;
  };

  switch (a.action) {
    case "status": {
      const remote = await remoteSize(url);
      const flash = jobState(KUIPER_DIR, "flash");
      return {
        url, zip, localBytes: local, remoteBytes: remote, complete: !!local && local === remote,
        download: jobState(KUIPER_DIR, "download"), flash, devices: sdDevices(),
        ...(flash.exitCode === 0 && !flash.tail.some((l) => /Wi-Fi profile .* added/.test(l)) ? { nextStep: `Flash done. ${ASK_WIFI}` } : {}),
      };
    }
    case "download": {
      if (jobState(KUIPER_DIR, "download").running) return { started: false, reason: "A download is already running" };
      const remote = await remoteSize(url);
      if (local && remote && local === remote) return { started: false, reason: "Already downloaded", zip, bytes: local };
      fs.mkdirSync(dir, { recursive: true });
      // -C - resumes a partial file; status compares the size with the server's.
      startJob(KUIPER_DIR, "download", "curl", ["-fL", "-C", "-", "--retry", "5", "--progress-bar", "-o", zip, url]);
      return { started: true, zip, remoteBytes: remote, nextStep: "Poll action=status for progress (2.3 GB)." };
    }
    case "list_devices":
      return { devices: sdDevices(), note: "Only removable/hot-plug disks without this PC's system mounts are listed." };
    case "flash": {
      const dev = device();
      const remote = await remoteSize(url);
      if (!local || (remote && local !== remote)) throw new Error(`Image not fully downloaded (${local} of ${remote ?? "?"} bytes) - run action=download first`);
      if (jobState(KUIPER_DIR, "flash").running) throw new Error("A flash job is already running - see action=status");
      const { entry, nested } = zipEntry(zip);
      const plan = {
        device: dev.device, sizeGB: dev.sizeGB, model: dev.model, erases: dev.contents, image: `${path.basename(zip)} -> ${entry}`,
        steps: ["unmount the card's partitions", `unzip -p | sudo dd of=${dev.device} bs=4M conv=fsync`, "sync and verify the first 64 MiB",
          ...(a.wifi?.ssid ? [`add a NetworkManager profile for Wi-Fi "${a.wifi.ssid}" (autoconnect) to the card's rootfs`] : [])],
      };
      if (a.dry_run !== false) return { dryRun: true, ...plan, nextStep: `Tell the user ${dev.device} (${dev.contents}) will be ERASED and get explicit confirmation, then call with dry_run=false.` };
      if (!passwordlessSudo()) {
        throw new Error(`Flashing needs passwordless sudo for dd. Ask the user to run it themselves: ! unzip -p ${zip} ${entry} | sudo dd of=${dev.device} bs=4M conv=fsync status=progress`);
      }
      startJob(KUIPER_DIR, "flash", "bash", [SD_SCRIPT, "flash", zip, entry, nested ? "1" : "0", KUIPER_DIR, dev.device, ...(a.wifi?.ssid ? wifiProfile(a.wifi) : [])]);
      return { started: true, ...plan, nextStep: `Poll action=status for dd progress (8 GB, a few minutes).${a.wifi?.ssid ? "" : ` When done: ${ASK_WIFI}`}` };
    }
    case "add_wifi": {
      // Not destructive, so no dry run.
      if (!a.wifi?.ssid) throw new Error(`wifi={ssid, password} is required. ${ASK_WIFI}`);
      const dev = device();
      if (jobState(KUIPER_DIR, "flash").running) throw new Error("A flash job is still running - wait for it to finish");
      if (!passwordlessSudo()) throw new Error("Writing to the card's rootfs needs passwordless sudo");
      const r = spawnSync("bash", [SD_SCRIPT, "wifi", dev.device, ...wifiProfile(a.wifi)], { encoding: "utf-8", timeout: 60000 });
      const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
      return { added: /Wi-Fi profile .* added/.test(out), device: dev.device, ssid: a.wifi.ssid, output: out };
    }
    default:
      throw new Error("action must be status, download, list_devices, flash or add_wifi");
  }
}

// --- rviz -------------------------------------------------------------------------------------
// RViz runs on this PC and joins the robot's Zenoh router (tcp/<robot>:7447) as a client.
// pixi (recommended by the AD-R1M docs; Linux, macOS, Windows): a workspace with
// robostack-<distro> ros-<distro>-desktop + rmw-zenoh-cpp, robot stored as activation env vars
// so `pixi run rviz2` also works by hand. native: /opt/ros/<distro> with rmw_zenoh_cpp (Ubuntu).

const RVIZ_DIR = path.join(CACHE, "rviz");
const RVIZ_LOG = path.join(RVIZ_DIR, "rviz.log");
const RVIZ_PID = path.join(RVIZ_DIR, "rviz.pid");
const PIXI_LOG = path.join(RVIZ_DIR, "pixi-setup.log");
/** The AD-R1M docs create ./pixiws; ~/pixiws by default, so a docs-made one is reused. */
const PIXI_WS = process.env.AD_R1M_PIXI_WS || path.join(os.homedir(), "pixiws");
const pixiPackages = () => ["desktop", "rmw-zenoh-cpp", "teleop-twist-keyboard", /* Navigation 2 panel in rtab.rviz */ "nav2-rviz-plugins"].map((p) => `ros-${config.rosDistro}-${p}`);
const zenohOverride = (/** @type {string} */ host) => `connect/endpoints=["tcp/${host}:7447"];mode="client"`;
const PIXI_INSTALL = IS_WINDOWS
  ? 'In PowerShell: powershell -ExecutionPolicy Bypass -c "irm -useb https://pixi.sh/install.ps1 | iex", then reopen the window.'
  : "In a terminal: curl -fsSL https://pixi.sh/install.sh | sh, then reopen the terminal.";

function pixiBinary() {
  const home = path.join(os.homedir(), ".pixi", "bin", IS_WINDOWS ? "pixi.exe" : "pixi");
  if (fs.existsSync(home)) return home;
  const r = spawnSync(IS_WINDOWS ? "where" : "which", ["pixi"], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").split(/\r?\n/).find(Boolean)?.trim() || null : null;
}

/** @type {{running: boolean, exitCode?: number} | null} */
let pixiJob = null;

function pixiState() {
  const manifest = path.join(PIXI_WS, "pixi.toml");
  const toml = fs.existsSync(manifest) ? fs.readFileSync(manifest, "utf8") : "";
  const missing = pixiPackages().filter((p) => !toml.includes(p));
  // RViz runs with desktop + rmw_zenoh; setup adds the rest (e.g. the Navigation 2 panel) to an
  // existing workspace, such as one made before a package was added to pixiPackages.
  const ready = !!toml && !pixiPackages().slice(0, 2).some((p) => missing.includes(p));
  return { binary: pixiBinary(), workspace: PIXI_WS, ready, missing, setup: { ...pixiJob, log: PIXI_LOG, tail: tailOf(PIXI_LOG) }, installHint: PIXI_INSTALL };
}

const nativeSetup = () => {
  const setup = `/opt/ros/${config.rosDistro}/setup.bash`;
  return { available: !IS_WINDOWS && fs.existsSync(setup), setup };
};

/** Create the pixi workspace (a few minutes, ~2 GB). Runs in this process: no shell on Windows. */
function pixiSetup() {
  const pixi = pixiBinary();
  if (!pixi) throw new Error(`pixi is not installed on this PC. ${PIXI_INSTALL} Then call rviz action=setup again.`);
  if (!pixiState().missing.length) return { started: false, reason: "Pixi workspace is already set up" };
  if (pixiJob?.running) return { started: false, reason: "Setup is already running" };
  fs.mkdirSync(RVIZ_DIR, { recursive: true });
  fs.mkdirSync(PIXI_WS, { recursive: true });
  fs.writeFileSync(PIXI_LOG, "");
  const manifest = path.join(PIXI_WS, "pixi.toml");
  const steps = [
    ...(fs.existsSync(manifest) ? [] : [["init", "-c", `robostack-${config.rosDistro}`, "-c", "conda-forge", PIXI_WS]]),
    ["add", "--manifest-path", manifest, ...pixiPackages()],
  ];
  pixiJob = { running: true };
  (async () => {
    for (const args of steps) {
      fs.appendFileSync(PIXI_LOG, `$ pixi ${args.join(" ")}\n`);
      const code = await new Promise((resolve) => {
        const c = spawn(pixi, args, { cwd: PIXI_WS, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        c.stdout.on("data", (d) => fs.appendFileSync(PIXI_LOG, d));
        c.stderr.on("data", (d) => fs.appendFileSync(PIXI_LOG, d));
        c.on("error", (e) => (fs.appendFileSync(PIXI_LOG, `${e.message}\n`), resolve(1)));
        c.on("close", (n) => resolve(n ?? 1));
      });
      if (code !== 0) return void (pixiJob = { running: false, exitCode: /** @type {number} */ (code) });
    }
    pixiJob = { running: false, exitCode: 0 };
  })();
  return { started: true, workspace: PIXI_WS, packages: pixiPackages(), nextStep: "Poll rviz action=status until pixi.ready is true, then rviz action=start." };
}

function tracked() {
  try {
    const s = JSON.parse(fs.readFileSync(RVIZ_PID, "utf8"));
    process.kill(s.pid, 0);
    return s;
  } catch {
    return null;
  }
}

async function rvizStop() {
  const stopped = [];
  const t = tracked();
  const kill = (/** @type {number} */ pid, /** @type {NodeJS.Signals} */ sig) => {
    try {
      if (IS_WINDOWS) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-pid, sig); // the detached child leads its own process group
    } catch {
      // already gone
    }
  };
  if (t) {
    kill(t.pid, "SIGTERM");
    for (let i = 0; i < 10 && tracked(); i++) await sleep(300);
    if (tracked()) kill(t.pid, "SIGKILL");
    stopped.push(t.pid);
  }
  fs.rmSync(RVIZ_PID, { force: true });
  // Also close an rviz2 started by hand (Linux/macOS).
  if (!IS_WINDOWS) {
    for (const pid of (spawnSync("pgrep", ["-x", "rviz2"], { encoding: "utf8" }).stdout || "").split("\n").filter(Boolean).map(Number)) {
      try {
        process.kill(pid, "SIGTERM");
        stopped.push(pid);
      } catch {
        // already gone
      }
    }
  }
  return { running: false, stopped };
}

/** @param {string} rvizConfig @param {string} runtime */
async function rvizStart(rvizConfig, runtime) {
  if (!config.host) throw new Error(`No robot selected. ${NO_ROBOT_HINT}`);
  if (!fs.existsSync(rvizConfig)) throw new Error(`RViz config not found: ${rvizConfig}`);
  const pixi = pixiState();
  const native = nativeSetup();
  const use = runtime === "pixi" ? (pixi.ready ? "pixi" : null) : runtime === "native" ? (native.available ? "native" : null) : pixi.ready ? "pixi" : native.available ? "native" : null;
  if (!use) {
    const fix = pixi.binary ? "Call rviz action=setup (confirm with the user: ~2 GB download)." : `Install pixi first: ${PIXI_INSTALL} Then rviz action=setup.`;
    return { running: false, error: `No pixi workspace with ROS 2 ${config.rosDistro} at ${pixi.workspace}${runtime === "pixi" ? "" : ` and no native ${native.setup}`}. ${fix}`, pixi, native };
  }
  await rvizStop();
  fs.mkdirSync(RVIZ_DIR, { recursive: true });
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, RMW_IMPLEMENTATION: "rmw_zenoh_cpp", ZENOH_CONFIG_OVERRIDE: zenohOverride(config.host) };
  if (process.platform === "linux") {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) env.DISPLAY = ":0";
    env.XDG_RUNTIME_DIR ||= `/run/user/${os.userInfo().uid}`;
  }
  let command;
  let args;
  if (use === "pixi") {
    const manifest = path.join(PIXI_WS, "pixi.toml");
    // Stored the documented way, so `pixi run rviz2` by hand reaches the same robot.
    const set = spawnSync(/** @type {string} */ (pixi.binary), ["workspace", "activation", "env", "set", "--manifest-path", manifest, "RMW_IMPLEMENTATION=rmw_zenoh_cpp", `ZENOH_CONFIG_OVERRIDE=${zenohOverride(config.host)}`], { encoding: "utf8", windowsHide: true });
    if (set.status !== 0) return { running: false, error: `pixi workspace activation env set failed: ${(set.stderr || set.stdout || "").trim()}` };
    command = /** @type {string} */ (pixi.binary);
    args = ["run", "--manifest-path", manifest, "rviz2", "-d", rvizConfig];
  } else {
    command = "bash";
    args = ["-c", 'source "$0" && exec ros2 run rviz2 rviz2 -d "$1"', native.setup, rvizConfig];
  }
  const out = fs.openSync(RVIZ_LOG, "w");
  const child = spawn(command, args, { env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  fs.closeSync(out);
  if (child.pid) fs.writeFileSync(RVIZ_PID, JSON.stringify({ pid: child.pid, runtime: use }));
  // rviz2 dies within seconds on a missing display or RMW: report that, not a dead PID.
  await sleep(5000);
  if (child.exitCode !== null) {
    fs.rmSync(RVIZ_PID, { force: true });
    return { running: false, runtime: use, error: `rviz2 exited with code ${child.exitCode}:\n${tailOf(RVIZ_LOG, 15).join("\n")}` };
  }
  return { running: true, pid: child.pid, runtime: use, robot: config.host, config: rvizConfig, log: RVIZ_LOG };
}

/** @param {{action?: string, config?: string, runtime?: string}} a */
export async function rviz(a) {
  switch (a.action || "start") {
    case "start": return rvizStart(a.config || path.join(TEMPLATES_DIR, "rtab.rviz"), a.runtime || "auto");
    case "stop": return rvizStop();
    case "setup": return pixiSetup();
    case "status": {
      const t = tracked();
      return { running: !!t, pid: t?.pid, runtime: t?.runtime, robot: config.host || undefined, log: RVIZ_LOG, pixi: pixiState(), native: nativeSetup() };
    }
    default: throw new Error("action must be start, stop, setup or status");
  }
}
