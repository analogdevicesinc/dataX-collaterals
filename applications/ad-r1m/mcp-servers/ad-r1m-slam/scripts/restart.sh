# restart tool. $1: stack | slcan | crsf | imu | tof. Hardware targets run as root.
#
# stack: `stop` + `start`, not `down` + `up -d`. `down` removes the containers; stop/start
# keeps them and re-runs their entrypoints, which re-triggers the CANopen drive boot after a
# drive fails to initialize. `start` alone is a no-op on a running container.
#
# Hardware: the ad-r1m-* oneshot units that initialize the hardware (system/*.service in
# ad-r1m-ros2). The compose services holding that hardware are stopped first (e.g. slcan.sh
# kills slcand and recreates can0 under ros2_control), and only the ones that were running
# are started again - even if the restart fails.
TARGET=$1
cd_config

if [ "$TARGET" = stack ]; then
  compose stop 2>&1 | tail -3
  compose start 2>&1 | head -15
  section containers
  docker ps --format '{{.Names}}\t{{.Status}}'
  exit 0
fi

case $TARGET in
  slcan) UNIT=ad-r1m-slcan; HOLD="robot motors" ;;     # NMT-resets all CANopen nodes, power-cycles the slcan adapter MCU, recreates can0
  crsf) UNIT=ad-r1m-crsf; HOLD="teleop_crsf" ;;        # power-cycles the CRSF RC receiver
  imu) UNIT=ad-r1m-imu; HOLD="robot imu sensor_fusion" ;; # sets the ADIS16470 sampling frequency
  tof) UNIT=ad-r1m-tof; HOLD="tof" ;;                  # syncs the ToF camera clock, restarts its ROS 2 node
  *) echo "unknown target $TARGET"; exit 2 ;;
esac

RUNNING=$(compose ps --services --status running 2>/dev/null | grep -xE "$(echo "$HOLD" | tr ' ' '|')" | tr '\n' ' ')
echo "stopped_compose=$RUNNING"
[ -n "$RUNNING" ] && compose stop $RUNNING 2>&1 | tail -3
section unit
systemctl restart "$UNIT.service" 2>&1
echo "active=$(systemctl is-active "$UNIT.service")"
journalctl -u "$UNIT.service" -n 8 --no-pager -o cat 2>/dev/null
[ -n "$RUNNING" ] && compose start $RUNNING 2>&1 | tail -3

case $TARGET in
  slcan) can_nodes ;;
  crsf) section crsf; test -e /dev/ttyCRSF && echo "ttyCRSF=present" || echo "ttyCRSF=missing" ;;
esac
