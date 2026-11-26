#!/usr/bin/env python3
"""
MOLA LiDAR Odometry Launch File for AD-R1M Robot

Includes MOLA's official ros2-lidar-odometry.launch.py (package mola_lidar_odometry,
binary ros-humble-mola-lidar-odometry) and feeds it the ADTF3175D ToF point cloud as a
3D "LiDAR" scan. mola-cli on its own does not subscribe to anything: the official launch
sets MOLA_LIDAR_TOPIC and friends for the pipeline.

MOLA-LO only publishes a 3D local map (/lidar_odometry/localmap_points, latched). For a 2D
occupancy grid, octomap_server integrates /cam1/point_cloud in the map frame (MOLA's
localization) and its 2D projection is published as /map.

Obstacle heights are filtered relative to the robot (base_footprint, at floor level), not
in the map frame: MOLA estimates 6 DoF and its map frame picks up roll/pitch and z drift
from the narrow ToF view (~10 deg tilt, floor at z=-0.18 in map),
so a z band in map slices through the floor. With filter_ground_plane, octomap_server
applies point_cloud_min/max_z and a RANSAC ground fit in base_frame_id before inserting.
The cloud itself needs no rotation: optical y maps to base_link +z.

TF: MOLA publishes map -> odom only (publish_localization_following_rep105); the EKF keeps
odom -> base_link, which MOLA imports as its odometry prior (forward_ros_tf_odom_to_mola).
The vendor point cloud is published in the optical frame and the TF already models the
inverted mount, so the cloud is used as published.

Caveat: MOLA-LO is tuned for 360-degree LiDAR; the ToF cloud is ~70 degree FOV and a few
meters deep, so expect weak ICP constraints in open spaces.
"""
import os

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PythonExpression
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    mola_launch = os.path.join(
        get_package_share_directory('mola_lidar_odometry'),
        'ros2-launchs', 'ros2-lidar-odometry.launch.py')

    localization = LaunchConfiguration('localization')

    return LaunchDescription([
        DeclareLaunchArgument('localization', default_value='false',
                              description='true: localize on the existing map, no map updates'),
        DeclareLaunchArgument('pipeline', default_value='../pipelines/lidar3d-default.yaml',
                              description='MOLA-LO pipeline YAML (relative to the launch dir)'),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(mola_launch),
            launch_arguments={
                'lidar_topic_name': '/cam1/point_cloud',
                'lidar_topic_type': 'PointCloud2',
                'imu_topic_name': '/imu',
                'mola_lo_pipeline': LaunchConfiguration('pipeline'),
                # EKF owns odom -> base_link; MOLA adds map -> odom and uses odom as prior
                'publish_localization_following_rep105': 'True',
                'forward_ros_tf_odom_to_mola': 'True',
                'mola_lo_reference_frame': 'map',
                'mola_tf_base_link': 'base_link',
                # localization:=true -> localize only, no map updates
                'start_mapping_enabled': PythonExpression(["'False' if '", localization, "'.lower() == 'true' else 'True'"]),
                'use_rviz': 'False',      # headless robot
                'use_mola_gui': 'False',
            }.items(),
        ),
        # 2D map for RViz/Nav2: occupancy from the ToF cloud, posed by MOLA (map frame)
        Node(
            package='octomap_server',
            executable='octomap_server_node',
            name='octomap_server',
            output='screen',
            parameters=[{
                'frame_id': 'map',
                'base_frame_id': 'base_footprint',  # floor level; z filters apply here
                'resolution': 0.05,
                'sensor_model.max_range': 4.0,     # ToF depth is unreliable beyond ~4 m
                # In base_footprint: ToF floor noise reaches ~7 cm (camera is 6 cm up)
                'point_cloud_min_z': 0.07,
                'point_cloud_max_z': 1.0,          # robot-height obstacles only
                'filter_ground_plane': True,       # also drop a fitted floor plane
                'ground_filter.distance': 0.05,
                'ground_filter.angle': 0.15,
                'ground_filter.plane_distance': 0.07,
                # Projection to 2D happens in map, whose z drifts: accept any height there
                'occupancy_min_z': -2.0,
                'occupancy_max_z': 2.0,
                'filter_speckles': True,
                'latch': True,                     # RViz/Nav2 get the map when they connect
            }],
            remappings=[
                ('cloud_in', '/cam1/point_cloud'),
                ('projected_map', '/map'),
            ],
        ),
    ])
