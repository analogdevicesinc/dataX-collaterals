# AD-R1M Robot Specification

## Contents

- [Hardware Platform](#hardware-platform)
- [Compute](#compute)
- [Sensors](#sensors)
- [Network](#network)
- [Workspace](#workspace)
- [TF Frames](#tf-frames)
- [Topic Summary](#topic-summary)
- [Package Structure](#package-structure)
- [SLAM Packages](#slam-packages)

## Hardware Platform

Source: the official [AD-R1M ROS2 documentation](https://analogdevicesinc.github.io/ad-r1m-ros2/)
(Reference → AD-R1M Specifications), plus the robot URDF and code in
[ad-r1m-ros2](https://github.com/analogdevicesinc/ad-r1m-ros2).

**Type**: Differential drive mobile robot (open mobile robot platform)
**Manufacturer**: Analog Devices

| Component | Part |
|-----------|------|
| Main compute | Raspberry Pi 5 |
| Connectivity carrier | ADRD4161-01Z (ADIS IMU, CAN bus, GPIOs; slcan adapter firmware) |
| IMU | ADIS16470 |
| ToF camera | EVAL-ADTF3175 |
| BMS | ADRD5161-01Z (CiA 419), LiPo 3S2P battery pack |
| Motor drives | 2x ADRD3161-01Z (CiA 402) |
| Motors | 2x QSH5718-51-28-101-10K steppers with high-resolution encoders |

The robotics modules run Zephyr firmware and talk CANopen over a 500 kbps CAN bus.

**Mechanical and drive** (values used by Nav2 and odometry):

| Parameter | Value |
|-----------|-------|
| Dimensions (L x W x H) | 585 x 360 x 150 mm, chassis only |
| Weight | ~10 kg with battery |
| Kinematics | Differential drive, 2 driven wheels through the geometric center, 4 casters |
| Drive wheel diameter / width | 100 mm / 25 mm |
| Wheel track (base width) | 220 mm |
| Max speed | 2.0 m/s (soft limit) |
| Default speed | 1.0 m/s (teleop and Nav2 configs) |
| Payload | Not rated |

**Battery**: 3S2P NCR18650GA, 9.0-12.6 V (10.8 V nominal), 6600 mAh. Operating time
2-3 h in constant motion, 12 h with motors idle; 2 h charge.

**Add-ons**: 1 Gbps Ethernet, 1x USB 3.0 + 2x USB 2.0 on the Pi, GPIOs on the carrier.
Reference designs exist for Jetson AGX Orin + RealSense and Jetson Xavier NX + GMSL cameras;
the base robot has neither.

## Compute

**Platform**: Raspberry Pi 5, 8 GB RAM, ARM64
**GPU**: No CUDA GPU - SLAM runs on the CPU only
**OS**: ADI Kuiper Linux (Debian-based)
**Runtime**: Docker containers running ROS 2 Humble

| Container | Role |
|-----------|------|
| `ad-r1m-robot-1` | Robot runtime: motion control, sensors, EKF, teleop |
| `ad-r1m-nav-1` | Nav2 (`docker compose` `nav` service) |
| `slam_workspace` | Created by this plugin's `setup_workspace` for the generated SLAM package |

**Performance constraints**:
- No CUDA: reject packages that require a GPU
- ARM, not x86: reject packages with x86-only builds or binaries
- 8 GB is shared by every container; bound RTAB-Map memory with `Rtabmap/MemoryThr` and
  `Rtabmap/TimeThr` (see RTAB_RESEARCH.md)

## Sensors

### Primary: ADTF3175 ToF Depth Camera

| Parameter | Value |
|-----------|-------|
| Type | Time-of-Flight depth camera |
| FOV | 75° horizontal / 90° diagonal |
| Range | 0.4 - 4.0 m |
| Resolution | 512 x 512 px; each pixel has a depth value (mm) and an infrared albedo (AB) value |

**ROS2 Topics**:
- `/cam1/depth_image` (sensor_msgs/Image, encoding: **16UC1**)
- `/cam1/ab_image` (sensor_msgs/Image, encoding: **16UC1**) - infrared albedo
- `/cam1/point_cloud` (sensor_msgs/PointCloud2)
- `/cam1/camera_info` (sensor_msgs/CameraInfo)
- `/scan` (sensor_msgs/LaserScan) - **synthetic**, derived from the depth image (frame `cam1_scan`)

**Critical Notes**:
1. **Non-standard encoding**: Publishes `16UC1` instead of standard `mono16`
   - Most SLAM packages expect `mono8`, `mono16`, `bgr8`, or `rgb8`
   - Requires preprocessing node for encoding conversion
2. **Mounting**: Camera is mounted **inverted** (upside-down), and its optical frame is
   upside down too. The TF `base_link -> cam1_adtf31xx_optical` models the mount.
   - Do NOT flip or rotate the depth/AB images or the point cloud - use them as published
3. **Narrow FOV**: 75° horizontal is narrow compared to a 360° LiDAR
   - SLAM needs careful parameter tuning (disable ray tracing, enable proximity detection)
   - Fewer visual features per frame; loop closures need revisits from similar angles

### IMU: ADIS16470

**Type**: 6-axis IMU (accel + gyro), no orientation output
**Sampling**: 200 Hz default, 2000 Hz max (configurable via libIIO)
**Topic**: `/imu` (sensor_msgs/Imu)
**Use**: Fused with wheel odometry via EKF

### Odometry: Wheel Encoders + IMU

- `/odometry/filtered` (nav_msgs/Odometry) - **Use this for SLAM**
  - EKF fusion of wheel odometry (`diff_drive_controller`) and IMU
  - More accurate than visual odometry alone
- Wheel joint states come from `joint_state_broadcaster` on `/joint_states`; if no
  publisher exists, the drives did not boot (COMMON_FIXES.md, Issue 11)

## Network

**Hostname**:
- `analog` / `analog.local` - freshly flashed ADI Kuiper image (reach it over Ethernet until
  Wi-Fi is set up)
- `ad-r1m-<N>` / `ad-r1m-<N>.local` - configured robot, N usually the serial number
- Or a raw IP address when `.local` names don't resolve

**User / password**: `analog` / `analog` (Kuiper defaults)
**SSH**: `ssh analog@<hostname>`

## Workspace

Inside the containers:

**Path**: `/ros2_ws`
**Robot packages**: `/ros2_ws/src/ad-r1m-ros2`
**Generated SLAM package**: `/ros2_ws/src/slam_integration` (in `slam_workspace`)
**Source**: `source /ros2_ws/install/setup.bash`

## TF Frames

From the robot URDF (`ad_r1m_description`):

```
map → odom → base_link ─┬─ base_footprint
                        ├─ chassis
                        ├─ imu
                        ├─ left_wheel, right_wheel
                        └─ cam1_adtf31xx ─┬─ cam1_adtf31xx_optical
                                          └─ cam1_scan
```

- `map` is published by SLAM, `odom → base_link` by the EKF
- Static and wheel transforms come from `robot_state_publisher`

## Topic Summary

| Topic | Type | Description |
|-------|------|-------------|
| /cam1/depth_image | Image | ToF depth (16UC1) |
| /cam1/ab_image | Image | ToF infrared albedo (16UC1) |
| /cam1/point_cloud | PointCloud2 | 3D point cloud |
| /cam1/camera_info | CameraInfo | Camera calibration |
| /scan | LaserScan | Synthetic scan from the depth image |
| /imu | Imu | IMU data (200 Hz default) |
| /odometry/filtered | Odometry | EKF-fused odometry |
| /joint_states | JointState | Wheel joints |
| /tf, /tf_static | TFMessage | Transforms |

Check live rates with `ros2 topic hz <topic>`; they depend on the active runtime configuration.

## Package Structure

Main ROS 2 packages in [ad-r1m-ros2](https://github.com/analogdevicesinc/ad-r1m-ros2):

```
ad-r1m-ros2/
├── ad_r1m_bringup/                     # Robot startup
├── ad_r1m_control/                     # ros2_control / drive controllers
├── ad_r1m_description/                 # URDF, meshes
├── ad_r1m_navigation/                  # Robot's own Nav2 / slam_toolbox launch files
├── ad_r1m_perception_aditof/           # ADTF3175 ToF camera
├── ad_r1m_pointcloud_to_occupancygrid/
├── ad_r1m_examples/, ad_r1m_gazebo/, ad_r1m_sim/
└── system/                             # compose.yaml, ad-r1m.env (robot runtime)
```

## SLAM Packages

Which packages fit is decided from live evidence: `package_evidence` and EVALUATION_CRITERIA.md
in the `ad-r1m-slam-integration` skill. Tested on this robot: RTAB-Map (`templates/rtabmap_*`)
and MOLA (`templates/mola_icp_launch.py`).
