# slam tool, in the SLAM container. $1: deploy | start | stop
# deploy and start take <path> <base64> pairs, path = launch/<file> or config/<file> in the
# slam_integration package. start deploys them first (a tested template), then launches
# launch.py.
ACTION=$1
shift

case $(ensure_slam_container) in
  missing) echo "container=missing"; exit 0 ;;
esac

# Kill every ROS process in the container, whatever the package: SIGTERM, then SIGKILL after
# 2 s. A list of names missed packages it did not know (an orphaned slam_toolbox kept
# publishing /map next to MOLA), and rclpy nodes can hang in shutdown. Only SLAM runs here.
KILL='
P="/opt/ros/[^ ]*/(lib|bin)/|/ros2_ws/install/|ros2 launch"
pkill -f "$P" 2>/dev/null
for i in 1 2 3 4; do pgrep -f "$P" >/dev/null || break; sleep 0.5; done
pkill -9 -f "$P" 2>/dev/null
true'

# One colcon build for all files; the previous version of each file is kept as <file>.prev.
DEPLOY='
S=/ros2_ws/src/slam_integration
while [ $# -ge 2 ]; do
  f=$1; data=$2; shift 2
  case "$f" in launch/*/*|config/*/*|*..*) echo "skipped $f"; continue ;; launch/*|config/*) ;; *) echo "skipped $f"; continue ;; esac
  [ -f "$S/$f" ] && cp -f "$S/$f" "$S/$f.prev"
  mkdir -p "$S/$(dirname "$f")" && printf "%s" "$data" | base64 -d > "$S/$f" && echo "wrote $f"
  case "$f" in launch/*.py) chmod +x "$S/$f" ;; esac
done
cd /ros2_ws && colcon build --packages-select slam_integration --symlink-install 2>&1 | tail -8
echo "build_exit=${PIPESTATUS[0]}"'

START='
section() { echo "### $1"; }
section topics
ros2 topic list 2>/dev/null | grep -E "/scan|/odometry/filtered|/cam1|/camera1/(depth|infra1)"
[ -f /ros2_ws/install/slam_integration/share/slam_integration/launch/launch.py ] || { echo "launch=missing"; exit 0; }
ulimit -c 0  # RTAB-Map can abort on stop; its ~0.5 GB core dumps filled the disk via commits
nohup ros2 launch slam_integration launch.py > /tmp/slam.log 2>&1 < /dev/null &
sleep 4
# The launch process is the signal: a launch that died still leaves robot nodes such as
# /crsf_node in the graph, so a node count proves nothing.
section launch
pgrep -f "ros2 launch slam_integration" || echo none
section nodes
# SLAM nodes only (tested templates and catalog packages). Nodes of the robot stack
# (/crsf_node, /twist_mux, ...) stay out, so an empty list means no SLAM is running.
ros2 node list 2>/dev/null | grep -iE "rtabmap|slam|mola|kiss|orb|icp|cartographer|octomap|odometry|preprocess"
section log
pgrep -f "ros2 launch slam_integration" >/dev/null || tail -20 /tmp/slam.log 2>/dev/null'

case $ACTION in
  deploy) section deploy; rosx "$R1M_SLAM_CONTAINER" "$DEPLOY" "$@" ;;
  start)
    if [ $# -gt 0 ]; then section deploy; rosx "$R1M_SLAM_CONTAINER" "$DEPLOY" "$@"; fi
    rosx "$R1M_SLAM_CONTAINER" "$KILL"
    rosx "$R1M_SLAM_CONTAINER" "$START"
    ;;
  stop) rosx "$R1M_SLAM_CONTAINER" "$KILL"; echo "stopped=yes" ;;
  *) echo "unknown action $ACTION"; exit 2 ;;
esac
