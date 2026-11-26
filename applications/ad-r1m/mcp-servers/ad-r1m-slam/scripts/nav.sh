# nav tool, on the robot host. $1: start | stop | start_pointcloud
# start_pointcloud takes <file> <base64> pairs for the config folder's ros_data
# (/ros_data in the nav container).
#
# Nav2 on the ToF point cloud instead of /scan: the raw 512x512 /cam1/point_cloud is too heavy
# for the costmaps on the RPi 5, so nav_cloud_filter.py strides it into /cam1/point_cloud_nav
# and nav_pointcloud_launch.py runs the filter and Nav2 in one process. compose.yaml is left
# untouched: an override file swaps the nav command, and plain `start` restores the stock one.
ACTION=$1
shift
cd_config

case $ACTION in
  start) compose --profile nav up -d nav 2>&1 | tail -10 ;;
  stop) compose stop nav 2>&1 | tail -10 ;;
  start_pointcloud)
    mkdir -p ros_data
    while [ $# -ge 2 ]; do
      case "$1" in */*|*..*) echo "skipped $1" ;; *) write_b64 "ros_data/$1" "$2" && echo "wrote ros_data/$1" ;; esac
      shift 2
    done
    cat > compose.nav-pointcloud.yaml <<'EOF'
# Written by the ad-r1m-slam MCP tool (nav action=start_pointcloud): Nav2 on the ToF point
# cloud. nav action=start (plain `docker compose up -d nav`) restores compose.yaml's command.
services:
  nav:
    command: ros2 launch /ros_data/nav_pointcloud_launch.py
EOF
    compose -f compose.yaml -f compose.nav-pointcloud.yaml --profile nav up -d nav 2>&1 | tail -10
    ;;
  *) echo "unknown action $ACTION"; exit 2 ;;
esac
section containers
docker ps --format '{{.Names}}\t{{.Status}}'
