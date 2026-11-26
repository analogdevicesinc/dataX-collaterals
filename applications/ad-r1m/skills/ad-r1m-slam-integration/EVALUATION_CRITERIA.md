# SLAM Package Evaluation Criteria

## Contents

- [Scoring Methodology](#scoring-methodology)
- [Example Evaluation](#example-evaluation)
- [Compatibility Flags](#compatibility-flags)
- [Scoring Thresholds](#scoring-thresholds)

## Scoring Methodology

Packages are scored 0-100 based on weighted criteria:

### 1. Hardware Compatibility (40 points)

**GPU Requirement** (15 points):
- No GPU required: 15 points
- Optional GPU acceleration: 10 points
- GPU required: 0 points

**Compute Platform** (15 points):
- Documented ARM support (RPi/Jetson): 15 points
- Likely works on ARM: 10 points
- x86 only / heavy compute: 5 points
- Known not to work on embedded: 0 points

**Sensor Compatibility** (10 points):
- Matches all available sensors: 10 points
- Matches some sensors: 5 points
- No sensor match: 0 points

### 2. Software Compatibility (30 points)

**ROS2 Support** (20 points):
- Full ROS2 package with releases: 20 points
- ROS2 port available: 15 points
- ROS1 only: 0 points

**ROS2 Version** (10 points):
- Supports target ROS2 version: 10 points
- Older/newer ROS2 version: 5 points
- Incompatible ROS2 version: 0 points

### 3. Integration & Ecosystem (20 points)

**Nav2 Integration** (10 points):
- Official Nav2 integration: 10 points
- Can output to Nav2 format: 7 points
- Manual integration needed: 3 points
- No navigation support: 0 points

**Documentation** (5 points):
- Comprehensive docs + examples: 5 points
- Basic documentation: 3 points
- Minimal/no documentation: 0 points

**Maintenance** (5 points):
- Active development (< 6 months): 5 points
- Maintained (< 1 year): 3 points
- Stale (> 1 year): 1 point
- Abandoned: 0 points

### 4. Performance & Features (10 points)

**SLAM Quality** (5 points):
- Loop closure + relocalization: 5 points
- Basic SLAM without loop closure: 3 points
- Odometry only: 1 point

**Real-time Performance** (5 points):
- Runs real-time on target platform: 5 points
- Needs parameter tuning: 3 points
- Known performance issues: 0 points

## Example Evaluation

One worked example; it shows why a high score can still get a capped verdict.

### SLAM Toolbox on AD-R1M

- GPU: Not required → 15 points
- Compute: RPi5 works → 15 points
- Sensors: **Needs 2D LiDAR**; only the synthetic /scan from the ToF depth image → 5 points
- ROS2: Full support → 20 points
- ROS2 Version: Matches → 10 points
- Nav2: Default choice → 10 points
- Docs: Excellent → 5 points
- Maintenance: Very active → 5 points
- SLAM Quality: Loop closure → 5 points
- Performance: Real-time → 5 points

**Total: 95 points** ⚠️ High score, but the verdict is capped at "possible with caveats":
the only input is a synthetic narrow-FOV scan

## Compatibility Flags

Mark packages as incompatible if ANY of these are true:

- `gpu_required: true` when robot has no CUDA GPU
- `lidar_only: true` when robot has no LiDAR
- `ros2_support: false` when ROS2 required
- Requires sensors not available on robot
- Known not to work on target compute platform

## Scoring Thresholds

- **85-100**: Excellent fit, recommend immediately
- **70-84**: Compatible, good choice
- **50-69**: Possible with caveats, warn user
- **Below 50**: Not recommended
- **Hardware incompatible**: Mark `compatible: false` regardless of score
- **Weak sensor match caps the verdict**: only a synthetic input (e.g. /scan made from the
  depth image) → at most "possible with caveats"; only a fallback input → at most "compatible"
