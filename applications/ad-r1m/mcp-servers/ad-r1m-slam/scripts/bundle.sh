# collect_support_bundle: what the AD-R1M docs' "Getting Help" (troubleshooting.rst) asks
# for, as a tarball. Prints its path; the server copies it to the PC and deletes it here.
D=$(mktemp -d /tmp/ad-r1m-support.XXXXXX)
{ hostname; uname -a; cat /etc/os-release; dpkg -l 'ad-r1m*' | awk '/^ii/'; ad-r1m --version; } > "$D/versions.txt" 2>&1
for u in ad-r1m-slcan ad-r1m-crsf ad-r1m-imu ad-r1m-tof ad-r1m-bringup ad-r1m-status-led-watchdog; do
  echo "$u=$(systemctl is-active "$u.service")"
done > "$D/services.txt" 2>&1
journalctl -b --no-pager -u 'ad-r1m*' | tail -5000 > "$D/journal.txt" 2>&1
docker ps -a > "$D/docker_ps.txt" 2>&1
(cd_config && pwd && compose logs --no-color --tail 2000) > "$D/compose_logs.txt" 2>&1
C=$(ros_container)
rosx "$C" 'echo "## topics"; timeout -k 2 20 ros2 topic list; echo "## nodes"; timeout -k 2 20 ros2 node list' > "$D/ros2.txt" 2>&1
docker logs --tail 500 "$R1M_SLAM_CONTAINER" > "$D/slam_workspace.txt" 2>&1
{ nmcli dev status; ip addr; } > "$D/network.txt" 2>&1
df -h > "$D/disk.txt" 2>&1
tar czf "$D.tar.gz" -C /tmp "$(basename "$D")" && rm -rf "$D" && echo "bundle=$D.tar.gz"
