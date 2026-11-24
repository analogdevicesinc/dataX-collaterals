#!/usr/bin/env python3
"""
Image Preprocessing Node for AD-R1M ToF Camera
Converts 16UC1 encoding to mono16. It never flips or rotates: the camera is mounted
inverted and the TF base_link -> cam1_adtf31xx_optical already models it.

With target_encoding='mono8' the AB (amplitude) image is log-scaled to 8 bits.
The ADTF3175D AB image is ~13-bit with most pixels below 100, so the plain
/256 mono16->mono8 conversion RTAB-Map applies leaves it almost black and
feature extraction fails. The mapping is fixed (not per-frame auto-exposure)
so the same surface looks the same in every frame, which loop closure needs.
"""
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from cv_bridge import CvBridge
import numpy as np

class ImagePreprocessNode(Node):
    def __init__(self):
        super().__init__('image_preprocess')

        # Parameters
        self.declare_parameter('input_topic', '/cam1/depth_image')
        self.declare_parameter('output_topic', '/cam1/depth_processed')
        self.declare_parameter('target_encoding', 'mono16')
        self.declare_parameter('ab_max', 8191)  # saturation value for mono8 log scaling

        input_topic = self.get_parameter('input_topic').value
        output_topic = self.get_parameter('output_topic').value
        self.target_encoding = self.get_parameter('target_encoding').value
        ab_max = self.get_parameter('ab_max').value
        # Lookup table 0..65535 -> 0..255, log scale saturating at ab_max
        values = np.minimum(np.arange(65536, dtype=np.float64), ab_max)
        self.log_lut = (255.0 * np.log1p(values) / np.log1p(ab_max)).astype(np.uint8)

        self.bridge = CvBridge()

        # Subscriber and publisher
        self.sub = self.create_subscription(
            Image,
            input_topic,
            self.image_callback,
            10
        )

        self.pub = self.create_publisher(Image, output_topic, 10)

        self.get_logger().info(
            f'Preprocessing: {input_topic} -> {output_topic} '
            f'(encoding: {self.target_encoding})'
        )

    def image_callback(self, msg: Image):
        try:
            # Convert to OpenCV format (handles 16UC1)
            # Use 'passthrough' to preserve original data
            cv_image = self.bridge.imgmsg_to_cv2(msg, desired_encoding='passthrough')

            if self.target_encoding == 'mono8' and cv_image.dtype == np.uint16:
                cv_image = self.log_lut[cv_image]

            # Convert back to ROS message with target encoding
            # (for mono16 this only changes the encoding label)
            out_msg = self.bridge.cv2_to_imgmsg(cv_image, encoding=self.target_encoding)
            out_msg.header = msg.header  # Preserve timestamp

            self.pub.publish(out_msg)

        except Exception as e:
            self.get_logger().error(f'Preprocessing error: {e}')

def main(args=None):
    rclpy.init(args=args)
    node = ImagePreprocessNode()

    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()
