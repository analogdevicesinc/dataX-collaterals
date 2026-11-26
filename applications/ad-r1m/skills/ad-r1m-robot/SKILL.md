---
name: ad-r1m-robot
description: Runs, tunes and troubleshoots the tested SLAM and Nav2 setup on an AD-R1M robot - RTAB-Map with the ADTF3175D ToF camera, Nav2 on /scan or the point cloud, wheel drive (CANopen) faults - and holds the robot's specs and research-backed RTAB-Map parameters. Use when the user wants to map, navigate, tune RTAB-Map or fix SLAM, TF, sensor or wheel problems on an AD-R1M. For choosing or integrating a different SLAM package use ad-r1m-slam-integration; for setup and connection use ad-r1m-bringup.
license: Apache-2.0
allowed-tools:
  - mcp__plugin_datax_ad-r1m__robot_status
  - mcp__plugin_datax_ad-r1m__ros2_query
  - mcp__plugin_datax_ad-r1m__diagnostics
  - mcp__plugin_datax_ad-r1m__slam
  - mcp__plugin_datax_ad-r1m__slam_set_params
  - mcp__plugin_datax_ad-r1m__nav
  - mcp__plugin_datax_ad-r1m__restart
  - mcp__plugin_datax_ad-r1m__setup_workspace
---

# AD-R1M Robot: SLAM, Nav2 and troubleshooting

The robot must be selected (`connect_robot`) and `robot_status` must report `state: ready`.
If not, use the `ad-r1m-bringup` skill first.

## Rules

1. **No GPU packages**: the Raspberry Pi 5 has no CUDA GPU.
2. **Never flip or rotate the ToF images or point cloud.** The camera is mounted inverted and
   the TF `base_link -> cam1_adtf31xx_optical` already models it; flipping maps the floor as
   obstacles.
3. **`Grid/RayTracing` stays `false`**: with the raised, narrow-FOV (75°) camera it clears
   obstacles the camera no longer sees.
4. **A running robot container does not mean the wheels work.** Check `robot_status.drives`
   (see "Wheel drives" below).
5. **Ask the user before deploying or starting anything on the robot.**

Specs: [ROBOT_SPEC.md](ROBOT_SPEC.md). Research and parameter rationale:
[RTAB_RESEARCH.md](RTAB_RESEARCH.md). Known problems and fixes:
[COMMON_FIXES.md](COMMON_FIXES.md).

## Map with RTAB-Map (tested setup)

1. `robot_status`: `state: ready`, `sensors.tof` and `sensors.odometry` true, `drives.healthy` true.
2. `setup_workspace` (default `package=rtabmap_ros`) until `ready: true`. On a robot that has
   the shared `robot-slam` image this takes about a minute.
3. `slam action=start` deploys the tested default template as `launch.py` and starts it:
   - `template=depth_rgb` (default): ToF depth + the AB (amplitude) image as RGB, visual
     registration, odometry from TF. The best setup.
   - `template=depth_pointcloud`: adds the ToF point cloud for ICP. Only when the user asks
     for it; it still has older parameters (see its docstring).
4. `diagnostics target=slam`: `started` SLAM nodes, `/map` publisher, `hz` for `/scan`,
   `/cam1/point_cloud`, `/odometry/filtered`, and `tf` `map->odom=ok`.
5. Optionally `rviz action=start` (see `ad-r1m-bringup`).

`slam action=stop` stops it. The tested templates are mapping-only: reloading a
database they wrote aborts RTAB-Map (`Memory::loadDataFromDb`, empty descriptors).

To read a template before changing it (the parameter values and why are in its docstring):

```bash
cat ${CLAUDE_SKILL_DIR}/templates/rtabmap_depth_rgb_launch.py
```

A custom launch file goes through `slam action=deploy launch_file=... helpers={...}
params_yaml=...`, then `slam action=start template=deployed`. The previous version of each
file is kept as `<file>.prev` in the `slam_integration` package.

### Reading `diagnostics target=slam`

| Measurement | Problem | What to do |
|---|---|---|
| `slamNodes` empty | SLAM not running | `slam action=start`; if `started` is false, read `logTail` |
| `publishers./scan` 0 | No laser scan | Check `depthimage_to_laserscan` in the robot container |
| publisher > 0 but `hz` 0 | Publisher with no messages in 6 s | `/cam1/point_cloud`: first `ros2_query kind=params name=/cam1/adi_3dtof_adtf31xx_node`; `param_enable_point_cloud_publish: false` is a config choice, not a fault (COMMON_FIXES.md Issue 10), and only `depth_pointcloud` / `nav action=start_pointcloud` need it. Otherwise the ToF node or EKF inputs stalled: `restart target=tof` for the camera |
| `tf.odom->base_link` missing | No odometry TF | robot_localization EKF / wheel odometry |
| `tf.map->odom` missing | SLAM not publishing its TF yet | Wait for the first map update, else check the launch log |
| `drives.healthy` false | Wheel controllers down | "Wheel drives" below |
| `tofClock.ok` false (`offsetS` far from 0) | ToF stamps on a stale camera time base: topics and rates look fine, but TF, RTAB-Map and the costmaps drop every scan (RViz: "earlier than all the data in the transform cache") | Typical after a power cycle. If `robotNtp` is false, wait for it. Then `restart target=tof` (its output repeats `tofClock`), then check drives (COMMON_FIXES.md Issue 14) |

### Tuning

The tested values are in the template. To change one at runtime (lost on restart):
`slam_set_params params={"Rtabmap/DetectionRate": "1.0"}`. RTAB-Map parameters are strings;
the tool reports per parameter whether `/rtabmap` accepted it. To keep a change, edit the
launch file and redeploy.

From `diagnostics.rtabmap` (`cpu_percent`, `mem_percent` of the rtabmap process):

| Observation | Change | Why |
|---|---|---|
| CPU above ~70% | `Vis/MaxFeatures` 400 -> 150-200, `Rtabmap/DetectionRate` down | Fewer features and updates per second |
| Memory above ~50% | `Rtabmap/MemoryThr` 300 -> 200 | Fewer nodes in working memory |
| No loop closures in a revisited area | Check `RGBD/ProximityBySpace` is `true` (template default) | Narrow FOV needs proximity detection |
| Obstacles vanish when the robot turns | `Grid/RayTracing` must be `false` | COMMON_FIXES.md Issue 6 |
| False obstacles far away on the floor | Lower `Grid/RangeMax` (template: 2.0) | ToF floor noise grows with range |

Keep `Mem/ImagePreDecimation` and `Mem/ImagePostDecimation` equal: post 2 with pre 1 stores
256x256 AB next to 512x512 depth and RTAB-Map drops `Vis/DepthAsMask`.

## Nav2

- `nav action=start`: the robot's Nav2 on `/scan`.
- `nav action=start_pointcloud`: Nav2 on the ToF point cloud. The raw 512x512 cloud is too
  heavy for the costmaps on the RPi 5, so `nav_cloud_filter.py` strides it to
  `/cam1/point_cloud_nav` at 5 Hz. Plain `nav action=start` restores the stock command.
- `diagnostics target=nav`: each of `/controller_server`, `/planner_server`,
  `/behavior_server`, `/bt_navigator` should be `active`; `/global_costmap/costmap` needs a
  publisher, which needs `/map` (from RTAB-Map or the robot's slam_toolbox). If the lifecycle
  nodes are not active, restart nav after SLAM publishes the map.

## Driving the robot

The robot's own `teleop_keyboard` compose service (profile `oneoff`) drives it and toggles the
kill switch. It reads single keypresses, so the user runs it in their own terminal:

```bash
ssh -t analog@<robot>.local
cd ~/demo   # the active config folder (robot_config action=active)
docker compose --env-file ad-r1m.env run --rm teleop_keyboard
```

1. `p`: activate the kill switch. Driving stays disabled until this is pressed once.
2. `r`: reset the kill switch and enable the motors.
3. `u i o / j k l / m , .` to drive. Limits come from `ros_data/teleop_parameters.yaml`
   (`max_vel` 0.5 m/s, `max_rot` 1.0 rad/s by default).

A teleop on the PC (`pixi run ros2 run teleop_twist_keyboard teleop_twist_keyboard`) only
publishes `/cmd_vel` and cannot reset the kill switch, so it does nothing on its own.
The RC transmitter (`crsf_node`) also works. Remind the user the robot will move,
and suggest driving only when they ask; it drives during mapping too.

## Wheel drives

A failed CANopen drive boot leaves the robot container running, and the EKF still publishes
`odom -> base_link` from the IMU, so containers and TF look fine. `robot_status.drives` (also
in `diagnostics`) checks what matters: `joint_state_broadcaster` and `diff_drive_controller`
active, and a `/joint_states` publisher. When unhealthy it adds the drive log and the CAN
heartbeats (`canBus`: `drive_right` 0x14, `drive_left` 0x16).

**Do not diagnose from `driveLog` alone**: a healthy boot logs some of the same lines.

Fix in this order (details in COMMON_FIXES.md, Issue 11):

1. `restart target=stack` (bringup stop, `compose --env-file ad-r1m.env down`, bringup start:
   fresh containers re-run the drive boot). Right after a restart, wait ~30 s before checking
   again. Never use `compose stop` + `start` by hand.
2. `restart target=slcan`: the same with can0 and all drives reset while the stack is down,
   then reports which nodes answer. Restarts drop running SLAM / Nav2 (`not_restarted`):
   start them again with `slam` / `nav`.
3. Read `canBus`: a missing 0x14/0x16 is power or cable; a node at 0x17 is an ADRD3161 on its
   factory DIP setting (set S2 to 110 for left, 100 for right, power-cycle).
4. Drives boot but the joints never activate: the TMC9660 is untuned (COMMON_FIXES.md).

Other hardware units: `restart target=crsf` (RC receiver), `imu` (`/imu` silent), `tof` (ToF
topics silent, or stale stamps with `tofClock.ok` false; `unit` output says if the camera at
192.168.56.1 is unreachable). Every restart reports `tofClock`.

## Looking around

`ros2_query` reads without changing anything: `kind=topics` (with types), `nodes`,
`topic_info name=/scan`, `params name=/rtabmap`, `logs name=ad-r1m-robot-1`,
`read_file path=/ros2_ws/src/slam_integration/launch/launch.py` (SLAM container) or
`target=host path=~/demo/compose.yaml`.

For anything else, use SSH from Bash (`ssh analog@<robot>`), which asks the user as usual.

## Examples

### Example 1: Map a room

User: "Start mapping with RTAB-Map on ad-r1m-18"

1. `robot_status` -> ready, drives healthy
2. `setup_workspace` -> `ready: true`
3. Confirm, then `slam action=start`, then `diagnostics target=slam`
4. Optionally `rviz action=start`

### Example 2: Obstacles disappear from the map

1. `ros2_query kind=params name=/rtabmap` and check `Grid/RayTracing`
2. If it is `true`: confirm, then redeploy the tested template (`slam action=start`)

### Example 3: No wheel TF in RViz

1. `robot_status`: `drives.healthy` false, `detail` says why
2. Follow "Wheel drives", starting with `restart target=stack`
