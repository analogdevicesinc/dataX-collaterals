# build_robot_image. Builds the robot runtime image on the robot from ad-r1m-ros2's
# docker/Dockerfile the way its release CI does (target runner, BUILD_PACKAGES=ad_r1m_robot,
# native arm64), tagged with the name compose and setup_workspace expect - `docker compose up`
# only pulls missing images, so the local build is used as is. Optionally also builds the
# ad-r1m-system-rpi5 .deb (Architecture: all) from the same clone.
#
# $1: preflight <image> | status <image> | stop | start <ref> <image> <distro> <target> <system_package 0|1>
#     | prereq <user> <apt packages...> (root) | install_deb <deb> (root) | job ... (internal)
D=$R1M_HOME/.cache/ad-r1m-slam/image-build
REPO=https://github.com/analogdevicesinc/ad-r1m-ros2.git
ACTION=$1
shift
free_gb() { local d=/var/lib/docker; [ -d "$d" ] || d=/; df -BG --output=avail "$d" 2>/dev/null | tail -1 | tr -dc 0-9; }

case $ACTION in
  preflight)
    echo "arch=$(uname -m)"
    command -v git >/dev/null && echo git=1 || echo git=0
    docker buildx version >/dev/null 2>&1 && echo buildx=1 || echo buildx=0
    docker info >/dev/null 2>&1 && echo access=1 || { id -nG | grep -qw docker && echo access=1 || echo access=0; }
    command -v debuild >/dev/null && command -v dh >/dev/null && echo deb_tools=1 || echo deb_tools=0
    echo "free_gb=$(free_gb)"
    sg docker -c "docker image inspect $(printf '%q' "$1")" >/dev/null 2>&1 && echo image=1 || echo image=0
    if dpkg -s docker-ce >/dev/null 2>&1; then echo docker_pkg=docker-ce
    elif dpkg -s docker.io >/dev/null 2>&1; then echo docker_pkg=docker.io; else echo docker_pkg=none; fi
    echo "latest=$(git ls-remote --tags --refs "$REPO" 2>/dev/null | sed 's#.*refs/tags/##' | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
    ;;

  status)
    PID=$(cat "$D/build.pid" 2>/dev/null)
    [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && echo running=1 || echo running=0
    [ -f "$D/build.exit" ] && echo "exit=$(cat "$D/build.exit")"
    [ -f "$D/build.ref" ] && echo "ref=$(cat "$D/build.ref")"
    [ -f "$D/build.start" ] && echo "elapsed_min=$(( ($(date +%s) - $(cat "$D/build.start")) / 60 ))"
    DEB=$(ls "$D"/src/packaging/build/ad-r1m-system-rpi5_*_all.deb 2>/dev/null | head -1)
    [ -n "$DEB" ] && echo "deb=$DEB"
    echo "free_gb=$(free_gb)"
    C=$(sg docker -c "docker image inspect -f '{{.Created}}' $(printf '%q' "$1")" 2>/dev/null)
    [ -n "$C" ] && echo "image_created=$C"
    echo "step=$(grep -aE '^(== |#[0-9]+ \[)' "$D/build.log" 2>/dev/null | tail -1 | cut -c1-160)"
    echo "log=$D/build.log"
    section tail
    tail -c 20000 "$D/build.log" 2>/dev/null | tr '\r' '\n' | grep -av '^\s*$' | tail -15
    ;;

  stop)
    G=$(cat "$D/build.pgid" 2>/dev/null)
    if [ -n "$G" ] && kill -- -"$G" 2>/dev/null; then sleep 2; echo 143 > "$D/build.exit"; echo stopped; else echo "no build running"; fi
    ;;

  prereq) # (root)
    U=$1
    shift
    if [ $# -gt 0 ]; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" 2>&1 | tail -3
    fi
    getent group docker >/dev/null || groupadd docker
    usermod -aG docker "$U"
    ;;

  install_deb) # (root)
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$1" 2>&1 | tail -5
    ;;

  start)
    # Detached: setsid -f gives the job its own process group (stop kills the group); sg docker
    # applies a fresh docker group membership without a re-login.
    mkdir -p "$D"
    rm -f "$D/build.exit" "$D/build.log" "$D/build.pid" "$D/build.pgid"
    echo "$1" > "$D/build.ref"
    cp "$0" "$D/job.sh"
    setsid -f sg docker -c "bash $(printf '%q ' "$D/job.sh" job "$@")" > "$D/build.log" 2>&1 < /dev/null
    sleep 3
    echo "pid=$(cat "$D/build.pid" 2>/dev/null)"
    ;;

  job) # <ref> <image> <distro> <target> <system_package>
    REF=$1 IMAGE=$2 DISTRO=$3 TARGET=$4 SYS=$5
    N=2; [ "$SYS" = 1 ] && N=3
    set -o pipefail
    # The job records itself: the launcher's $! can be a setsid parent that already exited.
    echo $$ > "$D/build.pid"; ps -o pgid= $$ | tr -d ' ' > "$D/build.pgid"
    trap 'echo $? > "$D/build.exit"' EXIT
    trap 'exit 143' TERM INT
    START=$(date +%s); echo "$START" > "$D/build.start"
    echo "== [1/$N] Clone ad-r1m-ros2 $REF"
    rm -rf "$D/src"
    git clone --depth 1 --branch "$REF" "$REPO" "$D/src" || exit 10
    cd "$D/src" || exit 10
    if [ "$SYS" = 1 ]; then
      echo "== [2/3] Build the ad-r1m-system-rpi5 package"
      mkdir -p "$D/home"
      printf 'DEBUILD_DPKG_BUILDPACKAGE_OPTS="-us -uc"\nDEBUILD_LINTIAN=no\n' > "$D/home/.devscripts"
      HOME="$D/home" DEBEMAIL="ad-r1m@localhost" DEBFULLNAME="AD-R1M local build" bash packaging/build_debian.sh -1 || exit 20
      ls packaging/build/ad-r1m-system-rpi5_*_all.deb || exit 21
    fi
    echo "== [$N/$N] docker build $TARGET -> $IMAGE"
    # BUILDKIT_SYNTAX: Debian's docker.io 26.1 parser rejects the Dockerfile's
    # --mount=type=secret,...,env= without it.
    DOCKER_BUILDKIT=1 docker build --progress=plain -f docker/Dockerfile --target "$TARGET" \
      --build-arg BUILDKIT_SYNTAX=docker/dockerfile:1 \
      --build-arg ROS_DISTRO="$DISTRO" --build-arg BUILD_PACKAGES=ad_r1m_robot \
      -t "$IMAGE" . || exit 30
    echo "== Done in $(( ($(date +%s) - START) / 60 )) min: $IMAGE"
    ;;

  *) echo "unknown action $ACTION"; exit 2 ;;
esac
