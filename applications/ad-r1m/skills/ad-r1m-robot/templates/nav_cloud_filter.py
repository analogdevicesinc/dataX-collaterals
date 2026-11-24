#!/usr/bin/env python3
"""
Nav2 obstacle cloud for the AD-R1M ToF camera.

The raw /cam1/point_cloud is organized 512x512 (~262k points, ~4 MB at 10 Hz). Fed to
Nav2 directly, the costmaps transform and raytrace every point: on ad-r1m-18
(2026-11-18) load went to ~16 on 4 cores and the local costmap fell to ~1.4 Hz.
A voxel filter (cloud_preprocess.py) costs ~0.5-0.9 core in numpy (np.unique over
~200k points). This node instead strides the organized grid (stride 4 -> 128x128),
throttles to `rate` Hz and range-limits - no sort. Measured ~25% of one core on
ad-r1m-18, mostly rclpy receiving the 4 MB messages (the throttle drops them after that).

Header (optical frame, stamp) is preserved; no rotation, the optical frame TF already
models the inverted mount. Floor removal is left to Nav2 (min_obstacle_height in
navigation_params_pointcloud.yaml), which works in the costmap frame.
"""
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import PointCloud2, PointField
import numpy as np


class NavCloudFilter(Node):
    def __init__(self):
        super().__init__('nav_cloud_filter')

        self.declare_parameter('input_topic', '/cam1/point_cloud')
        self.declare_parameter('output_topic', '/cam1/point_cloud_nav')
        self.declare_parameter('stride', 4)       # keep every Nth row and column
        self.declare_parameter('rate', 5.0)       # max output Hz (local costmap updates at 5 Hz)
        self.declare_parameter('range_min', 0.3)  # optical z (depth), m
        self.declare_parameter('range_max', 2.5)  # = costmap obstacle_max_range

        input_topic = self.get_parameter('input_topic').value
        output_topic = self.get_parameter('output_topic').value
        self.stride = max(1, int(self.get_parameter('stride').value))
        rate = float(self.get_parameter('rate').value)
        self.min_period_ns = int(1e9 / rate) if rate > 0 else 0
        self.range_min = self.get_parameter('range_min').value
        self.range_max = self.get_parameter('range_max').value
        self.last_ns = 0

        self.sub = self.create_subscription(
            PointCloud2, input_topic, self.cloud_callback, qos_profile_sensor_data)
        self.pub = self.create_publisher(PointCloud2, output_topic, 1)
        self.fields = [PointField(name=n, offset=4 * i, datatype=PointField.FLOAT32, count=1)
                       for i, n in enumerate('xyz')]

        self.get_logger().info(
            f'{input_topic} -> {output_topic} (stride {self.stride}, <= {rate} Hz, '
            f'range {self.range_min}-{self.range_max} m)'
        )

    def cloud_callback(self, msg: PointCloud2):
        stamp_ns = msg.header.stamp.sec * 1_000_000_000 + msg.header.stamp.nanosec
        if stamp_ns - self.last_ns < self.min_period_ns:
            return
        self.last_ns = stamp_ns
        try:
            s = self.stride
            raw = np.frombuffer(msg.data, dtype=np.uint8)
            if msg.height > 1:
                raw = raw.reshape(msg.height, msg.row_step)[::s, :msg.width * msg.point_step]
                raw = raw.reshape(-1, msg.width, msg.point_step)[:, ::s].reshape(-1, msg.point_step)
            else:
                raw = raw.reshape(-1, msg.point_step)[::s * s]
            offs = {f.name: f.offset for f in msg.fields}
            xyz = np.stack([np.ascontiguousarray(raw[:, offs[c]:offs[c] + 4]).view(np.float32)[:, 0]
                            for c in 'xyz'], 1)
            z = xyz[:, 2]
            xyz = xyz[np.isfinite(xyz).all(1) & (z >= self.range_min) & (z <= self.range_max)]

            out = PointCloud2()
            out.header = msg.header
            out.height, out.width = 1, len(xyz)
            out.fields = self.fields
            out.is_bigendian = False
            out.point_step, out.row_step = 12, 12 * len(xyz)
            out.is_dense = True
            out.data = np.ascontiguousarray(xyz, dtype=np.float32).tobytes()
            self.pub.publish(out)
        except Exception as e:
            self.get_logger().error(f'Filter error: {e}')


def main(args=None):
    rclpy.init(args=args)
    node = NavCloudFilter()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
