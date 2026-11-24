# package_evidence robot probe. $1: SLAM image; then apt names (checked as ros-<distro>-<name>),
# "--", ROS package names (checked in the SLAM container).
SLAM_IMAGE=$1
shift
APT=()
while [ $# -gt 0 ] && [ "$1" != -- ]; do APT+=("$1"); shift; done
shift
section arch; uname -m
section cpus; nproc
section mem_gb; awk '/MemTotal/{print int($2/1024/1024+0.5)}' /proc/meminfo
section cuda; { [ -e /dev/nvidia0 ] || command -v nvidia-smi >/dev/null; } && echo yes || echo no
section slam_image; docker image inspect "$SLAM_IMAGE" >/dev/null 2>&1 && echo yes || echo no
C=$(ros_container)
section distro; docker exec "$C" printenv ROS_DISTRO 2>/dev/null
section topics; rosx "$C" 'timeout -k 2 20 ros2 topic list -t 2>/dev/null'
section nodes; rosx "$C" 'timeout -k 2 20 ros2 node list 2>/dev/null'
# The SLAM container when it is running (without starting it), else the robot container.
S=$C
docker ps -q -f "name=^${R1M_SLAM_CONTAINER}\$" | grep -q . && S=$R1M_SLAM_CONTAINER
# One apt-cache call for all names; names apt does not know print nothing.
section apt
[ ${#APT[@]} -gt 0 ] && rosx "$S" 'apt-cache policy $(for p in "$@"; do printf "ros-%s-%s " "$ROS_DISTRO" "$p"; done) 2>/dev/null | awk "/^[^ ].*:\$/{n=\$1; sub(/:\$/, \"\", n)} /Candidate:/{print n \"=\" \$2}"' "${APT[@]}"
if [ "$S" = "$R1M_SLAM_CONTAINER" ]; then
  section ros_packages
  rosx "$S" 'ros2 pkg list 2>/dev/null'
fi
