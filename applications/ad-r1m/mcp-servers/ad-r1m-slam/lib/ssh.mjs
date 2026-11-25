// @ts-check
// SSH to the robot: selected-robot config, sshpass, failure classification and the runner
// for scripts/*.sh. Every script runs on the robot host (ROS work goes through rosx in
// scripts/lib.sh); arguments are passed as "$@" and secrets on stdin.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.dirname(HERE);
/** plugins/datax/skills */
export const SKILLS_DIR = path.join(SERVER_DIR, "..", "..", "skills");
export const TEMPLATES_DIR = process.env.SLAM_TEMPLATES_DIR || path.join(SKILLS_DIR, "ad-r1m-robot", "templates");

const distro = process.env.ROS_DISTRO || "humble";
export const config = {
  // Empty = no robot selected yet; tools then tell the agent to ask the user.
  host: process.env.ROBOT_HOST || "",
  user: process.env.ROBOT_USER || "analog",
  password: process.env.ROBOT_PASSWORD || "analog",
  rosDistro: distro,
  rmw: process.env.RMW_IMPLEMENTATION || "rmw_zenoh_cpp",
  rosContainer: process.env.ROS_CONTAINER || "",
  slamContainer: process.env.SLAM_CONTAINER || "slam_workspace",
  // The image the robot's own robot/tof/nav compose services run (see ad-r1m.env).
  dockerImage: process.env.DOCKER_IMAGE || `docker.cloudsmith.io/adi/adrd-common/ad-r1m:robot-${distro}`,
};

/** One image for every SLAM package: the robot image's name with tag robot-slam. */
export const slamImage = () => process.env.SLAM_IMAGE || config.dockerImage.replace(/:[^:/]+$/, "") + ":robot-slam";

// The last selected robot survives a server restart (e.g. /mcp reconnect). ROBOT_HOST wins.
// Mode 0600: it holds the robot's SSH password.
const SELECTED_FILE =
  process.env.AD_R1M_SELECTED_ROBOT_FILE ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "ad-r1m-slam", "selected-robot.json");

if (!process.env.ROBOT_HOST) {
  try {
    const saved = JSON.parse(fs.readFileSync(SELECTED_FILE, "utf8"));
    if (saved?.host) Object.assign(config, { host: saved.host, user: saved.user || config.user, password: saved.password ?? config.password });
  } catch {
    // nothing saved yet
  }
}

/** @param {{host?: string, user?: string, password?: string}} c */
export function selectRobot(c) {
  Object.assign(config, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)));
  try {
    fs.mkdirSync(path.dirname(SELECTED_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SELECTED_FILE, JSON.stringify({ host: config.host, user: config.user, password: config.password }) + "\n", { mode: 0o600 });
    fs.chmodSync(SELECTED_FILE, 0o600);
  } catch (e) {
    console.error(`Could not save the selected robot to ${SELECTED_FILE}: ${/** @type {Error} */ (e).message}`);
  }
}

// AD-R1M hostname conventions (setup-rpi.rst, getting-started.rst).
export const NO_ROBOT_HINT =
  "Ask the user for the robot's hostname or IP address and SSH password, then call connect_robot. Hostnames: " +
  "'analog' / analog.local = freshly flashed Kuiper image (reach it over Ethernet until Wi-Fi is set up; avahi may " +
  "rename it analog-2.local on a LAN that already has one); 'ad-r1m-<N>' / ad-r1m-<N>.local = configured robot, " +
  "N usually the serial number; any custom name; or an IP address when .local names don't resolve.";

/** Connection-level failure, as opposed to the remote command exiting non-zero. */
export class SshError extends Error {
  /** @param {string} kind @param {string} host @param {string} detail */
  constructor(kind, host, detail) {
    super(`SSH to ${host || "<no host>"} failed (${kind}): ${detail}`);
    this.kind = kind;
  }
}

/** @typedef {{host: string, user: string, password: string}} Target */

/** @returns {Target} */
export function selectedTarget() {
  if (!config.host) throw new SshError("no_robot_selected", "", `No robot selected. ${NO_ROBOT_HINT}`);
  return { host: config.host, user: config.user, password: config.password };
}

/**
 * sshpass exits 5 on a rejected password; ssh exits 255 on connection errors.
 * @param {string} host @param {number|null} status @param {string} stderr @param {any} [spawnError]
 */
function classify(host, status, stderr, spawnError) {
  if (spawnError?.code === "ENOENT") return new SshError("sshpass_missing", host, "sshpass is not installed on this PC (e.g. `sudo apt install sshpass`).");
  if (status === 5 || /Permission denied/i.test(stderr)) {
    return new SshError("auth_failed", host, "Wrong username or password. Ask the user for the SSH password (and user, default analog) and call connect_robot.");
  }
  if (status !== 255) return null;
  if (/Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution/i.test(stderr)) {
    return new SshError("dns_unresolved", host, `Hostname does not resolve - the name may be wrong or mDNS (.local) may not work on this network. ${NO_ROBOT_HINT}`);
  }
  if (/Connection refused/i.test(stderr)) return new SshError("ssh_refused", host, "Host is up but SSH is refused - it may still be booting (~60 s).");
  return new SshError(
    "unreachable",
    host,
    `${stderr.trim() || "No response"}. Check the robot is powered on (LED ring solid green) and on the same network or Ethernet. ${NO_ROBOT_HINT}`
  );
}

/**
 * Host keys are not recorded: a reflashed robot keeps its hostname but gets a new key, and a
 * stale recorded key makes OpenSSH disable password auth even under StrictHostKeyChecking=no,
 * which breaks sshpass.
 * @param {Target} t @param {string} command
 * @param {{timeout?: number, connectTimeout?: number, input?: string, stdout?: number}} [o]
 * @returns {Promise<string>}
 */
export function ssh(t, command, { timeout = 30000, connectTimeout = 10, input, stdout } = {}) {
  const args = [
    "-e", "ssh",
    "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
    "-o", `ConnectTimeout=${connectTimeout}`,
    "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "NumberOfPasswordPrompts=1",
    "--", `${t.user}@${t.host}`, command,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("sshpass", args, {
      env: { ...process.env, SSHPASS: t.password },
      stdio: [input === undefined ? "ignore" : "pipe", stdout ?? "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SshError("command_timeout", t.host, `Command timed out after ${Math.round(timeout / 1000)} s.`));
    }, timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(classify(t.host, null, "", e) || e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      const conn = classify(t.host, code, err);
      reject(conn || new Error(`Exit ${code} on the robot: ${(err || out).trim().slice(-4000) || "no output"}`));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Single-quote for a POSIX shell. @param {string} s */
export const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// Read on every call, not cached: a running server (Claude Code's or the demo app's) then
// picks up script fixes without a restart.
/** @param {string} name */
function scriptText(name) {
  return fs.readFileSync(path.join(SERVER_DIR, "scripts", `${name}.sh`), "utf8");
}

/**
 * Run scripts/<names>.sh (lib.sh first) on the robot with the given arguments.
 * root: run it through sudo; the password goes as the first stdin line (skipped when sudo
 * needs none) and is masked, with any secrets, in the output.
 * @param {string|string[]} names @param {string[]} [args]
 * @param {{target?: Target, timeout?: number, root?: boolean, secrets?: string[]}} [o]
 */
export async function run(names, args = [], { target, timeout = 30000, root = false, secrets = [] } = {}) {
  const t = target || selectedTarget();
  const body =
    `R1M_ROS_DISTRO=${shq(config.rosDistro)} R1M_ROS_CONTAINER=${shq(config.rosContainer)} R1M_SLAM_CONTAINER=${shq(config.slamContainer)}\n` +
    ["lib", ...[names].flat()].map(scriptText).join("\n");
  const b64 = Buffer.from(body).toString("base64");
  // A temp file, not `bash -c <script>`: the script text must not appear on a command line,
  // where `pkill -f` patterns in it would match the shell itself. stdin stays free for secrets.
  const exec = root
    ? `IFS= read -r P; { sudo -n true 2>/dev/null || printf '%s\\n' "$P"; cat; } | sudo -S -p '' bash "$F" ${args.map(shq).join(" ")}`
    : `bash "$F" ${args.map(shq).join(" ")}`;
  const command = `F=$(mktemp /tmp/r1m.XXXXXX) && echo ${b64} | base64 -d > "$F" && chmod 644 "$F" && { ${exec}; R=$?; rm -f "$F"; exit $R; }`;
  const lines = [...(root ? [t.password] : []), ...secrets];
  const input = lines.length ? lines.join("\n") + "\n" : undefined;
  const scrub = (/** @type {string} */ s) => lines.filter((x) => x && x.length > 2).reduce((acc, x) => acc.split(x).join("***"), s);
  try {
    return scrub(await ssh(t, command, { timeout, input }));
  } catch (e) {
    const err = /** @type {Error} */ (e);
    err.message = scrub(err.message);
    throw err;
  }
}

/** "### name" sections of a script's output. @param {string} out @returns {Record<string, string>} */
export function sections(out) {
  /** @type {Record<string, string[]>} */
  const s = { _: [] };
  let cur = "_";
  for (const line of out.split("\n")) {
    const m = line.match(/^### (\w+)$/);
    if (m) s[(cur = m[1])] = s[cur] || [];
    else s[cur].push(line);
  }
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.join("\n").trim()]));
}

/** key=value lines. @param {string} [text] @returns {Record<string, string>} */
export function kv(text = "") {
  /** @type {Record<string, string>} */
  const o = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return o;
}

/** Non-empty lines. @param {string} [text] */
export const lines = (text = "") => text.split("\n").map((l) => l.trim()).filter(Boolean);
