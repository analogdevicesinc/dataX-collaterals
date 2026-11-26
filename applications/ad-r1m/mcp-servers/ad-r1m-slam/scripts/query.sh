# ros2_query (read-only). $1: topics | topic_info <topic> | nodes | params <node> |
# logs <container> <lines> | read <slam|host> <path>
KIND=$1
shift
C=$(ros_container)
# "~/x" means the SSH user's home on the robot (the caller cannot expand it).
expand() { case "$1" in "~") echo "$R1M_HOME" ;; "~/"*) echo "$R1M_HOME/${1#\~/}" ;; *) echo "$1" ;; esac; }

case $KIND in
  topics) rosx "$C" 'timeout -k 2 20 ros2 topic list -t 2>/dev/null' ;;
  topic_info) rosx "$C" 'timeout -k 2 15 ros2 topic info -v "$1" 2>&1' "$1" ;;
  nodes) rosx "$C" 'timeout -k 2 20 ros2 node list 2>/dev/null' ;;
  params) rosx "$C" 'timeout -k 2 15 ros2 param dump "$1" 2>&1' "$1" ;;
  logs)
    if docker ps -a --format '{{.Names}}' | grep -qx -- "$1"; then
      docker logs --tail "${2:-50}" "$1" 2>&1
    else
      echo "No container named $1. Containers:"
      docker ps -a --format '{{.Names}}\t{{.Status}}'
    fi
    ;;
  read)
    if [ "$1" = host ]; then cat -- "$(expand "$2")"
    else docker exec "$R1M_SLAM_CONTAINER" cat -- "$2"; fi
    ;;
  *) echo "unknown query $KIND"; exit 2 ;;
esac
