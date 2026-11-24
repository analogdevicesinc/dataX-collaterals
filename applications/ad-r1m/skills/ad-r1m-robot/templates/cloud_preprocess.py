#!/usr/bin/env python3
"""
Point Cloud Preprocessing Node for AD-R1M ToF Camera
Drops invalid points, range-limits and voxel-downsamples the organized (512x512,
is_dense=false) ToF cloud into a dense unorganized XYZ cloud. Header (optical
frame, stamp) is preserved; no rotation is applied, the optical frame TF already
models the inverted mount. RTAB-Map asserts in laserScanFromPointCloud() on the
raw organized cloud when computing normals.
"""
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import PointCloud2, PointField
import numpy as np

class CloudPreprocessNode(Node):
    def __init__(self):
        super().__init__('cloud_preprocess')

        self.declare_parameter('input_topic', '/cam1/point_cloud')
        self.declare_parameter('output_topic', '/cam1/point_cloud_filtered')
        self.declare_parameter('voxel_size', 0.03)
        self.declare_parameter('range_min', 0.3)   # optical z (depth), m
        self.declare_parameter('range_max', 4.0)

        input_topic = self.get_parameter('input_topic').value
        output_topic = self.get_parameter('output_topic').value
        self.voxel_size = self.get_parameter('voxel_size').value
        self.range_min = self.get_parameter('range_min').value
        self.range_max = self.get_parameter('range_max').value

        self.sub = self.create_subscription(PointCloud2, input_topic, self.cloud_callback, 5)
        self.pub = self.create_publisher(PointCloud2, output_topic, 5)
        self.fields = [PointField(name=n, offset=4 * i, datatype=PointField.FLOAT32, count=1)
                       for i, n in enumerate('xyz')]

        self.get_logger().info(
            f'Preprocessing: {input_topic} -> {output_topic} '
            f'(voxel: {self.voxel_size}, range: {self.range_min}-{self.range_max})'
        )

    def cloud_callback(self, msg: PointCloud2):
        try:
            offs = {f.name: f.offset for f in msg.fields}
            raw = np.frombuffer(msg.data, dtype=np.uint8).reshape(-1, msg.point_step)
            xyz = np.stack([raw[:, offs[c]:offs[c] + 4].copy().view(np.float32)[:, 0] for c in 'xyz'], 1)
            z = xyz[:, 2]
            xyz = xyz[np.isfinite(xyz).all(1) & (z >= self.range_min) & (z <= self.range_max)]
            if self.voxel_size > 0 and len(xyz):
                keys = np.floor(xyz / self.voxel_size).astype(np.int64)
                keys -= keys.min(0)
                dims = keys.max(0) + 1
                flat = (keys[:, 0] * dims[1] + keys[:, 1]) * dims[2] + keys[:, 2]
                _, idx = np.unique(flat, return_index=True)
                xyz = xyz[idx]

            out = PointCloud2()
            out.header = msg.header  # same optical frame + stamp
            out.height, out.width = 1, len(xyz)
            out.fields = self.fields
            out.is_bigendian = False
            out.point_step, out.row_step = 12, 12 * len(xyz)
            out.is_dense = True
            out.data = np.ascontiguousarray(xyz, dtype=np.float32).tobytes()
            self.pub.publish(out)
        except Exception as e:
            self.get_logger().error(f'Preprocessing error: {e}')

def main(args=None):
    rclpy.init(args=args)
    node = CloudPreprocessNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()
