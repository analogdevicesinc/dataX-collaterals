# slam_set_params: <name> <value> pairs for /rtabmap.
# RTAB-Map declares every parameter as a string, so values go as quoted YAML strings ('30',
# not 30, which ros2 param set would send as an integer and the node would reject). ros2
# param set exits 0 even when the node refuses, so success is read from its output.
rosx "$(ros_container)" '
while [ $# -ge 2 ]; do
  R=$(timeout -k 2 15 ros2 param set /rtabmap "$1" "'"'"'$2'"'"'" 2>&1)
  case "$R" in *"Set parameter successful"*) echo "ok $1" ;; *) echo "fail $1 $(echo "$R" | tr "\n" " ")" ;; esac
  shift 2
done' "$@"
