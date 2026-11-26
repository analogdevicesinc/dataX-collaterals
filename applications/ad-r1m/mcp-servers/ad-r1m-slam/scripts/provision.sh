# provision_robot steps: $1 = step, then its arguments. Secrets (Wi-Fi password, Cloudsmith
# user/token) arrive on stdin, one per line, never on a command line here or on the robot.
# Steps marked (root) are run through sudo by the server; the others as the SSH user.
STEP=$1
shift

case $STEP in
  wifi) # (root) stdin: SSID, password (may be empty)
    IFS= read -r SSID
    IFS= read -r PW
    nmcli dev wifi rescan 2>/dev/null; sleep 3
    if [ -n "$PW" ]; then nmcli dev wifi connect "$SSID" password "$PW"; else nmcli dev wifi connect "$SSID"; fi
    ip -4 -o addr show scope global 2>/dev/null | awk '$2 ~ /^wl/ {print "wifi address: " $4}'
    ;;

  hostname) # (root) $1 new hostname
    set -e
    NEW=$1 OLD=$(hostname)
    hostnamectl set-hostname "$NEW"
    if [ "$OLD" != localhost ] && [ "$OLD" != "$NEW" ]; then sed -i "s/\b$OLD\b/$NEW/g" /etc/hosts; fi
    grep -qw "$NEW" /etc/hosts || printf '127.0.1.1\t%s\n' "$NEW" >> /etc/hosts
    systemctl restart avahi-daemon 2>/dev/null || true
    echo "hostname: $OLD -> $(hostname)"
    ;;

  upgrade) # (root)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update 2>&1 | tail -2
    apt-get upgrade -y 2>&1 | tail -5
    ;;

  cloudsmith_apt) # (root) stdin: user, token. They reach curl through a config on its stdin (-K -).
    IFS= read -r CS_USER
    IFS= read -r CS_TOKEN
    set -o pipefail
    printf 'user = "%s:%s"\n' "$CS_USER" "$CS_TOKEN" |
      curl -K - -1sLf https://dl.cloudsmith.io/basic/adi/adrd-common/setup.deb.sh | bash 2>&1 | tail -5
    ;;

  install) # (root) $1 package
    set -o pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update 2>&1 | tail -3
    apt-get install -y "$1" 2>&1 | tail -15
    ;;

  docker) # (root) $1 image, $2 SSH user; stdin: Cloudsmith user, token
    IFS= read -r CS_USER
    IFS= read -r CS_TOKEN
    getent group docker >/dev/null || groupadd docker
    usermod -aG docker "$2" && echo "$2: added to docker group"
    # Clear a stuck daemon before pulling: kill hung pulls, drop partial layer downloads
    # (classic store and containerd image store), restart, prune. A stalled earlier pull
    # otherwise makes every docker command wait forever. The pattern is anchored so pkill
    # cannot match its own shell.
    pkill -f "^docker pull" 2>/dev/null || true
    timeout 60 systemctl stop docker docker.socket containerd || { pkill -9 -x dockerd; pkill -9 -x containerd; } || true
    rm -rf /var/lib/docker/tmp/* /var/lib/containerd/io.containerd.content.v1.content/ingest/*
    systemctl start containerd docker
    timeout 120 docker system prune -a -f 2>&1 | tail -1
    set -o pipefail
    # Root's login must land in /root/.docker (the bringup service pulls as root); sudo may
    # keep the caller's HOME.
    export HOME=/root
    LOGIN=$(printf '%s' "$CS_TOKEN" | docker login docker.cloudsmith.io -u "$CS_USER" --password-stdin 2>&1 | tail -1)
    echo "root: $LOGIN"
    case "$LOGIN" in *"Login Succeeded"*) ;; *) echo "root docker login failed - not pulling"; exit 1 ;; esac
    docker pull "$1" 2>&1 | tail -3
    ;;

  user_docker_login) # stdin: Cloudsmith user, token. Under `sg docker` so the new group applies without re-login.
    IFS= read -r CS_USER
    IFS= read -r CS_TOKEN
    printf '%s\n%s\n' "$CS_USER" "$CS_TOKEN" | sg docker -c 'IFS= read -r U; IFS= read -r T; printf "%s" "$T" | docker login docker.cloudsmith.io -u "$U" --password-stdin 2>&1 | tail -1'
    ;;

  demo_config) # $1 ad-r1m-ros2 ref. As the SSH user, so ~/demo and ~/ad-r1m-ros2 are theirs.
    # ~/demo from `ad-r1m mkconfig`, refreshed from the repo's default-config at the ref
    # (newer than the packaged one); replaced files kept as *.bak. Prints CONFIG_REF and, when
    # build_robot_image built the image, IMAGE_REF - the two should match.
    set -e
    REF=$1
    [ -f ~/demo/ad-r1m.env ] || ad-r1m mkconfig ~/demo
    if [ -d ~/ad-r1m-ros2/.git ]; then git -C ~/ad-r1m-ros2 fetch --quiet --tags origin
    else git clone --quiet https://github.com/analogdevicesinc/ad-r1m-ros2.git ~/ad-r1m-ros2; fi
    git -C ~/ad-r1m-ros2 rev-parse --verify --quiet "origin/$REF^{commit}" >/dev/null && REV="origin/$REF" || REV="$REF"
    git -C ~/ad-r1m-ros2 checkout --quiet --detach "$REV" 2>&1 || { echo "ad-r1m-ros2: cannot check out $REF (local changes?)"; exit 1; }
    echo "CONFIG_REF=$REF $(git -C ~/ad-r1m-ros2 rev-parse --short HEAD)"
    SRC=~/ad-r1m-ros2/system/rpi5/usr/share/ad-r1m/default-config
    [ -d "$SRC" ] || { echo "missing $SRC in ad-r1m-ros2 at $REF"; exit 1; }
    cp -r --backup=simple --suffix=.bak "$SRC"/. ~/demo/
    B=~/.cache/ad-r1m-slam/image-build
    [ -f "$B/build.ref" ] && [ "$(cat "$B/build.exit" 2>/dev/null)" = 0 ] && echo "IMAGE_REF=$(cat "$B/build.ref")"
    echo "DEMO=$(realpath ~/demo)"
    ls ~/demo
    ;;

  enable_config) # (root) $1 folder, $2 restart bringup (1/0)
    ad-r1m enable "$1" 2>&1 || exit 1
    [ "$2" = 1 ] && systemctl restart ad-r1m-bringup.service 2>&1
    true
    ;;

  active_config)
    # Read outside sudo: the server masks the sudo password in root output, and on a default
    # robot it equals the user name, so /home/analog/demo would read /home/***/demo.
    systemctl show -p WorkingDirectory --value ad-r1m-bringup.service 2>/dev/null
    ;;

  reboot) # (root) detached, so the SSH session returns before the network goes down
    setsid -f sh -c 'sleep 2; systemctl reboot' >/dev/null 2>&1 </dev/null
    echo rebooting
    ;;

  *) echo "unknown step $STEP"; exit 2 ;;
esac
