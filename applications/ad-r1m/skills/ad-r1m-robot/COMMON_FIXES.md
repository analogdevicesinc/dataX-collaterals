# Common AD-R1M SLAM Integration Fixes

Parameter values below refer to the tested default template
`templates/rtabmap_depth_rgb_launch.py`; its docstring says why each one was chosen. The
research behind them is in RTAB_RESEARCH.md.

## Contents

- [Issue 1: Encoding Mismatch](#issue-1-encoding-mismatch)
- [Issue 2: Map Upside-Down or Obstacles at Wrong Positions](#issue-2-map-upside-down-or-obstacles-at-wrong-positions)
- [Issue 3: Synchronization Timeout](#issue-3-synchronization-timeout)
- [Issue 4: Out of Memory (OOM)](#issue-4-out-of-memory-oom)
- [Issue 5: Missing TF Transform](#issue-5-missing-tf-transform)
- [Issue 6: Map Clearing Obstacles (Ray Tracing)](#issue-6-map-clearing-obstacles-ray-tracing)
- [Issue 7: Poor Loop Closure (Narrow FOV)](#issue-7-poor-loop-closure-narrow-fov)
- [Issue 8: High CPU Usage](#issue-8-high-cpu-usage)
- [Issue 9: Inaccurate Ground/Obstacle Segmentation](#issue-9-inaccurate-groundobstacle-segmentation)
- [Issue 10: Point Cloud Not Publishing](#issue-10-point-cloud-not-publishing)
- [Issue 11: No Wheel TF (drives failed to boot)](#issue-11-no-wheel-tf-drives-failed-to-boot)
- [Issue 12: Bringup Fails With "mkdir .../ros_data/log: file exists"](#issue-12-bringup-fails-with-mkdir-ros_datalog-file-exists)
- [Issue 13: RViz Drops Every Scan (frame `/cam1_scan`)](#issue-13-rviz-drops-every-scan-frame-cam1_scan)
- [Quick Diagnostic Checklist](#quick-diagnostic-checklist)
- [Template Quick Reference](#template-quick-reference)

## Issue 1: Encoding Mismatch

### Error
```
[rtabmap-1] [ERROR] Input rgb/left type must be image=mono8,mono16,bgr8,bgra8,rgb8,rgba8
[rtabmap-1] current=16UC1
```

### Cause
The ToF camera publishes `16UC1`; SLAM packages expect standard encodings like `mono16`. Same
16-bit data, different label.

### Fix
`templates/image_preprocess.py` relabels the depth image and converts the AB (amplitude)
image. The raw AB image is ~13-bit with a median near 80, so used as mono16 it looks black
and every loop closure is rejected with 0 inliers: the node log-scales it to mono8
(saturating at 8191).

```bash
cat ${CLAUDE_SKILL_DIR}/templates/image_preprocess.py
```

---

## Issue 2: Map Upside-Down or Obstacles at Wrong Positions

### Error
Map appears upside-down or mirrored, or the floor is mapped as obstacles.

### Cause
The images or cloud were flipped or rotated somewhere. The ADTF3175D optical frame is upside
down and the camera is mounted upside down; the TF `base_link -> cam1_adtf31xx_optical`
already models the mount, so the published data is already correct.

### Fix
- Remove any `cv2.flip` / `cv2.rotate` from preprocessing nodes (the templates do none)
- Do not add static transforms that rotate the camera frame

Check the TF instead: `ros2 run tf2_ros tf2_echo base_link cam1_adtf31xx_optical`.

---

## Issue 3: Synchronization Timeout

### Error
```
[rtabmap-1] [WARN] Did not receive data since 5 seconds!
[rtabmap-1] Make sure the input topics are published and that QoS matches
```

### Cause
Preprocessing adds latency (~10-50 ms per node), so processed images no longer line up with
`camera_info` within the default sync tolerance.

### Fix
```python
parameters=[{
    'approx_sync': True,
    'approx_sync_max_interval': 0.1,  # 100 ms tolerance (default ~30 ms)
    'queue_size': 30,                  # larger buffer (default 10)
}]
```

Or do all image conversion in a single node to reduce latency.

---

## Issue 4: Out of Memory (OOM)

### Error
```
[rtabmap-1] std::bad_alloc
Killed
```

### Cause
RTAB-Map uses too much RAM on the Raspberry Pi 5 (8 GB, shared by every robot container).
Without limits it used ~3.6 GB on a 300 m trajectory (Muravyev & Yakovlev, 2022, simulated).

### Fix
The template bounds memory with `Rtabmap/MemoryThr: 300` (nodes in working memory) and
`Rtabmap/TimeThr: 700` (ms). If it still runs out: lower `Rtabmap/MemoryThr` (e.g. 200) and
`Vis/MaxFeatures` (400 -> 200). Fewer features weaken loop closure.

---

## Issue 5: Missing TF Transform

### Error
```
[rtabmap-1] Could not find a connection between 'cam1_adtf31xx_optical' and 'base_link'
```

### Cause
The camera transform comes from the URDF (`ad_r1m_description`) via `robot_state_publisher`
in the robot container: `base_link → cam1_adtf31xx → cam1_adtf31xx_optical` (and `cam1_scan`
for `/scan`).

### Fix
```bash
ros2 run tf2_ros tf2_echo base_link cam1_adtf31xx_optical
```

If missing, the robot container (`ad-r1m-robot-1`) is down or `robot_state_publisher` failed:
`robot_status`, `ros2_query kind=logs name=ad-r1m-robot-1`, then `restart target=stack`. Do
NOT publish your own static transform for the camera: the URDF already models the inverted
mount. Check the launch file uses these frame names (not `camera_link`).

---

## Issue 6: Map Clearing Obstacles (Ray Tracing)

### Problem
Obstacles disappear from the map when the robot turns away from them.

Labbé & Michaud (2019): with cameras mounted above the ground, 2D ray tracing clears obstacles
once the camera no longer sees them; if the camera cannot be lowered, "using 2D local occupancy
grids without ray tracing would then be safer".

### Cause
Ray tracing marks cells free when rays pass through them. With a 75° FOV, previously seen
obstacles are cleared when they leave the view.

### Fix (CRITICAL)
```yaml
Grid/RayTracing: false  # mandatory for the AD-R1M's narrow-FOV ToF camera
```

---

## Issue 7: Poor Loop Closure (Narrow FOV)

### Problem
75° FOV → fewer visual features → weak loop closure. Labbé & Michaud (2019): "The limited field
of view of the front facing RGB-D camera was also a problem during navigation."

### Fix 1: Proximity detection
The template already sets `RGBD/ProximityBySpace: true`, `RGBD/NeighborLinkRefining: true`
and `RGBD/LoopClosureReextractFeatures: true`. Keep `RGBD/OptimizeMaxError` at 3.0 (the
RTAB-Map default): 1.0 rejected valid loops on ad-r1m-18. If closures are rejected with 0
inliers, check the AB image is not black (Issue 1).

### Fix 2: Point cloud assembler
Accumulates clouds for wider coverage:
```python
Node(
    package='rtabmap_util',
    executable='point_cloud_assembler',
    parameters=[{
        'max_clouds': 20,
        'fixed_frame_id': 'odom',
        'voxel_size': 0.05,
        'circular_buffer': True,
    }]
)
```

### Fix 3: ICP on the point cloud
The visual + ICP template adds the ToF cloud for geometric registration
(`slam action=start template=depth_pointcloud`). Geometric matching copes with the narrow
FOV, but appearance-based loop closure is weaker and ICP can fail in corridors (use
`Icp/PointToPlaneMinComplexity: 0.02`). This template was last tuned before the depth_rgb
fixes (feature type, decimation, odometry from TF), so re-test it.

---

## Issue 8: High CPU Usage

### Problem
CPU maxed out, SLAM slow.

Kunchala et al. (2026), on an RPi 4B: RTAB-Map 65-80% CPU, GMapping 40-50%, Cartographer
50-70%. On the RPi 5 with the template: ~13% CPU at 2 Hz (ad-r1m-18).

### Fix
Levers, in order (`slam_set_params` to try at runtime):

```yaml
Rtabmap/DetectionRate: 1.0     # template 2.0
Vis/MaxFeatures: 200           # template 400; 150 for the most headroom
Kp/MaxFeatures: 75
Rtabmap/MemoryThr: 200         # template 300
RGBD/LoopClosureReextractFeatures: false
```

Keep pre and post image decimation equal (Issue 9 / the template docstring).

---

## Issue 9: Inaccurate Ground/Obstacle Segmentation

### Problem
Ground marked as obstacles (often far floor patches), or obstacles merged with the ground.

### Causes
1. Grid parameters not tuned for the ToF camera's height and noise
2. ToF depth bias at range
3. `Grid/MaxGroundAngle` too strict for an uneven floor

### Diagnostic
```bash
ros2 topic hz /cloud_ground /cloud_obstacles
# In RViz: PointCloud2 /cam1/point_cloud (white), /cloud_ground (green), /cloud_obstacles (red)
```

### Fix
Tested values (template) and which way to move them:

| Parameter | Template | Effect |
|---|---|---|
| `Grid/RangeMax` | 2.0 | 3.0 -> 2.0 removed false far-floor obstacles; ToF max is 4.0 |
| `Grid/RangeMin` | 0.3 | ToF spec range starts at 0.4 m |
| `Grid/MaxGroundHeight` | 0.08 | Height above base_link still counted as ground |
| `Grid/FlatObstacleDetected` | false | true made floor patches offset by ToF bias into obstacles |
| `Grid/MinClusterSize` | 20 | Higher filters more small noise clusters |
| `Grid/MaxGroundAngle` | 30 | Max slope counted as ground (normals mode only) |
| `Grid/MaxObstacleHeight` | 1.5 | Filters ceiling reflections |
| `Grid/NormalK` | 10 | Higher = smoother normals, slower |
| `Grid/NoiseFilteringRadius` / `MinNeighbors` | 0.1 / 3 | Removes isolated points |

---

## Issue 10: Point Cloud Not Publishing

### Problem
`/cam1/point_cloud` is at 0 Hz or missing.

### Diagnostic
```bash
ros2 topic list | grep point_cloud
ros2 topic hz /cam1/point_cloud
ros2 node list | grep adtf
```

### Causes
1. `param_enable_point_cloud_publish: False` in the ToF launch parameters
2. Camera connection (`restart target=tof` reports if 192.168.56.1 is unreachable)
3. Memory or CPU exhaustion

### Fix
In the ToF launch parameters (`aditof_bringup.launch.py`):
```python
parameters=[{
    'param_enable_point_cloud_publish': True,
    'param_enable_depth_publish': True,
    'param_enable_ab_publish': True,
}]
```

---

## Issue 11: No Wheel TF (drives failed to boot)

### Problem
RViz shows no transform from `left_wheel`/`right_wheel` to `odom`, or the robot does not move,
while the robot container is up.

### Cause
A CANopen drive failed its SDO boot, so `controller_manager` never activated the controllers:

```
drive fails SDO boot
  → controller_manager never activates controllers
  → spawners loop "Could not contact service /controller_manager/list_controllers"
  → /joint_states has 0 publishers
  → robot_state_publisher cannot compute wheel joint angles
  → no left_wheel/right_wheel → odom TF
```

Container checks miss this, and the EKF keeps publishing `odom → base_link` from the IMU, so
TF checks look healthy too.

### Diagnostic
`robot_status.drives` (also in `diagnostics`). Healthy: `joint_state_broadcaster` and
`diff_drive_controller` active (an inactive `forward_velocity_controller` is normal), and at
least one `/joint_states` publisher. By hand:

```bash
ros2 control list_controllers
ros2 topic info /joint_states | grep 'Publisher count'
```

**Do not diagnose this from the container log.** A healthy boot logs `Wait for device to
boot...` and a transient `Could not read from SDO because driver not activated` for
`drive_left`; `drive_right` logs no boot message at all even when healthy. Only `drive_left`
ever logs `Driver booted and ready`.

### Fix, in escalation order

1. `restart target=stack`: compose `stop` + `start`, not `down` + `up -d` (`down` removes the
   containers; `start` alone is a no-op on a running container). This re-runs the entrypoints
   and the drive boot, and clears the normal case. Wait ~30 s before checking again.
2. If it recurs, `restart target=slcan`: re-runs `ad-r1m-slcan.service` (NMT-resets every
   drive, power-cycles the slcan adapter MCU, recreates `can0`) with the `robot` and `motors`
   services stopped around it, then reports `can0` and the nodes sending heartbeats. A drive
   whose heartbeat already shows OPERATIONAL does not re-announce on restart, which points at
   a startup race (check `boot_timeout_ms` in `bus.yml`) rather than hardware.
3. Read the node list (`canBus`): `drive_right` 0x14 (heartbeat `0x714`), `drive_left` 0x16
   (`0x716`), `05` = OPERATIONAL.
   - **A drive with no heartbeat is a hardware fault** that no restart clears. The log shows
     `[drive_left]: Boot failed after 3 attempts`, then `ros2_control_node` dies with
     `ros2_canopen::DriverException`. Check its power connector/fuse, the e-stop and its CAN
     cable. Seen on ad-r1m-18 with `drive_left` unpowered: 0x714 and node 2 (0x702)
     answered, 0x716 never did.
   - **A node at 0x17**: an ADRD3161 on its factory DIP setting. Node ID = 0x10 + DIP switch S2
     (bits 1-2-3, switch 1 = MSB, read at boot only; no LSS, no software override). Set 110 for
     left (0x16), 100 for right (0x14), then power-cycle.
   - Bus errors: `ip -d -s link show can0` should be ERROR-ACTIVE (no bus-off / error-warn).
4. Drives boot but `Failed to activate 'left_wheel_joint'` after ~5 s, statusword stuck at
   Switched On (0x0033): the TMC9660 is untuned (`MOTOR_TYPE=0`, `MOTOR_POLE_PAIRS=1`), so ABN
   encoder init never runs. Replaced or reset drives need the stock QSH5718 tuning, written and
   stored to the drive's flash with the robot container stopped:
   ```bash
   python3 /usr/lib/ad-r1m/adrd3161/param_tool.py -e /usr/share/ad-r1m/adrd3161/adrd3161.eds <0x14|0x16> \
     write /usr/share/ad-r1m/adrd3161/qsh5718_basic.ini
   ```
   Needs python `canopen`; back up first with `... read ini`. Confirm with the user before
   writing: it overwrites persisted drive parameters.

Reset the motor boards only if the drives are unresponsive on CAN.

---

## Issue 12: Bringup Fails With "mkdir .../ros_data/log: file exists"

### Error
`ad-r1m-bringup` fails right after creating the containers. Only `zenoh_router` runs:

```
Error response from daemon: error while creating mount source path
'/usr/share/ad-r1m/default-config/ros_data/log': mkdir .../ros_data/log: file exists
```

### Cause
A packaging bug in `ad-r1m-system-rpi5` (seen in `0.1.0~git20260608.1405.15745cf-1`): the
`ros_data/log` symlink points to `/var/log/ad-r1m` (dash), but the package creates
`/var/log/ad_r1m` (underscore). Docker finds the dangling symlink and cannot create the mount
path. The image is not the cause: it fails the same way with the image from Cloudsmith.

### Fix
```bash
ls -l /usr/share/ad-r1m/default-config/ros_data/log   # -> /var/log/ad-r1m
sudo mkdir -p /var/log/ad-r1m
sudo systemctl restart ad-r1m-bringup
```

Report it against `ad-r1m-system-rpi5` in ad-r1m-ros2 so the symlink and the directory agree.

---

## Issue 13: RViz Drops Every Scan (frame `/cam1_scan`)

### Error
The RViz log repeats, with current timestamps:

```
Message Filter dropping message: frame '/cam1_scan' ... 'discarding message because the queue is full'
```

`ros2 topic echo --once /scan --field header` shows `frame_id: //cam1_scan`, while TF has
`cam1_scan`.

### Cause
The config folder and the robot image come from different ad-r1m-ros2 versions. On `main`,
`compose.yaml` passes `namespace:=/` (from `ROBOT_NAMESPACE=/`) to the scan launch file. The
1.0.0 launch file prefixes the namespace to the frame, which gives `//cam1_scan`; `main` strips
the slash (commit `a11262c`). `provision_robot demo_config` copies `main`'s config, while
Cloudsmith's `robot-humble` image, and `build_robot_image` by default, use the latest release.
`provision_robot` warns when the two refs differ.

The ToF timing is not the cause. If the robot is NTP-synchronized, scan timestamps lag the PC
by about a second over Wi-Fi.

### Fix
Use the same ref for both, preferably the newer one:
- `build_robot_image ref=main`, so the image matches a `main` config
- or `provision_robot demo_config=true config_ref=<release>`, so the config matches the image

Quick workaround: remove the `namespace:=` argument from the `tof` service in
`~/demo/compose.yaml` and restart it.

---

## Quick Diagnostic Checklist

When SLAM fails, check in this order:

1. **Topics publishing?** `diagnostics target=slam` (`publishers`, `hz`)
2. **Encoding correct?** `ros2 topic echo /cam1/depth_image --once | grep encoding`
3. **TF available?** `ros2 run tf2_ros tf2_echo base_link cam1_adtf31xx_optical`
4. **Wheel controllers active?** `robot_status.drives` (Issue 11)
5. **Memory available?** `free -h` (more than 1 GB free)
6. **CPU reasonable?** `diagnostics.rtabmap.cpu_percent` (below ~70%)
7. **Sync working?** No "Did not receive data" warnings in the SLAM log

---

## Template Quick Reference

| Template | Use |
|----------|-----|
| `rtabmap_depth_rgb_launch.py` | Default, tested: ToF depth + AB as RGB (`slam action=start`) |
| `rtabmap_depth_pointcloud_launch.py` | Visual + ICP with the point cloud (`template=depth_pointcloud`) |
| `image_preprocess.py` | Depth relabel, AB log-scale to mono8 (no flip) |
| `cloud_preprocess.py` | ToF point cloud filter for the visual + ICP template |
| `mola_icp_launch.py` | MOLA LiDAR odometry on the ToF point cloud, with a 2D map (deploy with `slam action=deploy`) |
| `nav_pointcloud_launch.py`, `navigation_params_pointcloud.yaml`, `nav_cloud_filter.py` | Nav2 with the ToF point cloud (`nav action=start_pointcloud`) |
| `rtab.rviz` | RViz layout used by the `rviz` tool |
