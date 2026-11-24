#!/usr/bin/env python3
"""
Nav2 with the ToF point cloud as costmap obstacle source (AD-R1M).

Runs in the nav compose service (compose.nav-pointcloud.yaml override written by the MCP
tool nav action=start_pointcloud): nav_cloud_filter.py publishes /cam1/point_cloud_nav and
ad_r1m_navigation's navigation_launch.py runs with navigation_params_pointcloud.yaml.
One launch process owns both, so `docker compose stop nav` stops the filter too.
Files are read from the same folder (the config folder's ros_data, mounted at /ros_data).
"""
import os

from launch import LaunchDescription
from launch.actions import ExecuteProcess, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch_ros.substitutions import FindPackageShare
from launch.substitutions import PathJoinSubstitution

HERE = os.path.dirname(os.path.abspath(__file__))


def generate_launch_description():
    cloud_filter = ExecuteProcess(
        cmd=['python3', os.path.join(HERE, 'nav_cloud_filter.py')],
        name='nav_cloud_filter',
        output='screen',
    )

    navigation = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(PathJoinSubstitution(
            [FindPackageShare('ad_r1m_navigation'), 'launch', 'navigation_launch.py'])),
        launch_arguments={
            'params_file': os.path.join(HERE, 'navigation_params_pointcloud.yaml'),
        }.items(),
    )

    return LaunchDescription([cloud_filter, navigation])
