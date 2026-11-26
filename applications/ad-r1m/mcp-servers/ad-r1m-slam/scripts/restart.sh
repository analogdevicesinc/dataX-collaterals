# restart tool. $1: stack | slcan | crsf | imu | tof. Runs as root.
# Always: stop ad-r1m-bringup, compose down, restart the hardware unit (if any), start
# ad-r1m-bringup. `compose stop` + `start` reuses the containers and did not clear a failed
# CANopen drive boot; `up -d` would leave ad-r1m-bringup inactive.
# Units: slcan resets can0 and the drives, crsf the RC receiver, imu the ADIS16470 rate,
# tof the camera clock and its ROS node.
TARGET=$1
cd_config

case $TARGET in
  stack) UNIT= ;;
  slcan|crsf|imu|tof) UNIT=ad-r1m-$TARGET ;;
  *) echo "unknown target $TARGET"; exit 2 ;;
esac

running() { compose ps --services --status running 2>/dev/null | sort; }
BEFORE=$(running)
echo "was_running=$(echo $BEFORE)"
systemctl stop ad-r1m-bringup.service 2>/dev/null
compose down 2>&1 | grep -v COMPOSE_PROFILES | tail -5

if [ -n "$UNIT" ]; then
  section unit
  systemctl restart "$UNIT.service" 2>&1
  echo "active=$(systemctl is-active "$UNIT.service")"
  journalctl -u "$UNIT.service" -n 8 --no-pager -o cat 2>/dev/null
fi

systemctl start ad-r1m-bringup.service 2>/dev/null || compose up -d 2>&1 | tail -5
WANT=$(compose config --services 2>/dev/null | wc -l)
for _ in $(seq 60); do [ "$(running | wc -l)" -ge "$WANT" ] && break; sleep 1; done
section result
echo "bringup=$(systemctl is-active ad-r1m-bringup.service 2>/dev/null)"
# Profile services (slam, nav) are not part of bringup: their own tools start them again.
echo "not_restarted=$(comm -23 <(echo "$BEFORE") <(running) | tr '\n' ' ')"
section containers
docker ps --format '{{.Names}}\t{{.Status}}'
tof_clock "$(ros_container)" 30

case $TARGET in
  slcan) can_nodes ;;
  crsf) section crsf; test -e /dev/ttyCRSF && echo "ttyCRSF=present" || echo "ttyCRSF=missing" ;;
esac
