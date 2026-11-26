# robot_config: the robot's `ad-r1m` CLI and its config folders.
# $1: active | list | mkconfig <folder> | resolve <folder> | enable <abs folder> <restart 0|1>
# enable runs as root; resolve first, as the SSH user, since $HOME differs under sudo.
ACTION=$1
shift
ACTIVE() { systemctl show -p WorkingDirectory --value ad-r1m-bringup.service 2>/dev/null; }
expand() { case "$1" in "~") echo "$R1M_HOME" ;; "~/"*) echo "$R1M_HOME/${1#\~/}" ;; *) echo "$1" ;; esac; }

case $ACTION in
  active) echo "active=$(ACTIVE)" ;;
  list)
    echo "active=$(ACTIVE)"
    section folders
    find "$R1M_HOME" -maxdepth 3 -name ad-r1m.env -not -path '*/.*' -printf '%h\n' 2>/dev/null
    ;;
  mkconfig) D=$(expand "$1"); ad-r1m mkconfig "$D" 2>&1 && ls "$D" ;;
  resolve)
    D=$(realpath -m "$(expand "$1")")
    echo "path=$D"
    [ -f "$D/ad-r1m.env" ] && echo "config=yes" || echo "config=no"
    ;;
  enable)
    ad-r1m enable "$1" 2>&1 || exit 1
    [ "$2" = 1 ] && systemctl restart ad-r1m-bringup.service 2>&1
    echo "active=$(ACTIVE)"
    ;;
  *) echo "unknown action $ACTION"; exit 2 ;;
esac
