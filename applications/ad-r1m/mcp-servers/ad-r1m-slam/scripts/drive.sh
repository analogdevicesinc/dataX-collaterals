# Wheel drive health, sourced by status.sh and diag.sh.
#
# A running robot container does NOT mean working wheels. If a CANopen drive fails its SDO
# boot, controller_manager never activates the controllers, /joint_states gets no publisher
# and robot_state_publisher cannot emit the wheel TF. EKF still publishes odom->base_link
# from the IMU alone, so TF checks look healthy too. Controller state and /joint_states are
# the authoritative signals.

drive_health() {
  local c=$1
  section controllers
  rosx "$c" "timeout -k 2 8 ros2 control list_controllers 2>/dev/null | sed -e 's/\x1b\[[0-9;]*m//g'"
  section joint_states
  rosx "$c" "timeout -k 2 8 ros2 topic info /joint_states 2>/dev/null | grep 'Publisher count' || echo 'Publisher count: 0'"
  # Evidence only, never a fault signal by itself: a healthy boot also logs "Wait for device
  # to boot..." and a transient drive_left "not activated" SDO error, while drive_right logs
  # nothing even when fine.
  section drive_log
  docker logs --tail 4000 "$c" 2>&1 \
    | grep -E 'Could not contact service /controller_manager|\[drive_[a-z]+\].*(ERROR|Wait for device to boot|timed out|Boot failed)|ros2_control_node.*process has died' \
    | tail -10
}

# can0 state, then ~1.5 s of CANopen heartbeat frames (COB-ID 0x701-0x77F) in candump -L form.
# Node IDs (bus.yml): drive_right 0x14, drive_left 0x16.
can_nodes() {
  section can
  echo "can=$(cat /sys/class/net/can0/operstate 2>/dev/null || echo missing)"
  timeout 1.5 candump -L can0,700:780 2>/dev/null
  true # timeout always exits 124
}

# drive_health, plus the CAN heartbeats when the drives are not healthy: they name a drive
# that is missing from the bus.
drive_check() {
  local out
  out=$(drive_health "$1")
  echo "$out"
  if ! { echo "$out" | grep -qE '^joint_state_broadcaster .*[[:space:]]active$' &&
         echo "$out" | grep -qE '^diff_drive_controller .*[[:space:]]active$' &&
         echo "$out" | grep -q 'Publisher count: [1-9]'; }; then
    can_nodes
  fi
}
