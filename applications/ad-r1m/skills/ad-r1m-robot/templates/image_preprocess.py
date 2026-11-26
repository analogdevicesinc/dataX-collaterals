#!/usr/bin/env python3
"""
Image Preprocessing Node for AD-R1M ToF Camera
Converts 16UC1 encoding to mono16. It never flips or rotates: the camera is mounted
inverted and the TF base_link -> cam1_adtf31xx_optical already models it.

With target_encoding='mono8' the AB (amplitude) image is log-scaled to 8 bits: the plain
/256 conversion RTAB-Map applies leaves it almost black. The mapping is fixed (no per-frame
auto-exposure) so a surface looks the same in every frame, which loop closure needs.

Camera mode 3 (config_adsd3500_adsd3100.json): AB peaks at ~7600 (ab_max 8191) and the
camera zeroes AB below abThreshMin 3 (~12% of pixels). The scale starts at ab_min, and
fill_invalid paints the zeroed pixels with the mean of their valid neighbours: otherwise
~47% of GFTT corners sit on those holes' edges, which flicker frame to frame. It costs
~10 ms per frame.
"""
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from cv_bridge import CvBridge
import numpy as np
import cv2

class ImagePreprocessNode(Node):
    def __init__(self):
        super().__init__('image_preprocess')

        # Parameters
        self.declare_parameter('input_topic', '/cam1/depth_image')
        self.declare_parameter('output_topic', '/cam1/depth_processed')
        self.declare_parameter('target_encoding', 'mono16')
        self.declare_parameter('ab_max', 8191)  # saturation value for mono8 log scaling
        self.declare_parameter('ab_min', 3)     # camera abThreshMin: AB below it is zeroed
        self.declare_parameter('fill_invalid', True)

        input_topic = self.get_parameter('input_topic').value
        output_topic = self.get_parameter('output_topic').value
        self.target_encoding = self.get_parameter('target_encoding').value
        ab_max = self.get_parameter('ab_max').value
        self.ab_min = max(1, self.get_parameter('ab_min').value)
        self.fill_invalid = self.get_parameter('fill_invalid').value
        # Lookup table 0..65535 -> 0..255: invalid -> 0, log scale ab_min..ab_max -> 1..255
        v = np.clip(np.arange(65536.0), self.ab_min, ab_max)
        self.log_lut = np.rint(1 + 254 * np.log(v / self.ab_min) / np.log(ab_max / self.ab_min)).astype(np.uint8)
        self.log_lut[:self.ab_min] = 0

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
                invalid = cv_image < self.ab_min
                cv_image = self.log_lut[cv_image]
                if self.fill_invalid and invalid.any():
                    # normalized box filter: mean of the valid neighbours
                    num = cv2.blur(cv_image.astype(np.float32), (15, 15))
                    den = cv2.blur((~invalid).astype(np.float32), (15, 15))
                    cv_image[invalid] = (num / np.maximum(den, 0.05))[invalid]

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
