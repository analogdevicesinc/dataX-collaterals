# RTAB-Map Research Knowledge Base

## Contents

- [Research Sources](#research-sources)
- [Critical Parameters for AD-R1M](#critical-parameters-for-ad-r1m)
- [AB Image as RGB (ADTF3175D)](#ab-image-as-rgb-adtf3175d)
- [Processing Time Budget (Single Core)](#processing-time-budget-single-core)
- [RTAB-Map vs Alternatives](#rtab-map-vs-alternatives)
- [vSLAM Algorithm Comparison (EuRoC Dataset)](#vslam-algorithm-comparison-euroc-dataset)
- [Large Indoor Performance (RTAB-Map vs Voxgraph)](#large-indoor-performance-rtab-map-vs-voxgraph)

Research behind the RTAB-Map parameters, from 7 academic papers. The values actually used on
AD-R1M are in the tested template `templates/rtabmap_depth_rgb_launch.py` (its docstring says
where tests on the robot moved them away from the papers); tuning levers are in COMMON_FIXES.md.

## Research Sources

| Paper | Key Contribution |
|-------|------------------|
| Labbé & Michaud, 2019 (Journal of Field Robotics) | RTAB-Map SLAM Library - comprehensive parameter guide |
| Phan et al., 2023 | Sensor Fusion - EKF (ultrasonic positioning + IMU + wheel encoders) gives 9-36x lower ATE than visual odometry |
| Muravyev & Yakovlev, 2022 | Large Indoor (simulated) - RTAB-Map used ~3.6 GB on a 300 m trajectory |
| Safarova et al., 2022 | vSLAM comparison - ORB-SLAM3 vs ORB-SLAM2 vs DSO vs LDSO |
| Kunchala et al., 2026 | RPi 4B comparison - RTAB-Map at 65-80% CPU |
| Li et al., 2025 | DYR-SLAM - dynamic object handling |
| Muharom et al., 2023 | 3D model quality - >300 matching IDs out of 500 images |

## Critical Parameters for AD-R1M

### Grid/Ray Tracing (CRITICAL)

**Problem:** Narrow 75° FOV + ray tracing = obstacles cleared when camera can't see them.

**Paper quote (Labbé 2019):**
> "The limited field of view of the front facing RGB-D camera was also a problem during navigation."

**Paper finding (Labbé 2019):** because the cameras are not close to the ground, 2D ray tracing
clears obstacles from the map once the camera no longer sees them. The paper recommends lowering
the camera to the height of the smallest obstacle, or otherwise "using 2D local occupancy grids
without ray tracing would then be safer". The AD-R1M camera is raised and narrow, so disable it.

**Solution:**
```python
'Grid/RayTracing': 'false',  # MUST disable for narrow FOV
'Grid/3D': 'false',
'Grid/FromDepth': 'true',
```

### Memory Management (CRITICAL for RPi)

**Problem:** With default settings, RTAB-Map used ~3.6 GB RAM on a 300 m trajectory (simulated;
the paper does not test memory limits).

**Paper data (Muravyev 2022):**
| Trajectory | RTAB-Map RAM | Voxgraph RAM |
|------------|--------------|--------------|
| 300m | 3.5-3.7 GB | up to 0.57 GB |
| 1km | 6.2-8.6 GB | up to 1.8 GB |

Ranges span the paper's noise levels; the upper values are with extra-large drift.

**Solution:**
```python
'Rtabmap/MemoryThr': '300',     # Max nodes in working memory
'Rtabmap/TimeThr': '700',       # Max processing time (ms)
```

### Odometry Strategy (CRITICAL)

**Problem:** Pure visual/lidar odometry fails in corridors with low geometric complexity.

**Paper data (Labbé 2019, MIT Stata Center, short-range lidar):**
| Configuration | ATEend | ATEmax |
|--------------|--------|--------|
| WheelIMU→S2M | **0.07m** | **0.08m** |
| WheelIMU only | 0.12m | 0.39m |
| Pure S2M | 4.61m | 4.64m |
| RGB-D F2M | 0.37m | 0.91m |

**Solution:** use the external EKF odometry (wheels + IMU), not visual odometry. On AD-R1M the
template reads it from TF (`odom -> base_link`) with explicit variances instead of subscribing to
`/odometry/filtered`: the EKF fuses `diff_drive_controller/odom`, which reports zero covariance,
so it claims ~1e-9 m² pose variance and RTAB-Map rejected a correct loop closure as an outlier.

### Loop Closure (Critical for narrow FOV)

**Problem:** 75° FOV may miss loop closures when approaching from different angles.

**Paper insight (Muharom 2023):**
> 3D model quality was good when matching IDs exceeded 300 out of 500 captured images

(This is a 3D reconstruction quality result, not a loop-closure threshold.)

**Solution:** proximity detection as a backup to appearance-based loop closure
(`RGBD/ProximityBySpace`, `RGBD/NeighborLinkRefining`, `RGBD/LoopClosureReextractFeatures`, all
`true` in the template). Keep `RGBD/OptimizeMaxError` at the RTAB-Map default 3.0: 1.0 rejects
valid loops. Wider coverage: the point cloud assembler (COMMON_FIXES.md Issue 7).

### ICP Corridor Handling

**Problem:** Corridors have low geometric complexity, causing pure ICP to fail.

**Solution:**
```python
'Icp/PointToPlaneMinComplexity': '0.02',  # Reject low-complexity registrations
```

## AB Image as RGB (ADTF3175D)

The AB (amplitude) image is ~13-bit (saturates ~8190) with a median around 70. RTAB-Map's
mono16 -> mono8 conversion divides by 256, leaving a near-black image (median 0, max ~31):
every loop closure is then rejected with 0 inliers. Feed AB
as log-scaled mono8 (`image_preprocess.py`, `target_encoding: mono8`, `ab_max: 8191`) with
a fixed mapping, not per-frame normalization, so appearance stays consistent across frames.

## Processing Time Budget (Single Core)

| Component | Time (ms) | Notes |
|-----------|-----------|-------|
| Visual Odometry F2M | 70-82 | Per frame |
| Lidar Odometry S2M | 22-25 | Per frame (2D lidar, MIT Stata; 82 ms on KITTI Velodyne) |
| 2D Grid (no ray trace) | 13 | Per node |
| 2D Grid (with ray trace) | 14 | Per node |
| 3D Grid with ray trace | 120 | **Too slow for RPi** |

## RTAB-Map vs Alternatives

From Kunchala et al. 2026 (measured on a Raspberry Pi 4B, 4 GB):

| Metric | RTAB-Map | GMapping | Cartographer |
|--------|----------|----------|--------------|
| Accuracy | High (~5-10 cm) | Moderate (drift) | Moderate-High |
| Loop Closure | Appearance-based | Particle filter | Pose graph |
| Dynamic Handling | Good | Poor | Moderate |
| CPU (RPi 4B) | 65-80% | 40-50% | 50-70% |
| Map Type | 3D + 2D | 2D only | 2D only |
| Nav2 Compatible | Full | ROS1 | Partial |

## vSLAM Algorithm Comparison (EuRoC Dataset)

From Safarova et al. 2022, all methods run monocular:

| Method | MH01 ATE | MH03 ATE |
|--------|----------|----------|
| ORB-SLAM3 | **0.016m** | **0.036m** |
| ORB-SLAM2 | 0.041m | 0.041m |
| LDSO | 0.044m | 0.090m |
| DSO | 0.054m | 0.209m |

**Key insight:** ORB-SLAM3 is more accurate than ORB-SLAM2 on most EuRoC sequences (2.6x on
MH01), but not all: ORB-SLAM2 is better on MH02 and MH05. DSO/LDSO suit short-range tasks.

## Large Indoor Performance (RTAB-Map vs Voxgraph)

| Metric | RTAB-Map | Voxgraph |
|--------|----------|----------|
| ATE (300m, small noise) | 0.99m | **0.93m** |
| ATE (1km, small noise) | **0.92m** | 2.43m |
| Memory (300m) | 3.5-3.7 GB | **up to 0.57 GB** |
| Memory (1km) | 6.2-8.6 GB | **up to 1.8 GB** |

From Muravyev & Yakovlev 2022 (Habitat simulator).

**Trade-off:** RTAB-Map has lower absolute error except at 300 m with small noise; Voxgraph has
lower relative error and uses about 5-6x less memory.
