# ADI DataX&trade; — AD-R1M with Claude Code

A Claude Code plugin for the [AD-R1M](https://github.com/analogdevicesinc/ad-r1m-ros2) mobile robot platform. Three skills and an MCP server let Claude
bring up a robot, then run, check and tune SLAM and navigation on it over SSH. A desktop control
panel drives the same tools without a chat.

## What it does

- **Bringup** (`ad-r1m-bringup`) — flash the ADI Kuiper SD card, provision the robot, build the
  robot image and system package on the robot from the public ad-r1m-ros2 sources, connect,
  check health, and open RViz on your PC (pixi or native ROS 2).
- **SLAM and navigation** (`ad-r1m-robot`) — the tested RTAB-Map setup on ToF depth + AB image,
  Nav2 on `/scan` or the ToF point cloud, wheel drive (CANopen) and ToF clock faults, with the
  robot's specs, research-backed RTAB-Map parameters and known fixes.
- **SLAM package integration** (`ad-r1m-slam-integration`) — evaluate ROS 2 SLAM packages
  (ORB-SLAM3, MOLA, KISS-ICP, any git repository) from live robot and repository evidence, then
  install and integrate the chosen one.
- **Demo app** (`mcp-servers/ad-r1m-slam/demo-app/`) — a desktop control panel for the same
  workflows. See its [README](mcp-servers/ad-r1m-slam/demo-app/README.md).

Destructive or long actions (SD card flash, provisioning, image build) default to a dry run that
shows the plan for you to confirm.

## Requirements

On your PC:

- [Claude Code](https://claude.com/claude-code)
- Node.js 18+ (Linux, macOS or Windows; no SSH client needed, the server logs in with `ssh2`)
- The robot on the same network (Ethernet for a freshly flashed card, Wi-Fi once configured)
- For RViz: pixi, or native ROS 2 Humble with `rmw_zenoh_cpp`
- For SD card flashing: Linux with passwordless `sudo` for `dd`. On Windows and macOS the server
  downloads the image and you write it with Raspberry Pi Imager or balenaEtcher

## Install

```bash
git clone https://github.com/analogdevicesinc/dataX-collaterals.git
cd dataX-collaterals/applications/ad-r1m
npm ci                                    # the MCP server's dependencies
claude plugin marketplace add ./
claude plugin install datax@datax-ad-r1m
```

Restart Claude Code, then ask for example "Connect to my AD-R1M at ad-r1m-42" or "Start mapping
with RTAB-Map". The robot's SSH user and password default to the Kuiper defaults
(`analog` / `analog`).

## Layout

| Path | What |
|------|------|
| `skills/` | The three skills, their reference docs and the tested launch templates |
| `mcp-servers/ad-r1m-slam/` | The MCP server ([README](mcp-servers/ad-r1m-slam/README.md)): `server.mjs`, `lib/`, and `scripts/` that run on the robot |
| `mcp-servers/ad-r1m-slam/demo-app/` | Desktop control panel |
| `.claude-plugin/`, `.mcp.json`, `package.json` | Plugin manifest, local marketplace, MCP server registration and dependency |

## License

Apache-2.0
