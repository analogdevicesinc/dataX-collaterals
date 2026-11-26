# Prepended to every robot script by lib/ssh.mjs, after the R1M_* settings it passes:
#   R1M_ROS_DISTRO, R1M_ROS_CONTAINER (empty = detect), R1M_SLAM_CONTAINER.
# Arguments always arrive as "$@", never pasted into the script text.

export ROS_DISTRO="${ROS_DISTRO:-$R1M_ROS_DISTRO}"
# Under sudo (scripts run as root), $HOME can be root's: paths below use the SSH user's home.
R1M_HOME=$(getent passwd "${SUDO_USER:-$(id -un)}" | cut -d: -f6)

section() { echo "### $1"; }

# The config folder the robot boots with: ad-r1m-bringup.service's WorkingDirectory, which
# `ad-r1m enable <folder>` sets (default /usr/share/ad-r1m/default-config). Running compose
# from a different folder would drive the same `ad-r1m` project with another compose.yaml.
# Falls back to ~/demo, seeded from the default config, when the service is missing.
cd_config() {
  CFG=$(systemctl show -p WorkingDirectory --value ad-r1m-bringup.service 2>/dev/null)
  if [ -z "$CFG" ] || [ ! -f "$CFG/ad-r1m.env" ]; then
    CFG=$R1M_HOME/demo
    [ -d "$CFG" ] || { mkdir -p "$CFG" && cp -r /usr/share/ad-r1m/default-config/* "$CFG"/; }
  fi
  cd "$CFG" || exit 1
}
compose() { docker compose --env-file ad-r1m.env "$@"; }

# The robot's ROS container (ad-r1m-robot-1 on a stock robot). The Zenoh router's container
# also matches "robot", so it is excluded.
ros_container() {
  if [ -n "$R1M_ROS_CONTAINER" ]; then echo "$R1M_ROS_CONTAINER"; return; fi
  docker ps --format '{{.Names}}' | grep -E 'robot|ros' | grep -v zenoh | head -1 | grep . || echo ad-r1m-robot-1
}

# rosx <container> <script> [args...]: run bash with ROS sourced inside a container.
# The script goes to a temp file over stdin, never onto bash's command line: `pkill -f
# <pattern>` would otherwise match (and kill) the very shell that runs it.
rosx() {
  local c=$1 s=$2
  shift 2
  printf 'export ROS_DISTRO=${ROS_DISTRO:-%s}\nsource /opt/ros/$ROS_DISTRO/setup.bash; source /ros2_ws/install/setup.bash 2>/dev/null || true\n%s\n' \
    "$ROS_DISTRO" "$s" |
    docker exec -i "$c" sh -c 'F=$(mktemp); cat > "$F"; bash "$F" "$@" </dev/null; r=$?; rm -f "$F"; exit $r' rosx "$@"
}

# Start the SLAM container if it is merely stopped; prints running / started / missing.
ensure_slam_container() {
  if docker ps -q -f "name=^${R1M_SLAM_CONTAINER}\$" | grep -q .; then echo running
  elif docker start "$R1M_SLAM_CONTAINER" >/dev/null 2>&1; then echo started
  else echo missing; fi
}

# write_b64 <dest> <base64>: files are passed base64-encoded as arguments.
write_b64() { mkdir -p "$(dirname "$1")" && printf '%s' "$2" | base64 -d > "$1"; }
