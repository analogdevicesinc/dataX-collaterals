# AD-R1M MCP server

Lets Claude connect to, provision, check and run SLAM / Nav2 on an
[AD-R1M](https://github.com/analogdevicesinc/ad-r1m-ros2) robot over SSH. How to use the
tools is in the skills: `ad-r1m-bringup`, `ad-r1m-robot` and `ad-r1m-slam-integration`
(`skills/` in this plugin).

## Layout

| Path | What |
|------|------|
| `server.mjs` | MCP stdio server: the 16 tools, their schemas and annotations |
| `lib/ssh.mjs` | Selected robot, sshpass, SSH failure classification, script runner |
| `lib/robot.mjs` | Tools that run on the robot (status, SLAM, Nav2, restart, workspace, provisioning) |
| `lib/image.mjs` | `build_robot_image` |
| `lib/local.mjs` | Tools that run on the PC: `kuiper_sd_card`, `rviz` |
| `lib/evidence.mjs` | `package_evidence` |
| `scripts/*.sh` | What runs on the robot (`pc-sd.sh` on the PC). The robot knowledge and its gotchas live here as comments |

Each robot call sends `scripts/lib.sh` plus the tool's script over SSH and runs it as a temp
file with the tool's arguments as `"$@"`: arguments are never pasted into script text, and
secrets (sudo password, Cloudsmith token, Wi-Fi password) go on stdin and are masked in the
output. ROS commands run in the robot's containers through `rosx` (`scripts/lib.sh`).

The templates the tools deploy (RTAB-Map, Nav2 point cloud, RViz layout) are in
`skills/ad-r1m-robot/templates/`; `package_evidence` reads
`skills/ad-r1m-slam-integration/catalog.json` and the research docs.

## Install

Installing the `datax` plugin starts this server. Claude Code installs its one dependency
(`@modelcontextprotocol/sdk`, from the plugin's `package.json` and `package-lock.json`)
into the installed plugin copy. On the PC it needs:

- Node.js 18+
- `sshpass` (e.g. `sudo apt install sshpass`)
- For RViz: pixi, or native ROS 2 Humble with `rmw_zenoh_cpp`
- For `kuiper_sd_card`: Linux with passwordless sudo for `dd`

Without these only this server's tools fail; the other datax skills are unaffected.

When developing from a local checkout (a directory marketplace runs the plugin from the
source folder), install the dependency once:

```bash
cd applications/ad-r1m && npm ci
```

There is no build step. After editing, restart Claude Code (`/reload-plugins` does not always
restart a running MCP server).

## Configuration

| Variable | Default |
|----------|---------|
| `ROBOT_HOST` | none: ask the user, then `connect_robot` |
| `ROBOT_USER` / `ROBOT_PASSWORD` | `analog` / `analog` (Kuiper defaults) |
| `CLOUDSMITH_USER` / `CLOUDSMITH_TOKEN` | none; `provision_robot` also takes them per call. Never logged |
| `ROS_DISTRO` | `humble` |
| `DOCKER_IMAGE` | `docker.cloudsmith.io/adi/adrd-common/ad-r1m:robot-$ROS_DISTRO` |
| `SLAM_IMAGE` | `DOCKER_IMAGE` with tag `robot-slam` |
| `ROS_CONTAINER` / `SLAM_CONTAINER` | detected / `slam_workspace` |
| `RMW_IMPLEMENTATION` | `rmw_zenoh_cpp` (for the SLAM container) |
| `GITHUB_TOKEN` | none; raises `package_evidence`'s GitHub API limit (60 requests/h) |

The robot selected with `connect_robot` (or a tool's `host` argument) is saved to
`~/.config/ad-r1m-slam/selected-robot.json` (mode 0600, includes the SSH password) and restored
when the server restarts. `ROBOT_HOST` takes precedence; `AD_R1M_SELECTED_ROBOT_FILE` changes the
file. Caches (repo clones, Kuiper download state, RViz and pixi logs) are under
`~/.cache/ad-r1m-slam`.

SSH host keys are not recorded: a reflashed robot keeps its hostname but gets a new key, and a
stale key makes OpenSSH refuse the password login sshpass needs.

## Demo app

`demo-app/` is a desktop control panel (Python/tkinter, DataX design system) that drives the robot
through this server. See [demo-app/README.md](demo-app/README.md).

## Without the plugin

```bash
cd applications/ad-r1m && npm ci
claude mcp add ad-r1m-slam -- node /path/to/applications/ad-r1m/mcp-servers/ad-r1m-slam/server.mjs
```

## License

Apache-2.0
