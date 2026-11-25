#!/usr/bin/env python3
"""
RTAB-Map Depth + RGB (AB) + Point Cloud SLAM Launch File for AD-R1M Robot

Research-backed parameters from:
- Labbé & Michaud, 2019: RTAB-Map SLAM Library
- Phan et al., 2023: EKF fusion gave 9-36x lower ATE than visual odometry
- Muravyev & Yakovlev, 2022: ~3.6 GB on a 300 m trajectory (simulated)
- Kunchala et al., 2026: RTAB-Map at 65-80% CPU on an RPi 4B

Inputs: raw /cam1/depth_image + AB image as RGB + /cam1/point_cloud (voxel-filtered by
cloud_preprocess.py, same optical frame), EKF odometry. Visual + ICP registration;
occupancy grid from depth. Icp/PointToPlaneRadius must stay 0 while PointToPlaneK is set.

Tested on AD-R1M (ad-r1m-16, RTAB-Map 0.23.13, 2026-11-10).
2026-11-18: AB log-scaled to mono8 as in rtabmap_depth_rgb_launch.py (mono16 AB median is
~69/65535, so RTAB-Map's /256 conversion gave a near-black image).
2026-11-18: occupancy-grid floor params (height-based ground segmentation, no flat
obstacles, Grid/RangeMax 2.0) copied from rtabmap_depth_rgb_launch.py.
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
            'ab_max': 8191,               # AB peaks at ~7600
            'ab_min': 3,                  # camera abThreshMin: AB below it is zeroed
            'fill_invalid': True,         # no corners on the zeroed holes
        }],
        output='screen'
    )

    cloud_script = os.path.join(
        get_package_share_directory('slam_integration'), 'launch', 'cloud_preprocess.py')

    # Point cloud: drop invalid points, range-limit, 3 cm voxel -> dense cloud (no rotation)
    cloud_preprocess = Node(
        executable='python3',
        arguments=[cloud_script],
        name='cloud_preprocess',
        parameters=[{
            'input_topic': '/cam1/point_cloud',
            'output_topic': '/cam1/point_cloud_filtered',
            'voxel_size': 0.03,
            'range_min': 0.3,
            'range_max': 4.0,
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
            'subscribe_odom': True,
            'subscribe_scan_cloud': True,
            'approx_sync': True,
            'approx_sync_max_interval': 0.1,  # 100ms tolerance
            'queue_size': 30,
            'database_path': '/root/.ros/rtabmap_rgbd_cloud.db',  # separate from the default rtabmap.db

            # CRITICAL: Disable ray tracing for narrow 75° FOV
            # Labbé 2019: a raised camera makes 2D ray tracing clear obstacles it no longer sees
            'Grid/RayTracing': 'false',
            'Grid/3D': 'false',
            'Grid/FromDepth': 'true',
            'Grid/CellSize': '0.05',
            'Grid/Sensor': '1',              # 0=laser scan, 1=depth image, 2=both

            # Ground/Obstacle Segmentation (tuned for ToF camera)
            # Floor params as in rtabmap_depth_rgb_launch.py. Height threshold instead of
            # normals: ToF floor depth is noisy at grazing angles, so floor normals fail
            # MaxGroundAngle and the floor gets mapped as obstacles (seen on ad-r1m-18,
            # 2026-11-18). Flat floors only: ramps > MaxGroundHeight become obstacles.
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
            'Grid/RangeMax': '2.0',          # sensor max 4.0; Icp/RangeMax stays 4.0
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
            'Reg/Strategy': '2',             # Visual + ICP refinement
            'Icp/VoxelSize': '0.03',
            'Icp/MaxCorrespondenceDistance': '0.15',
            'Icp/PointToPlane': 'true',
            'Icp/PointToPlaneK': '10',
            'Icp/PointToPlaneRadius': '0',    # PCL rejects K and radius both set -> empty normals -> rtabmap assert
            'Icp/Iterations': '30',
            'Icp/RangeMin': '0.2',
            'Icp/RangeMax': '4.0',
            'RGBD/ProximityPathMaxNeighbors': '1',
            'Reg/Force3DoF': 'true',

            # Loop closure (critical for 75° narrow FOV)
            'RGBD/ProximityBySpace': 'true',
            'RGBD/ProximityMaxGraphDepth': '50',
            'RGBD/NeighborLinkRefining': 'true',
            'RGBD/LoopClosureReextractFeatures': 'true',
            'RGBD/OptimizeMaxError': '1.0',
            'RGBD/AngularUpdate': '0.1',
            'RGBD/LinearUpdate': '0.1',

            # Visual features (RPi optimized)
            'Vis/FeatureType': '6',          # ORB-OCTREE (fast)
            'Vis/MaxFeatures': '200',
            'Kp/MaxFeatures': '100',

            # Image processing
            'Mem/ImagePreDecimation': '2',
            'Mem/ImagePostDecimation': '2',
            'Mem/STMSize': '30',             # Dynamic object filtering
            'Mem/RehearsalSimilarity': '0.2',
        }],
        remappings=[
            ('rgb/image', '/cam1/ab_processed'),
            ('depth/image', '/cam1/depth_image'),
            ('rgb/camera_info', '/cam1/camera_info'),
            ('scan_cloud', '/cam1/point_cloud_filtered'),
            ('odom', '/odometry/filtered'),  # EKF-fused (WheelIMU achieves 0.07m ATE)
        ]
    )

    return LaunchDescription([
        ab_preprocess,
        cloud_preprocess,
        rtabmap_node,
    ])
