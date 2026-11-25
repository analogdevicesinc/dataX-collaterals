# setup_workspace: the SLAM container and the SLAM package's dependencies.
# $1 package  $2 repo (or "")  $3 slam image  $4 stock robot image  $5 RMW  $6 extra deps (space-separated)
#
# One SLAM image for every package: the robot image's name with tag robot-slam. The container
# starts from it when it exists (else from the stock image), rosdep installs the package on
# top, and the container is committed back - packages accumulate and later setups only
# install what is new.
PKG=$1 REPO=$2 SLAM_IMAGE=$3 STOCK_IMAGE=$4 RMW=$5 EXTRA=$6
C=$R1M_SLAM_CONTAINER
have_image() { docker image inspect "$1" >/dev/null 2>&1; }

section image
if have_image "$SLAM_IMAGE"; then IMAGE=$SLAM_IMAGE; echo "prebuilt=yes"
elif have_image "$STOCK_IMAGE"; then IMAGE=$STOCK_IMAGE; echo "prebuilt=no"
else
  # docker run would try to pull it and fail with an opaque "unauthorized".
  echo "stock_image=missing"; exit 0
fi
echo "image=$IMAGE"

# Recreate the container unless it already runs the image it should: a container from another
# image (e.g. a legacy per-package image) would hide what robot-slam has.
CUR=$(docker inspect -f '{{.Config.Image}}' "$C" 2>/dev/null) || CUR=missing
if [ "$CUR" = "$IMAGE" ]; then ensure_slam_container >/dev/null; echo "container=reused"
else
  [ "$CUR" != missing ] && docker rm -f "$C" >/dev/null 2>&1
  docker run -d --name "$C" --privileged --network host -v /dev:/dev --ulimit core=0 --init \
    -e RMW_IMPLEMENTATION="$RMW" -e ROS_DISTRO="$ROS_DISTRO" "$IMAGE" tail -f /dev/null >/dev/null || { echo "container=failed"; exit 0; }
  [ "$CUR" = missing ] && echo "container=created" || echo "container=recreated"
fi
# Former per-package images, superseded by robot-slam: free their ~10 GB.
docker rmi rtab-image:latest >/dev/null 2>&1

# Everything below runs inside the container.
OUT=$(rosx "$C" '
PKG=$1 REPO=$2 EXTRA=$3
S=/ros2_ws/src/slam_integration
mkdir -p $S/launch $S/config
{
  echo "<?xml version=\"1.0\"?>"
  echo "<package format=\"3\"><name>slam_integration</name><version>0.1.0</version>"
  echo "<description>SLAM integration for AD-R1M</description><maintainer email=\"analog@analog.com\">ADI</maintainer>"
  echo "<license>Apache-2.0</license><buildtool_depend>ament_cmake</buildtool_depend><depend>rclpy</depend>"
  for d in $PKG $EXTRA; do echo "<depend>$d</depend>"; done
  echo "<export><build_type>ament_cmake</build_type></export></package>"
} > $S/package.xml
printf "%s\n" "cmake_minimum_required(VERSION 3.8)" "project(slam_integration)" "find_package(ament_cmake REQUIRED)" \
  "install(DIRECTORY launch config DESTINATION share/\${PROJECT_NAME})" "ament_package()" > $S/CMakeLists.txt

rosdep_install() {
  echo "### rosdep"
  for i in 1 2 3 4 5; do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; echo "waiting for dpkg lock"; sleep 5; done
  # The image apt index goes stale (404s on .deb downloads), so always refresh it first.
  apt-get update -qq >/dev/null 2>&1 || echo "WARNING: apt-get update failed"
  # The runner image (what build_robot_image builds, like the release CI) has neither rosdep
  # nor colcon; deploying a launch file and source builds need both.
  command -v rosdep >/dev/null || apt-get install -y -qq python3-rosdep git >/dev/null 2>&1
  command -v colcon >/dev/null || apt-get install -y -qq python3-colcon-common-extensions >/dev/null 2>&1
  command -v rosdep >/dev/null || { echo "rosdep_unavailable=yes"; return; }
  [ -f /etc/ros/rosdep/sources.list.d/20-default.list ] || rosdep init >/dev/null 2>&1
  rosdep update --rosdistro $ROS_DISTRO > /tmp/rosdep_update.log 2>&1
  # Only these paths: the robot packages in /ros2_ws/src pull gazebo deps that do not exist on arm64.
  rosdep install -y -r --from-paths "$@" --ignore-src --rosdistro $ROS_DISTRO > /tmp/rosdep_install.log 2>&1
  echo "rosdep_exit=$?"
  # Keys rosdep cannot map (e.g. Pangolin) often exist as Debian binaries under the ROS naming
  # rule: lower case, dashes for underscores (ros-humble-pangolin).
  for k in $(sed -n "s/.*Cannot locate rosdep definition for \[\([^]]*\)\].*/\1/p" /tmp/rosdep_install.log | sort -u); do
    a="ros-$ROS_DISTRO-$(echo "$k" | tr "A-Z_" "a-z-")"
    if apt-cache policy "$a" 2>/dev/null | grep -q "Candidate: [0-9]" && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$a" >/dev/null 2>&1
    then echo "resolved_via_apt=$k"; else echo "unresolved=$k"; fi
  done
}
# Already set up: skip apt, rosdep and the commit below (minutes, and the commit pauses SLAM).
installed() { for p in "$@"; do ros2 pkg prefix "$p" >/dev/null 2>&1 || return 1; done; }
if installed $PKG $EXTRA; then echo "### rosdep"; echo "skipped=already installed"; else rosdep_install $S; fi

# No rosdep rule for the package: try its Debian name (orb_slam3_ros2 -> ros-humble-orb-slam3-ros2).
source /opt/ros/$ROS_DISTRO/setup.bash
installed "$PKG" || {
  a="ros-$ROS_DISTRO-$(echo "$PKG" | tr "_" "-")"
  apt-cache policy "$a" 2>/dev/null | grep -q "Candidate: [0-9]" && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$a" >/tmp/apt_pkg.log 2>&1 && echo "installed_via_apt=$a"
}

# Still missing and a repo is known: clone (with submodules: SLAM repos often vendor their core
# library as one), rosdep its dependencies and build from source.
source /opt/ros/$ROS_DISTRO/setup.bash
if ! installed "$PKG" && [ -n "$REPO" ]; then
  echo "### clone"
  D=/ros2_ws/src/$(basename "${REPO%.git}")
  if [ -d "$D/.git" ]; then
    git -C "$D" pull --depth 1 2>&1 | tail -2
    git -C "$D" submodule update --init --recursive --depth 1 2>&1 | tail -2
  else
    rm -rf "$D"
    git clone --depth 1 --recurse-submodules --shallow-submodules -- "$REPO" "$D" 2>&1 | tail -3
  fi
  if [ -d "$D" ]; then
    rosdep_install $S "$D"
    echo "### build"
    # Build the ROS packages the repo actually contains: names often differ from the repo or
    # catalog name (ORB_SLAM3_ROS2 ships "orbslam3").
    PKGS=$(find "$D" -name package.xml -not -path "*/test/*" -exec sed -n "s:.*<name>\s*\([A-Za-z0-9_-]*\).*:\1:p" {} + | sort -u | tr "\n" " ")
    echo "repo_packages=$PKGS"
    if [ -n "$PKGS" ]; then
      cd /ros2_ws && colcon build --packages-up-to $PKGS --symlink-install 2>&1 | tail -40
      echo "build_exit=${PIPESTATUS[0]}"
      source /ros2_ws/install/setup.bash 2>/dev/null
      for p in $PKGS; do ros2 pkg prefix $p >/dev/null 2>&1 && echo "built=$p" || echo "not_built=$p"; done
    fi
  fi
fi
source /ros2_ws/install/setup.bash 2>/dev/null
rm -f /ros2_ws/core.*  # never commit crash dumps into robot-slam
echo "### result"
installed "$PKG" && echo "package=installed" || echo "package=missing"
' "$PKG" "$REPO" "$EXTRA")
echo "$OUT"
case $OUT in *"skipped=already installed"*) exit 0 ;; esac

# Save what was installed so the next setup (any package) starts from it, then drop the image
# it replaced when nothing uses it any more.
if rosx "$C" 'ros2 pkg prefix "$1"' "$PKG" >/dev/null 2>&1; then
  OLD=$(docker image inspect -f '{{.Id}}' "$SLAM_IMAGE" 2>/dev/null)
  if docker commit "$C" "$SLAM_IMAGE" >/dev/null 2>&1; then
    NEW=$(docker image inspect -f '{{.Id}}' "$SLAM_IMAGE")
    [ -n "$OLD" ] && [ "$OLD" != "$NEW" ] && docker rmi "$OLD" >/dev/null 2>&1
    echo "committed=$SLAM_IMAGE"
  fi
fi
