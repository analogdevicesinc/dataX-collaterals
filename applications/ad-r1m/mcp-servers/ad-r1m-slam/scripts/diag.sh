# diagnostics tool. $1: slam | nav. Measurements only; the skills say how to read them.
TARGET=$1
C=$(ros_container)

if [ "$TARGET" = nav ]; then
  rosx "$C" '
echo "### lifecycle"
for n in /controller_server /planner_server /behavior_server /bt_navigator; do
  # grep: rmw_zenoh may print a WARN on stdout first
  echo "$n=$(timeout -k 2 8 ros2 lifecycle get $n 2>/dev/null | grep -m1 -E "^(unconfigured|inactive|active|finalized)" || true)"
done
echo "### publishers"
for t in /global_costmap/costmap /local_costmap/costmap /plan /map; do
  echo "$t=$(timeout -k 2 8 ros2 topic info $t 2>/dev/null | sed -n "s/Publisher count: //p")"
done'
  exit 0
fi

# `ros2 topic hz` needs 1-2 s of CLI startup on the Pi before its first "average rate" line,
# so shorter samples (the old 3 s) mostly read 0 Hz. Every bounded ros2 call uses timeout -k:
# on /cam1/point_cloud over rmw_zenoh "ros2 topic hz" ignores SIGTERM, so a plain timeout left
# it running, the batch's `wait` never returned and each call leaked a process.
rosx "$C" '
echo "### nodes"
# SLAM nodes only (tested templates and catalog packages). Nodes of the robot stack
# (/crsf_node, /twist_mux, ...) stay out, so an empty list means no SLAM is running.
ros2 node list 2>/dev/null | grep -iE "rtabmap|slam|mola|kiss|orb|icp|cartographer|octomap|odometry|preprocess"
echo "### publishers"
for t in /map /scan /cam1/point_cloud /odometry/filtered; do
  echo "$t=$(timeout -k 2 8 ros2 topic info $t 2>/dev/null | sed -n "s/Publisher count: //p")"
done
echo "### hz"
for t in /scan /cam1/point_cloud /odometry/filtered; do
  ( r=$(timeout -k 2 6 ros2 topic hz $t --window 20 2>/dev/null | grep -m1 "average rate" | sed "s/.*average rate: //"); echo "$t=${r:-0}" ) &
done
wait
echo "### tf"
for p in "map odom" "odom base_link"; do
  timeout -k 2 3 ros2 run tf2_ros tf2_echo $p 2>&1 | grep -q Translation && echo "${p// /->}=ok" || echo "${p// /->}=missing"
done'
drive_check "$C"
tof_clock "$C"

section rtabmap
if [ "$(ensure_slam_container)" != missing ]; then
  rosx "$R1M_SLAM_CONTAINER" '
top -b -n 1 | awk "/rtabmap/ && !/awk/ {print \"cpu_percent=\" \$9; print \"mem_percent=\" \$10; exit}"
timeout -k 2 10 ros2 param dump /rtabmap 2>/dev/null | grep -E "MemoryThr|TimeThr|MaxFeatures|RayTracing|DetectionRate|ProximityBySpace" | sed "s/^ *//"'
fi
