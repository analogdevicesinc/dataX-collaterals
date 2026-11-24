# connect_robot / robot_status. $1: probe (connection + onboarding state only) | status | full
MODE=${1:-status}

section probe
echo "hostname=$(hostname)"
. /etc/os-release 2>/dev/null; echo "os=$PRETTY_NAME"
echo "model=$(tr -d '\0' </proc/device-tree/model 2>/dev/null)"
echo "pkgs=$(dpkg -l 'ad-r1m-system*' 2>/dev/null | awk '/^ii/{print $2"="$3}' | paste -sd, -)"
echo "cli=$(ad-r1m --version 2>/dev/null)"
echo "containers=$(docker ps --format '{{.Names}}' 2>/dev/null | paste -sd, -)"
echo "configdir=$(systemctl show -p WorkingDirectory --value ad-r1m-bringup.service 2>/dev/null)"
echo "ifaces=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $2":"$4}' | paste -sd, -)"
[ "$MODE" = probe ] && exit 0

C=$(ros_container)
echo "ros_container=$C"
if docker ps --format '{{.Names}}' | grep -qx "$C"; then
  # Never truncated: the sensor flags come from this sorted list, and a `head -30` once
  # dropped /odometry/filtered and /scan on a 52-topic robot.
  section topics
  rosx "$C" 'timeout -k 2 20 ros2 topic list 2>/dev/null'
  drive_check "$C"
fi
[ "$MODE" = full ] || exit 0

section services
for u in ad-r1m-slcan ad-r1m-crsf ad-r1m-imu ad-r1m-tof ad-r1m-bringup ad-r1m-status-led-watchdog; do
  echo "$u=$(systemctl is-active "$u.service" 2>/dev/null)"
done
section packages; dpkg -l 'ad-r1m*' 2>/dev/null | awk '/^ii/{print $2"="$3}'
section upgradable; apt list --upgradable 2>/dev/null | grep -i 'ad-r1m'
section images; docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedSince}}' 2>/dev/null | grep -Ei 'ad-r1m|rtab|slam'
section network
nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev status 2>/dev/null | grep -v ':loopback:'
echo "wifi=$(nmcli -t -f ACTIVE,SSID,SIGNAL dev wifi list --rescan no 2>/dev/null | grep '^yes' | head -1 | sed 's/^yes://')"
section system
echo "disk=$(df -h / | awk 'NR==2{print $3" used / "$2" ("$5")"}')"
echo "temp_mC=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)"
echo "uptime=$(uptime -p)"
