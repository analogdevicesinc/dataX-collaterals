---
name: ad-r1m-bringup
description: Brings up an AD-R1M robot - flashes the ADI Kuiper SD card, provisions the robot with or without Cloudsmith credentials (building the robot image and system package from source when needed), connects to it, checks its health, and opens RViz on the user's PC with pixi or native ROS 2. Use when the user sets up a new or reflashed AD-R1M, connects to a robot, installs or rebuilds the robot image or system package, has no Cloudsmith credentials, or wants to see the robot in RViz.
license: Apache-2.0
allowed-tools:
  - mcp__plugin_datax_ad-r1m__connect_robot
  - mcp__plugin_datax_ad-r1m__robot_status
  - mcp__plugin_datax_ad-r1m__ros2_query
  - mcp__plugin_datax_ad-r1m__restart
  - mcp__plugin_datax_ad-r1m__robot_config
  - mcp__plugin_datax_ad-r1m__collect_support_bundle
  - mcp__plugin_datax_ad-r1m__rviz
---

# AD-R1M Bringup

For SLAM and navigation after bringup, use `ad-r1m-robot`; for a different SLAM package,
`ad-r1m-slam-integration`.

## Background

The AD-R1M runs ADI Kuiper Linux on a Raspberry Pi 5. Its ROS 2 software runs in Docker
containers started by the `ad-r1m-bringup` systemd service (`docker compose up` in the active
config folder). Two pieces normally come from ADI's Cloudsmith repository, which needs a
service user and token:

| Piece | From Cloudsmith | Without credentials |
|-------|-----------------|---------------------|
| `ad-r1m-system-rpi5` apt package (systemd services, compose config, `ad-r1m` CLI) | `provision_robot install_system_package=true` | `build_robot_image system_package=true`, then `action=install_system_package` |
| Robot image `docker.cloudsmith.io/adi/adrd-common/ad-r1m:robot-humble` | `provision_robot docker_image=true` | `build_robot_image` |

`build_robot_image` builds on the robot from the latest
[ad-r1m-ros2](https://github.com/analogdevicesinc/ad-r1m-ros2) release the way the release CI
does (`docker/Dockerfile`, target `runner`, `BUILD_PACKAGES=ad_r1m_robot`) and tags it with the
name the compose file expects, so nothing else changes. About 10-30 minutes (1.0.0 took 9 on a
Pi 5) and about 15 GB free.

RViz runs on the user's PC and joins the robot's Zenoh router (`tcp/<robot>:7447`,
`rmw_zenoh_cpp`). The AD-R1M docs recommend a pixi workspace with RoboStack's ROS 2 Humble
(Linux, macOS, Windows); native ROS 2 Humble on Ubuntu also works.

## Instructions

`kuiper_sd_card` flash, `provision_robot`, `build_robot_image` and `rviz action=setup` default
to a dry run (or need confirmation). You MUST show the plan to the user and get explicit
confirmation before calling them with `dry_run=false`. They are deliberately not pre-allowed,
so each call also asks for permission.

### Step 1: Check the user's PC

The MCP server runs on the user's PC and reaches the robot over SSH. It needs Node.js 18+,
`sshpass` (e.g. `sudo apt install sshpass`; tools report `sshpass_missing` without it), and the
robot on the same network (Ethernet for a fresh image, Wi-Fi once configured).

### Step 2: Connect

Ask for the robot's hostname and SSH password: `analog` / `analog.local` for a freshly flashed
image, `ad-r1m-<N>` for a configured robot; default user and password `analog` / `analog`.
Call `connect_robot`. Its `state` decides the next step:

| State | Meaning | Next |
|-------|---------|------|
| `unreachable` | Not on the network, still booting (~60 s), or no SD card | Step 3 if the card needs flashing; else check power (LED ring solid green) and cabling |
| `ssh_auth_failed` | Wrong user or password | Ask the user again |
| `fresh_kuiper` | Kuiper booted (hostname `analog`), AD-R1M software not installed | Step 4 |
| `no_stack` | Configured, no system package | Step 4, package only |
| `stack_stopped` | Installed, containers not running | Step 6: `robot_status detail=full` (is `ad-r1m-bringup` active?), `restart target=stack` |
| `ready` | Robot is up | Step 6 |

### Step 3: Flash the SD card (on the PC)

1. `kuiper_sd_card action=download`, then poll `action=status` (2.3 GB).
2. `kuiper_sd_card action=list_devices`: only removable disks without this PC's system mounts.
3. `kuiper_sd_card action=flash device=<dev>` (dry run). Tell the user which card will be
   ERASED, including what it holds now, and confirm before `dry_run=false`. Ask for the
   Wi-Fi the robot should join (no default) and pass `wifi={ssid, password}`, or add it later
   with `action=add_wifi`; without it the robot is only reachable over Ethernet.
4. When `flash.exitCode` is 0: card into the robot, power on, wait about 2 minutes, then
   `connect_robot host=analog.local password=analog`.

### Step 4: Provision

Ask for the new hostname (`ad-r1m-<number>`), Wi-Fi if needed, and whether the user has
Cloudsmith credentials.

**With credentials**: `provision_robot` with hostname, upgrade, `install_system_package`,
`docker_image`, `demo_config`, `reboot` and `cloudsmith={user, token}`. Dry run first.

**Without credentials**:
1. `provision_robot` with hostname, upgrade and reboot. Dry run first.
2. `build_robot_image action=start system_package=true` (dry run). Show the plan: release tag,
   apt packages to add, free disk, steps. If prerequisites are missing, call again with
   `install_prerequisites=true` after the user agrees (it uses sudo).
3. Poll `build_robot_image action=status` every few minutes until `exitCode` is 0. A non-zero
   `exitCode` comes with a `reason`; fix it and start again (BuildKit reuses finished layers).
4. `build_robot_image action=install_system_package` (dry run, confirm), then
   `provision_robot reboot=true`.
5. `provision_robot demo_config=true`: creates `~/demo` from ad-r1m-ros2 `main`, enables it
   (`ad-r1m enable`) and restarts `ad-r1m-bringup`. If it returns `warnings` about the config
   and image refs, rebuild the image from the same ref (`build_robot_image ref=main`) or pass
   `config_ref=<image's release>`. Mismatched refs break the `/scan` frame (`ad-r1m-robot`
   skill, COMMON_FIXES.md Issue 13).

After `provision_robot` the selected robot follows the new hostname. If `robot` says it did
not come back within 4 minutes, ask the user for its current hostname or IP and
`connect_robot`.

Never ask the user to paste credentials into a file in the repository. Pass them to the tool,
or set `CLOUDSMITH_USER` / `CLOUDSMITH_TOKEN` for the MCP server.

### Step 5: Rebuild only the image

For a set-up robot whose image is missing or outdated (e.g. `setup_workspace` says the robot
image is not on the robot): `build_robot_image action=start`, poll `action=status`. Use
`ref=<tag>` for a specific release. Building replaces the existing image of that name.

### Step 6: Check health

1. `robot_status`: state, containers, sensor flags and `drives`. `drives.healthy` false means a
   CANopen drive did not boot even though the container runs: `ad-r1m-robot` skill, "Wheel
   drives".
2. `robot_status.tofClock.ok` must be true. After a power cycle the ToF can publish with stamps
   minutes old (`offsetS`): RViz then shows no scan and SLAM gets nothing although every topic
   is listed. Fix: `restart target=tof` once `robotNtp` is true (`ad-r1m-robot` skill,
   COMMON_FIXES.md Issue 14).
3. `robot_status.topics` should include `/cam1/depth_image`, `/cam1/point_cloud`, `/imu`,
   `/odometry/filtered` and `/scan`.
4. `robot_status detail=full` adds the `ad-r1m-*` services, packages, images, network, disk and
   temperature.
5. If something is wrong: `ros2_query kind=logs name=ad-r1m-robot-1`, `robot_config
   action=active` (which config folder the robot boots with), or `collect_support_bundle` to
   send to support.

### Step 7: RViz on the PC

1. `rviz action=status`: is pixi (workspace `~/pixiws`) or native ROS 2 available?
2. If neither:
   - pixi missing: ask the user to install it. Linux/macOS:
     `curl -fsSL https://pixi.sh/install.sh | sh`. Windows PowerShell:
     `powershell -ExecutionPolicy Bypass -c "irm -useb https://pixi.sh/install.ps1 | iex"`.
     Then reopen the terminal.
   - Then, after the user agrees, `rviz action=setup`: `ros-humble-desktop`,
     `ros-humble-rmw-zenoh-cpp`, `ros-humble-teleop-twist-keyboard` and
     `ros-humble-nav2-rviz-plugins` from `robostack-humble` and `conda-forge`, about 2 GB. Poll
     `action=status` until `pixi.ready` is true.
3. `rviz action=start` opens the plugin's layout and stores the robot in the pixi workspace's
   activation env, so `pixi run rviz2` there works by hand later.
4. Empty displays: the PC can't reach `tcp/<robot>:7447`; check the network and `robot_status`
   (the `zenoh` container).

Manual equivalent (AD-R1M docs), in the workspace folder:

```bash
pixi workspace activation env set RMW_IMPLEMENTATION="rmw_zenoh_cpp"
pixi workspace activation env set ZENOH_CONFIG_OVERRIDE="connect/endpoints=['tcp/ad-r1m-123.local:7447'];mode='client'"
pixi run rviz2
```

To drive the robot from the keyboard, use the robot's `teleop_keyboard` service, which also
resets the kill switch (`ad-r1m-robot` skill, "Driving the robot"). The PC's
`pixi run ros2 run teleop_twist_keyboard teleop_twist_keyboard` only publishes `/cmd_vel` and
does nothing until the kill switch is reset. Only suggest driving when the user wants to drive,
and remind them the robot will move.

## Examples

### Example 1: New robot, no Cloudsmith credentials

User: "I just flashed a new SD card for my AD-R1M, I don't have Cloudsmith credentials"

1. `connect_robot host=analog.local password=analog` → `fresh_kuiper`
2. Ask for the hostname (e.g. `ad-r1m-42`) and Wi-Fi
3. `provision_robot` hostname + upgrade + reboot: dry run, confirm, run
4. `build_robot_image action=start system_package=true`: dry run, confirm, run, poll
5. `build_robot_image action=install_system_package`: confirm, then reboot
6. `provision_robot demo_config=true`, then `robot_status` → ready

### Example 2: See the robot in RViz from Windows

User: "Show me what my robot ad-r1m-18 sees"

1. `connect_robot host=ad-r1m-18`
2. `rviz action=status`: no pixi, so give the PowerShell install command
3. `rviz action=setup` after the user agrees; poll until ready
4. `rviz action=start`

### Example 3: SLAM setup fails because the image is missing

User: "setup_workspace says the robot image is not on the robot"

1. Ask whether they have Cloudsmith credentials
2. With: `provision_robot docker_image=true cloudsmith={...}`
3. Without: `build_robot_image action=start`, then poll status
4. Retry `setup_workspace`
