---
name: ad-r1m-slam-integration
description: Evaluates ROS 2 SLAM packages (ORB-SLAM3, MOLA, KISS-ICP, slam_toolbox, a GitHub repo, ...) against the AD-R1M's hardware from live robot and repository evidence, then installs the chosen one in the robot's SLAM container and integrates it with a generated launch file. Use when the user asks which SLAM package fits the AD-R1M, wants a new or custom SLAM package on it, or setup_workspace reports unresolved dependencies. For running or tuning the tested RTAB-Map setup use ad-r1m-robot.
license: Apache-2.0
allowed-tools:
  - mcp__plugin_datax_ad-r1m__package_evidence
  - mcp__plugin_datax_ad-r1m__robot_status
  - mcp__plugin_datax_ad-r1m__ros2_query
  - mcp__plugin_datax_ad-r1m__setup_workspace
  - mcp__plugin_datax_ad-r1m__slam
  - mcp__plugin_datax_ad-r1m__diagnostics
---

# SLAM Package Evaluation and Integration

The robot must be connected and ready (`ad-r1m-bringup`). Ask the user before installing or
deploying anything on the robot.

## 1. Evaluate

You do the scoring; nothing is precomputed.

1. `package_evidence`: omit `packages` for the whole catalog (`catalog.json`), or pass names
   (aliases work: "ORB-SLAM3", "MOLA") and `{name, repo}` for any git repository.
2. Score every package with [EVALUATION_CRITERIA.md](EVALUATION_CRITERIA.md): hardware 40,
   software 30, integration 20, performance 10.
   - GPU need: `repo.cuda`, CUDA in `notableDeps`, README mentions.
   - ROS 1 vs 2: `repo.rosPackages.buildTypes` (ament_* = ROS 2, catkin = ROS 1).
   - Distro support: `onRobot.aptBinaries` ("" = no binary for this robot) and `distroBranches`.
   - Sensor fit: `messageTypesInCode`, launch files and README against `robot.capabilities`.
     `robot.synthetic` marks derived, weaker inputs (the AD-R1M's `/scan` comes from the ToF
     depth image).
   - Maintenance: `lastCommit`, `archived`, `tags`.
   - `compatible=false` on a hard blocker: CUDA needed but `robot.cuda` false, no ROS 2, a
     required sensor missing.
   - `fieldNotes` and `robotTemplates` come from running on this robot and outweigh general
     claims; `notes` are general background.
3. Present per package: score, verdict, blockers, and reasons that cite the evidence (e.g. "code
   subscribes to sensor_msgs/LaserScan only; robot /scan is synthetic"). Name what you could not
   verify instead of guessing.

About the evidence:
- `robot` comes from one SSH probe. `live: false`, or an unreachable robot, falls back to
  ROBOT_SPEC.md (`robot.note` says so).
- `repo` is read from a local sparse clone in `~/.cache/ad-r1m-slam/repos`, cloned once;
  `refresh: true` pulls the latest commit. Stars, archived and license need the GitHub API
  (60 requests/h without `GITHUB_TOKEN`); `warnings` says what could not be fetched.
- `research` lists matching lines from the robot's research docs, with file:line.

## 2. Install in the SLAM container

SLAM packages run in the `slam_workspace` container, not in the robot's own containers, and the
robot's own `slam` compose profile (slam_toolbox via `ad_r1m_navigation`) is a separate thing
this does not touch.

`setup_workspace package=<ROS package> [repo=<git URL>]`:

1. Uses the shared image `<robot image>:robot-slam` when it exists, else the stock robot image
   (`docker.cloudsmith.io/adi/adrd-common/ad-r1m:robot-humble`). A `slam_workspace` from another
   image is recreated (`containerState`).
2. Generates the `slam_integration` package (package.xml depends on the SLAM package) and runs
   rosdep on it only - the robot's own packages pull gazebo deps that don't exist on arm64.
   rosdep and colcon are installed first if the image has none (the runner image has neither).
3. No rosdep rule: tries the Debian binary `ros-humble-<name with dashes>`.
4. Still missing and `repo` given: shallow clone with submodules into `/ros2_ws/src`, rosdep
   its dependencies, `colcon build --packages-up-to` the packages the repo contains (their names
   can differ from the repo name: ORB_SLAM3_ROS2 ships `orbslam3`).
5. `ready: true` only when the package itself is installed. The container is then committed
   back to `robot-slam` (`committedImage`), so packages accumulate and later setups only install
   what is new (about a minute).

Reading the result:

| Result | Why | Fix |
|---|---|---|
| `ready: false`, no `repo` given | Not in rosdep and no Debian binary | Pass `repo` (from `package_evidence` or the catalog) |
| `notBuilt` / `buildLog` | Source build failed | Read `buildLog`; often a missing system library or x86-only flags |
| `unresolvedKeys` | rosdep keys with no rule and no `ros-humble-*` binary | Usually system libraries; install them in the container or patch the package.xml |
| `rosdep: unavailable` | No apt access in the container | Check the robot's network |
| "robot image ... is not on the robot" | No robot-slam and no stock image | `ad-r1m-bringup`: `provision_robot docker_image=true` or `build_robot_image` |
| `package '<x>' not found` at launch | The launch file uses a package setup never installed | `setup_workspace` with the package name the launch file uses |

Delete `robot-slam` on the robot (`docker rmi`) to start again from the stock image.

## 3. Integrate

1. Read the robot's real topics (`ros2_query kind=topics`) and the tested templates in
   `${CLAUDE_SKILL_DIR}/../ad-r1m-robot/templates/` for this robot's topic remappings, the AB
   image preprocessing and the Nav2 values. Robot facts: `ad-r1m-robot` skill (ROBOT_SPEC.md,
   COMMON_FIXES.md). Never flip or rotate the ToF data.
2. Write the launch file (and any preprocessing node and parameter file), using the package's
   real node names and parameters.
3. After the user agrees: `slam action=deploy launch_file=... helpers={...} params_yaml=...`
   (deployed as `launch.py` by default), then `slam action=start template=deployed`.
4. `diagnostics target=slam`; on failure read `logTail` and the `ad-r1m-robot` skill's
   COMMON_FIXES.md.

## Examples

### Example 1: Which SLAM package fits?

User: "Which SLAM packages would work on my AD-R1M?"

1. `package_evidence`
2. Score each package; present score, verdict, blockers, evidence-backed reasons and gaps
3. Recommend the best fit (on AD-R1M usually RTAB-Map with the tested template, `ad-r1m-robot`)

### Example 2: A package from GitHub

User: "Could https://github.com/<org>/<repo> run on the robot?"

1. `package_evidence packages=[{name, repo}]`
2. Check CUDA, x86-only flags, the ROS 1/2 build type and the messages it uses against the
   robot's topics
3. If it fits and the user agrees: `setup_workspace package=<ros_package> repo=<url>`, then
   write and deploy the launch file

### Example 3: ORB-SLAM3

1. `setup_workspace package=orb_slam3_ros2` → `ready: false` (no rosdep rule, no binary)
2. `setup_workspace package=orb_slam3_ros2 repo=https://github.com/zang09/ORB_SLAM3_ROS2`
   builds it from source (package `orbslam3`)
