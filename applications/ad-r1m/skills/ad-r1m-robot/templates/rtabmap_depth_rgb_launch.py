#!/usr/bin/env python3
"""
RTAB-Map Depth + RGB (AB) SLAM Launch File for AD-R1M Robot

Research-backed parameters from:
- Labbé & Michaud, 2019: RTAB-Map SLAM Library
- Phan et al., 2023: EKF fusion gave 9-36x lower ATE than visual odometry
- Muravyev & Yakovlev, 2022: ~3.6 GB on a 300 m trajectory (simulated)
- Kunchala et al., 2026: RTAB-Map at 65-80% CPU on an RPi 4B

Inputs: raw /cam1/depth_image + AB image as RGB (/cam1/ab_processed), EKF odometry.
Visual registration only; occupancy grid from depth.

Tested on AD-R1M (ad-r1m-16, RTAB-Map 0.23.13, 2026-11-10).
2026-11-18 (ad-r1m-18, RTAB-Map 0.23.14, robot-slam image): best setup so far. Grid/RangeMax
3.0 -> 2.0 removed false far-floor obstacles; ~30-40 ms per update at 2 Hz, ~13% CPU; ran
with Nav2 (navigation_launch.py only, no AMCL) using RTAB-Map's /map and map -> odom TF.
2026-11-17 (ad-r1m-18): AB now log-scaled to mono8 (the mono16 AB median is ~69/65535,
so RTAB-Map's /256 conversion gave a near-black image and every loop closure was rejected
with 0 inliers); feature type set to GFTT/ORB for both Vis and Kp (6 = GFTT/BRIEF needs
xfeatures2d, which this OpenCV lacks); full-resolution features (RTAB-Map step was ~20 ms
of the 700 ms budget at decimation 2). Pre and post decimation must be equal: post=2 with
pre=1 stores 256x256 AB next to 512x512 depth and RTAB-Map drops Vis/DepthAsMask.
Odometry is read from TF (odom -> base_link, published by the EKF) with explicit variances,
not from /odometry/filtered: the EKF fuses diff_drive_controller/odom, which reports zero
covariance, so the EKF claims ~1e-9 m^2 pose variance. RTAB-Map then judged a correct
loop closure (41 deg yaw drift after a fast run) as a 12x outlier and rejected it.
The ToF camera is mounted inverted and the TF base_link -> cam1_adtf31xx_optical
already models it: feed the images/cloud as published, do NOT flip or rotate them
(doing so inverts the scene in 3D and the floor gets mapped as obstacles).
"""
from launch import LaunchDescription
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory
import os

def generate_launch_description():
    preprocess_script = os.path.join(
        get_package_share_directory('slam_integration'), 'launch', 'image_preprocess.py')

    # AB (amplitude) image used as RGB: 16UC1 -> log-scaled mono8 (no flip, see docstring)
    ab_preprocess = Node(
        executable='python3',
        arguments=[preprocess_script],
        name='ab_preprocess',
        parameters=[{
            'input_topic': '/cam1/ab_image',
            'output_topic': '/cam1/ab_processed',
            'target_encoding': 'mono8',  # log-scaled, see image_preprocess.py
            'ab_max': 8191,               # AB saturates at ~8190 (13-bit)
        }],
        output='screen'
    )

    # RTAB-Map SLAM node with research-backed parameters
    rtabmap_node = Node(
        package='rtabmap_slam',
        executable='rtabmap',
        name='rtabmap',
        output='screen',
        # Start from an empty DB: reloading a DB with descriptor-less nodes aborts rtabmap
        arguments=['-d'],
        parameters=[{
            # Input configuration
            'subscribe_depth': True,
            'subscribe_rgb': True,
            # Odometry from TF instead of /odometry/filtered (see docstring)
            'subscribe_odom': False,
            'odom_frame_id': 'odom',
            'odom_tf_linear_variance': 0.001,   # (3 cm)^2 per link
            'odom_tf_angular_variance': 0.001,  # (~1.8 deg)^2 per link
            'wait_for_transform': 0.2,
            'approx_sync': True,
            'approx_sync_max_interval': 0.1,  # 100ms tolerance
            'sync_queue_size': 30,
            'database_path': '/root/.ros/rtabmap_rgbd.db',  # separate from the default rtabmap.db

            # CRITICAL: Disable ray tracing for narrow 75° FOV
            # Labbé 2019: a raised camera makes 2D ray tracing clear obstacles it no longer sees
            'Grid/RayTracing': 'false',
            'Grid/3D': 'false',
            'Grid/CellSize': '0.05',
            'Grid/Sensor': '1',              # 0=laser scan, 1=depth image, 2=both

            # Ground/Obstacle Segmentation (tuned for ToF camera)
            # Height threshold instead of normals: ToF floor depth is noisy at grazing angles,
            # so floor normals fail MaxGroundAngle and the floor gets mapped as obstacles
            # (seen on ad-r1m-18, 2026-11-18). Flat floors only: ramps > MaxGroundHeight
            # become obstacles.
            'Grid/NormalsSegmentation': 'false',
            'Grid/MaxGroundAngle': '30',     # Max slope for ground (degrees, normals mode only)
            'Grid/MaxGroundHeight': '0.08',  # Max ground height relative to base_link (m)
            'Grid/MaxObstacleHeight': '1.5', # Max obstacle height (m)
            'Grid/MinClusterSize': '20',     # Min points per obstacle cluster
            'Grid/NormalK': '10',            # K neighbors for normal estimation
            'Grid/NoiseFilteringRadius': '0.1',
            'Grid/NoiseFilteringMinNeighbors': '3',
            'Grid/FlatObstacleDetected': 'false',  # floor patches offset by ToF bias were obstacles
            'Grid/RangeMin': '0.3',          # tested value; ToF spec range is 0.4-4.0 m
            # At 3 m the far floor crossed MaxGroundHeight and was mapped as obstacles (ad-r1m-18,
            # 2026-11-18): a 1.5 deg camera tilt lifts it 7.8 cm at 3 m but 5 cm at 2 m.
            'Grid/RangeMax': '2.0',          # sensor max 4.0
            'Grid/DepthDecimation': '2',     # Downsample for performance

            # CRITICAL: Memory management for RPi
            # Muravyev 2022: RTAB-Map used ~3.6 GB on 300 m (simulated, default settings)
            'Rtabmap/MemoryThr': '300',      # Max nodes in working memory
            'Rtabmap/TimeThr': '700',        # Max processing time (ms)
            'Rtabmap/DetectionRate': '2.0',

            # Optimizer (GTSAM best for multi-session)
            'Optimizer/Strategy': '2',
            'Optimizer/GravitySigma': '0',   # Disable for 2D

            # 2D mode for differential drive
            'Reg/Strategy': '0',             # Visual registration
            'Reg/Force3DoF': 'true',

            # Loop closure (critical for 75° narrow FOV)
            'RGBD/ProximityBySpace': 'true',
            # 0 = no graph-depth limit: lets proximity detection match the start of a run when
            # returning to it (with 50, a ~85-node run could never close on node 1)
            'RGBD/ProximityMaxGraphDepth': '0',
            'RGBD/NeighborLinkRefining': 'true',
            'RGBD/LoopClosureReextractFeatures': 'true',
            'RGBD/OptimizeMaxError': '3.0',  # RTAB-Map default; 1.0 rejected valid loops
            'RGBD/AngularUpdate': '0.1',
            'RGBD/LinearUpdate': '0.1',

            # Visual features (RPi optimized)
            # GFTT/ORB for both, so the loop-closure vocabulary and registration use the
            # same features (6 = GFTT/BRIEF silently falls back without xfeatures2d)
            'Vis/FeatureType': '8',
            'Kp/DetectorStrategy': '8',
            'Vis/MaxFeatures': '400',
            'Kp/MaxFeatures': '200',
            'Vis/MaxDepth': '4.0',           # ignore features beyond ToF range

            # Image processing
            'Mem/ImagePreDecimation': '1',   # 512x512 is small; keep full res for features
            'Mem/ImagePostDecimation': '1',  # must match pre-decimation, else depth mask is dropped
            'Mem/STMSize': '30',             # Dynamic object filtering
            'Mem/RehearsalSimilarity': '0.2',
        }],
        remappings=[
            ('rgb/image', '/cam1/ab_processed'),
            ('depth/image', '/cam1/depth_image'),
            ('rgb/camera_info', '/cam1/camera_info'),
        ]
    )

    return LaunchDescription([
        ab_preprocess,
        rtabmap_node,
    ])
