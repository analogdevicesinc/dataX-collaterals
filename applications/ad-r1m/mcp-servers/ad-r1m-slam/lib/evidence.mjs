// @ts-check
// package_evidence: facts for evaluating ROS 2 SLAM packages on this robot - no scores. The
// agent scores them with skills/ad-r1m-slam-integration/EVALUATION_CRITERIA.md. Sources: what
// the robot publishes and can install, each package's repository (local sparse clone), field
// notes and tested templates from catalog.json, and the matching lines of the research docs.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config, lines, run, sections, slamImage, SKILLS_DIR, TEMPLATES_DIR } from "./ssh.mjs";

const execFileAsync = promisify(execFile);
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ad-r1m-slam");
const REPOS_DIR = process.env.SLAM_REPOS_DIR || path.join(CACHE, "repos");
const CATALOG = path.join(SKILLS_DIR, "ad-r1m-slam-integration", "catalog.json");
const RESEARCH_FILES = ["ad-r1m-robot/RTAB_RESEARCH.md", "ad-r1m-robot/ROBOT_SPEC.md", "ad-r1m-slam-integration/EVALUATION_CRITERIA.md"];

/** AD-R1M per ROBOT_SPEC.md, used when the robot cannot be reached or live=false. */
const SPEC_ROBOT = {
  distro: "humble", arch: "aarch64", cpus: 4, memGB: 8, cuda: false,
  capabilities: { depth: ["/cam1/depth_image"], image: ["/cam1/ab_image"], pointcloud: ["/cam1/point_cloud"], scan_2d: ["/scan"], imu: ["/imu"], odom: ["/odometry/filtered"] },
  synthetic: ["scan_2d"],
};

/** Sensor capabilities from `ros2 topic list -t`. @param {string[]} topics @param {string[]} nodes */
function capabilities(topics, nodes) {
  /** @type {Record<string, string[]>} */
  const caps = {};
  const add = (/** @type {string} */ c, /** @type {string} */ t) => (caps[c] = [...(caps[c] || []), t]);
  for (const line of topics) {
    const m = line.match(/^(\S+)\s+\[([^\]]+)\]/);
    if (!m) continue;
    const [, topic, type] = m;
    if (type === "sensor_msgs/msg/Image") {
      if (/depth/i.test(topic)) add("depth", topic);
      else if (/(left|right)/i.test(topic)) add("stereo", topic);
      else if (!/processed|compressed|debug|conf/i.test(topic)) add("image", topic); // conf = ToF confidence map
    } else if (type === "sensor_msgs/msg/PointCloud2") {
      if (/lidar|velodyne|ouster|livox|hesai|points_raw|rslidar/i.test(topic)) add("lidar_3d", topic);
      else if (!/obstacle|ground|filtered|cloud_map|assembled/i.test(topic)) add("pointcloud", topic);
    } else if (type === "sensor_msgs/msg/LaserScan") add("scan_2d", topic);
    else if (type === "sensor_msgs/msg/Imu") add("imu", topic);
    else if (type === "nav_msgs/msg/Odometry" && /filtered|odom/i.test(topic)) add("odom", topic);
  }
  if ((caps.stereo || []).length < 2) delete caps.stereo; // stereo needs both eyes
  // /scan made from depth (depthimage_to_laserscan) is a derived, weaker input than a LiDAR.
  const synthetic = caps.scan_2d && !caps.lidar_3d && nodes.some((n) => /depthimage_to_laserscan|pointcloud_to_laserscan/.test(n)) ? ["scan_2d"] : [];
  return { capabilities: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v.slice(0, 2)])), synthetic };
}

/** @param {boolean} live @param {string[]} apt @param {string[]} ros */
async function probeRobot(live, apt, ros) {
  const offline = (/** @type {string} */ why) => ({ robot: { live: false, note: why, ...SPEC_ROBOT }, apt: {}, installed: null });
  if (!live) return offline("live=false: robot data from ROBOT_SPEC.md");
  let out;
  try {
    out = await run("evidence", [slamImage(), ...apt, "--", ...ros], { timeout: 90000 });
  } catch (e) {
    return offline(`Robot not reachable, robot data from ROBOT_SPEC.md: ${/** @type {Error} */ (e).message}`);
  }
  const s = sections(out);
  const topics = lines(s.topics);
  const distro = s.distro || config.rosDistro;
  /** @type {Record<string, string>} */
  const aptFound = {};
  for (const l of lines(s.apt)) {
    const [k, v] = l.split("=");
    aptFound[k.replace(`ros-${distro}-`, "")] = v === "(none)" ? "" : v;
  }
  const pkgs = s.ros_packages === undefined ? null : new Set(lines(s.ros_packages));
  return {
    robot: {
      live: topics.length > 0,
      ...(topics.length ? {} : { note: "Robot reachable but no ROS topics (is the stack running?) - sensors from ROBOT_SPEC.md" }),
      distro, arch: s.arch, cpus: Number(s.cpus) || 0, memGB: Number(s.mem_gb) || 0, cuda: s.cuda === "yes",
      ...(topics.length ? capabilities(topics, lines(s.nodes)) : { capabilities: SPEC_ROBOT.capabilities, synthetic: SPEC_ROBOT.synthetic }),
      slamImage: s.slam_image === "yes" ? slamImage() : null,
    },
    apt: aptFound,
    installed: pkgs && Object.fromEntries(ros.map((n) => [n, pkgs.has(n)])),
  };
}

// --- repository evidence (local shallow, sparse clone) ------------------------------------

/** Remote facts (GitHub metadata, branches, tags) are cached 6 h: the unauthenticated API allows 60 requests/h. */
const GH_CACHE = path.join(CACHE, "github-cache.json");
const GH_TTL = 6 * 3600_000;
function cache(/** @type {string} */ key, /** @type {any} */ value) {
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(GH_CACHE, "utf8"));
  } catch {
    // no cache yet
  }
  if (value === undefined) {
    const hit = /** @type {any} */ (all)[key];
    return hit && Date.now() - hit.at < GH_TTL ? hit.value : undefined;
  }
  /** @type {any} */ (all)[key] = { at: Date.now(), value };
  for (const [k, v] of Object.entries(all)) if (Date.now() - /** @type {any} */ (v).at >= GH_TTL) delete /** @type {any} */ (all)[k];
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(GH_CACHE, JSON.stringify(all));
}

/** Terms worth knowing wherever they appear in the README. */
const README_TERMS = /** @type {[string, RegExp][]} */ ([
  ["CUDA/GPU", /\bcuda\b|nvidia|\bgpu\b/i], ["ROS 2", /\bros ?2\b|\bhumble\b|\bjazzy\b|\bfoxy\b|\bament\b|colcon/i],
  ["ROS 1", /\bcatkin\b|\broscore\b|\bnoetic\b|\bmelodic\b/i], ["LiDAR", /\blidar\b|velodyne|ouster|livox/i],
  ["RGB-D/depth", /rgb-?d\b|realsense|depth camera|depth image|kinect/i], ["stereo", /\bstereo\b/i], ["monocular", /\bmonocular\b/i],
  ["IMU", /\bimu\b|inertial/i], ["point cloud", /point ?cloud|pointcloud2/i], ["loop closure", /loop[- ]closure/i],
  ["Nav2", /\bnav2\b|navigation2|occupancy grid/i], ["ARM/embedded", /\barm64\b|aarch64|raspberry pi|jetson/i],
]);
/** ROS messages a package consumes/produces, as written in C++ and Python: the best evidence of sensor fit. */
const MSG = /sensor_msgs(?:::msg::|\/msg\/|\.msg\.| *import +)(Image|CompressedImage|CameraInfo|PointCloud2|LaserScan|Imu|NavSatFix)\b|nav_msgs(?:::msg::|\/msg\/|\.msg\.)(Odometry|OccupancyGrid|Path)\b/g;
/** Dependencies worth an evaluator's attention; the rest (rclcpp, std_msgs, ...) is noise. */
const NOTABLE_DEP = /cuda|nvidia|tensorrt|torch|pcl|opencv|cv_bridge|pangolin|g2o|gtsam|ceres|sophus|octomap|nav2|realsense|velodyne|livox|ouster|hesai|mrpt|mola|rtabmap|open3d|tbb|vtk|qt/i;
/** Sparse checkout: only what is read here. A plain checkout pulls vocabularies/datasets (ORB_SLAM3_ROS2 was 880 MB). */
const SPARSE = ["/README*", "/readme*", "package.xml", "CMakeLists.txt", "*.cmake", "*.c", "*.cc", "*.cpp", "*.cxx", "*.h", "*.hh", "*.hpp", "*.py", "*.cu", "*.cuh", "*.launch", "*.launch.py", "*.launch.xml", "launch/*"];
const SKIP = /(^|\/)(test|tests|thirdparty|third_party|vendor|external|docs?)\//i;

/** Files under dir (no .git), relative, capped. @param {string} dir */
function walk(dir, cap = 20000) {
  const out = [];
  const stack = [""];
  while (stack.length && out.length < cap) {
    const rel = /** @type {string} */ (stack.pop());
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

/** @param {string} md */
const plainReadme = (md) =>
  md.replace(/<[^>]+>/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, "[code]").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

/** @param {string} repoUrl @param {number} readmeChars @param {boolean} refresh */
async function repoEvidence(repoUrl, readmeChars, refresh) {
  const url = repoUrl.trim().replace(/\/+$/, "");
  const gh = url.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/i);
  const repo = gh ? `https://github.com/${gh[1]}/${gh[2]}` : url;
  const git = (/** @type {string[]} */ args, timeout = 60000) => execFileAsync("git", args, { timeout, maxBuffer: 16 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).then((r) => r.stdout);
  const dir = path.join(REPOS_DIR, (gh ? `${gh[1]}__${gh[2]}` : url.replace(/^\w+:\/\//, "")).replace(/[^\w.-]+/g, "_").toLowerCase());
  const warnings = [];
  try {
    const key = `remote:${repo.toLowerCase()}`;
    let remote = refresh ? undefined : cache(key, undefined);
    if (!remote) {
      const headers = { "User-Agent": "ad-r1m-slam-mcp", Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
      const [meta, heads, tags] = await Promise.all([
        gh
          ? fetch(`https://api.github.com/repos/${gh[1]}/${gh[2]}`, { headers, signal: AbortSignal.timeout(15000) }).then(async (r) =>
              r.ok ? r.json() : { error: r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0" ? "GitHub API rate limit reached (set GITHUB_TOKEN)" : `HTTP ${r.status}` }
            ).catch((e) => ({ error: e.message }))
          : undefined,
        git(["ls-remote", "--heads", repo]).catch(() => ""),
        git(["ls-remote", "--tags", "--refs", repo]).catch(() => ""),
      ]);
      remote = { meta, heads, tags };
      // Rate-limited metadata is retried next run.
      if (!meta?.error) cache(key, remote);
    }
    const meta = remote.meta;
    if (meta?.error) warnings.push(`GitHub API (stars/archived/license): ${meta.error}`);

    let clone = "reused";
    if (!fs.existsSync(path.join(dir, ".git"))) {
      fs.rmSync(dir, { recursive: true, force: true }); // partial clone from an interrupted run
      fs.mkdirSync(REPOS_DIR, { recursive: true });
      await git(["clone", "--depth", "1", "--single-branch", "--filter=blob:none", "--no-checkout", "--quiet", repo, dir], 180000).catch((e) => {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(`git clone failed: ${(e.stderr || e.message).trim().split("\n").pop()}`);
      });
      await git(["-C", dir, "sparse-checkout", "set", "--no-cone", ...SPARSE]);
      await git(["-C", dir, "checkout", "--quiet"], 180000);
      clone = "cloned";
    } else if (refresh) {
      await git(["-C", dir, "fetch", "--depth", "1", "--quiet", "origin"], 180000);
      await git(["-C", dir, "reset", "--hard", "--quiet", "FETCH_HEAD"]);
      clone = "refreshed";
    }

    const files = walk(dir);
    const read = (/** @type {string} */ p) => { try { return fs.readFileSync(path.join(dir, p), "utf8"); } catch { return ""; } };
    const readme = read(files.find((p) => /^readme(\.md|\.rst|\.txt)?$/i.test(p)) || "");
    if (!readme) warnings.push("README: none at repo root");
    const packages = files.filter((p) => p.endsWith("package.xml") && !SKIP.test(p)).slice(0, 20).map((p) => {
      const xml = read(p);
      return {
        name: xml.match(/<name>\s*([\w-]+)/)?.[1] || "",
        // ament_* = ROS 2, catkin = ROS 1
        buildType: xml.match(/<build_type>\s*([\w-]+)/)?.[1] || (/<buildtool_depend>\s*catkin/.test(xml) ? "catkin" : "unknown"),
        depends: [...xml.matchAll(/<(?:build_|exec_|build_export_)?depend[^>]*>\s*([\w.-]+)\s*</g)].map((d) => d[1]),
      };
    });
    const cmake = files.filter((p) => /(^|\/)CMakeLists\.txt$/.test(p) && !SKIP.test(p)).slice(0, 20).map(read);
    /** @type {Record<string, number>} */
    const msgs = {};
    const sources = files.filter((p) => /\.(c|cc|cpp|cxx|h|hh|hpp|py)$/.test(p) && !SKIP.test(p)).slice(0, 3000);
    for (const p of sources) for (const m of read(p).matchAll(MSG)) {
      const t = m[1] ? `sensor_msgs/${m[1]}` : `nav_msgs/${m[2]}`;
      msgs[t] = (msgs[t] || 0) + 1;
    }
    const launch = files.filter((p) => /(^|\/)launch\/[^/]+\.(py|xml|ya?ml)$|\.launch(\.py|\.xml)?$/.test(p) && !SKIP.test(p));
    const stamp = ["shallow", "HEAD"].map((f) => path.join(dir, ".git", f)).find((f) => fs.existsSync(f));
    return {
      url: repo,
      description: (meta?.description || "").slice(0, 160),
      lastCommit: (await git(["-C", dir, "log", "-1", "--format=%cI"]).catch(() => "")).trim().slice(0, 10),
      archived: meta?.archived,
      license: meta?.license?.spdx_id || meta?.license?.name,
      stars: meta?.stargazers_count,
      distroBranches: remote.heads.split("\n").map((/** @type {string} */ l) => l.split("refs/heads/")[1]).filter((/** @type {string} */ b) => b && /humble|jazzy|iron|rolling|foxy|galactic|noetic|melodic|ros2|ros1/i.test(b)),
      tags: remote.tags.split("\n").map((/** @type {string} */ l) => l.split("refs/tags/")[1]).filter(Boolean).slice(-3),
      rosPackages: { count: packages.length, buildTypes: [...new Set(packages.map((x) => x.buildType))], names: packages.map((x) => x.name) },
      notableDeps: [...new Set([...packages.flatMap((x) => x.depends), ...cmake.flatMap((t) => [...t.matchAll(/find_package\s*\(\s*([\w-]+)/g)].map((x) => x[1]))].filter((d) => NOTABLE_DEP.test(d)))].slice(0, 15),
      cuda: cmake.some((t) => /find_package\s*\(\s*(CUDA|CUDAToolkit)\b|enable_language\s*\(\s*CUDA|LANGUAGES[^)]*\bCUDA\b/i.test(t)) || files.some((p) => /\.cuh?$/.test(p)),
      x86OnlyFlags: [...new Set(cmake.flatMap((t) => [...t.matchAll(/-m(sse[\d.]*|avx\w*|arch=native)/g)].map((x) => x[0])))],
      launchFiles: { count: launch.length, examples: launch.slice(0, 5).map((f) => f.split("/").pop()) },
      messageTypesInCode: msgs,
      readmeMentions: README_TERMS.filter(([, re]) => re.test(readme)).map(([t]) => t),
      readme: plainReadme(readme).slice(0, readmeChars),
      clone: { path: dir, action: clone, ...(stamp ? { updatedAt: fs.statSync(stamp).mtime.toISOString() } : {}) },
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (e) {
    return { url: repo, error: /** @type {Error} */ (e).message };
  }
}

/** Research-doc lines that mention the package, as file:line. @param {string[]} names */
function researchFor(names) {
  const terms = [...new Set(names.filter(Boolean))].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_ ]/g, "[-_ ]?"));
  if (!terms.length) return [];
  const re = new RegExp(`\\b(${terms.join("|")})\\b`, "i");
  const hits = [];
  for (const f of RESEARCH_FILES) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(SKILLS_DIR, f), "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((l, i) => {
      const t = l.trim();
      // Lines that state something: no headings, table rules or bare links.
      if (re.test(t) && t.length > 25 && !/^#|^\|[-| ]+\|$|^- \*\*Repository/.test(t)) hits.push(`skills/${f}:${i + 1}: ${t.slice(0, 180)}`);
    });
  }
  return hits.slice(0, 4);
}

/** Templates tested on AD-R1M whose name starts with the package's stem (rtabmap_*, mola_*). @param {string[]} names */
function templatesFor(names) {
  const stems = [...new Set(names.map((n) => n.toLowerCase().split(/[_-]/)[0]).filter((s) => s.length >= 4))];
  return fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith("_launch.py") && stems.some((s) => f.toLowerCase().startsWith(s))).map((f) => `skills/ad-r1m-robot/templates/${f}`);
}

/** @param {{packages?: (string|{name: string, repo?: string})[], live?: boolean, github?: boolean, readme_chars?: number, refresh?: boolean}} a */
export async function packageEvidence(a) {
  /** @type {Record<string, any>} */
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8")).packages;
  const norm = (/** @type {string} */ s) => (s.toLowerCase().replace(/\.git$/, "").split("/").pop() || "").replace(/[^a-z0-9]/g, "");
  const find = (/** @type {string} */ name) => Object.entries(catalog).find(([k, e]) => norm(k) === norm(name) || (e.aliases || []).some((/** @type {string} */ x) => norm(x) === norm(name)) || (e.repo && norm(e.repo) === norm(name)));
  const req = (a.packages?.length ? a.packages : Object.keys(catalog)).map((p) => (typeof p === "string" ? { name: p } : p));
  const resolved = req.map((p) => {
    const hit = find(p.name) || (p.repo ? find(p.repo) : undefined);
    return { name: hit?.[0] || p.name, entry: hit?.[1], repo: p.repo || hit?.[1].repo };
  });
  const readmeChars = Math.max(0, Math.min(a.readme_chars ?? 1200, 20000));

  // Repositories first: their package.xml names say which ros-<distro>-* packages to check on the robot.
  const repos = await Promise.all(resolved.map((r) => (r.repo && a.github !== false ? repoEvidence(r.repo, readmeChars, !!a.refresh) : undefined)));
  const rosNames = resolved.map((r, i) => [...new Set([r.entry?.rosPackage, .../** @type {any} */ (repos[i])?.rosPackages?.names || []].filter(Boolean))]);
  const aptNames = resolved.map((r, i) => [...new Set([r.entry?.apt, ...rosNames[i].map((/** @type {string} */ n) => n.replace(/_/g, "-"))].filter(Boolean))]);
  const probe = await probeRobot(a.live !== false, [...new Set(aptNames.flat())], [...new Set(rosNames.flat())]);

  return {
    robot: probe.robot,
    packages: resolved.map((r, i) => ({
      package: r.name,
      inCatalog: !!r.entry,
      fieldNotes: r.entry?.fieldNotes,
      notes: r.entry?.notes,
      robotTemplates: templatesFor([r.name, ...(r.entry?.aliases || [])]),
      // Robot not probed: say unknown, not "0/0", which reads as "no binaries".
      onRobot: !probe.robot.live
        ? "unknown (robot not probed)"
        : {
            aptBinaries: Object.fromEntries(aptNames[i].map((n) => [`ros-${probe.robot.distro}-${n}`, /** @type {any} */ (probe.apt)[n] || ""])),
            ...(probe.installed ? { installedInSlamImage: Object.fromEntries(rosNames[i].map((n) => [n, /** @type {any} */ (probe.installed)[n]])) } : {}),
          },
      ...(repos[i] ? { repo: repos[i] } : {}),
      research: researchFor([r.name, ...(r.entry?.aliases || [])]),
    })),
  };
}
