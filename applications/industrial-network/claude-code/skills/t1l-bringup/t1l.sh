#!/usr/bin/env bash
# t1l.sh - deterministic actions for the t1l-bringup skill.
# Every subcommand prints JSON on stdout, diagnostics on stderr, and exits non-zero on failure.
# Usage: bash t1l.sh [--dry-run] <command> [args]    (run without arguments for help)
set -uo pipefail
VERSION=1.1.0

CONF_FILE=${CONF_FILE:-$HOME/.config/datax-industrial/t1l.env}
# shellcheck disable=SC1090
[ -f "$CONF_FILE" ] && . "$CONF_FILE"

# ---- Defaults (single source of truth). Override with `t1l.sh config KEY=VALUE`. ----
: "${CN0575_IP:=192.168.10.2}"  "${CN0575_HOST_IP:=192.168.10.1}" "${CN0575_IF:=t1l_cn0575}"
: "${PFWD_IP:=192.168.98.50}"   "${PFWD_HOST_IP:=192.168.98.1}"   "${PFWD_IF:=t1l_pfwd}"
: "${SPOE_IP=192.168.98.60}"    # empty = no board daisy-chained after the PFWD
: "${SWIOT_IP=192.168.97.40}"   # empty = no SWIOT1L
: "${SWIOT_HOST_IP:=192.168.97.1}" "${SWIOT_IF:=t1l_swiot}"
: "${PREFIX:=24}" "${PORT:=10000}" "${CN0575_USER:=analog}"
: "${REPO_URL:=https://github.com/analogdevicesinc/dataX-collaterals.git}"
: "${REPO_DIR:=$HOME/dataX-collaterals}"
: "${APP_SUBDIR:=applications/industrial-network}"   # the app inside the repo
APP_DIR=$REPO_DIR/$APP_SUBDIR
REMOTE_DIR=industrial-network                        # copy of RPI_CN0575 on the CN0575 node, under ~
: "${STATE_DIR:=$HOME/.local/state/setup-t1l}"
: "${T1L_PORTS:=}" "${T1L_USB:=}"   # optional: force interface classification (space-separated names)
CONF_KEYS="CN0575_IP CN0575_HOST_IP CN0575_IF PFWD_IP PFWD_HOST_IP PFWD_IF SPOE_IP SWIOT_IP SWIOT_HOST_IP SWIOT_IF PREFIX PORT CN0575_USER REPO_URL REPO_DIR APP_SUBDIR T1L_PORTS T1L_USB"

DRY_RUN=${DRY_RUN:-0}
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new)
REMOTE="$CN0575_USER@$CN0575_IP"

# ---- Helpers ----
log()  { echo "[t1l] $*" >&2; }
err()  { echo "[t1l] ERROR: $*" >&2; exit "${2:-1}"; }
js()   { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
jarr() { local out="" x; for x in "$@"; do out+="${out:+,}$(js "$x")"; done; printf '[%s]' "$out"; }
run()  { if [ "$DRY_RUN" = 1 ]; then echo "DRY: $*" >&2; else "$@"; fi; }
write_root() {  # write_root <file> <content> (append if $3 = -a)
  if [ "$DRY_RUN" = 1 ]; then echo "DRY: write ${3:-} $1" >&2; return 0; fi
  printf '%s\n' "$2" | sudo tee ${3:-} "$1" >/dev/null
}
net24() { echo "${1%.*}"; }   # x.y.z.w -> x.y.z (subnet check assumes /24)
has_if() { [ -e "/sys/class/net/$1" ]; }

mgmt_if() {
  local c=${SSH_CONNECTION:-}
  if [ -n "$c" ]; then ip route get "${c%% *}" 2>/dev/null | grep -o 'dev [^ ]*' | head -1 | cut -d' ' -f2
  else ip route show default 2>/dev/null | grep -o 'dev [^ ]*' | head -1 | cut -d' ' -f2; fi
}
guard() {
  local m; m=$(mgmt_if)
  if [ -n "$m" ] && [ "$1" = "$m" ]; then err "refusing to touch management interface $m" 3; fi
  return 0
}
netmgr() {
  local s
  for s in NetworkManager dhcpcd systemd-networkd; do
    systemctl is-active --quiet "$s" 2>/dev/null && { echo "$s"; return; }
  done
  echo none
}
read_temp() { printf 'READ_TEMP\n' | nc -w 2 "$CN0575_IP" "$PORT" 2>/dev/null | tr -d '\r\n'; }
last_backup() { cat "$STATE_DIR/last_backup" 2>/dev/null; }
clone_repo() {
  if [ ! -d "$REPO_DIR/.git" ]; then run git clone -q "$REPO_URL" "$REPO_DIR" || return 1
  else run git -C "$REPO_DIR" pull -q --ff-only || log "pull failed; using the local copy"; fi
}

# ---- Commands ----
cmd_defaults() {
  printf '{"version":%s,"prefix":%s,"port":%s,"cn0575":{"ip":%s,"host_ip":%s,"if":%s,"user":%s},' \
    "$(js $VERSION)" "$PREFIX" "$PORT" "$(js "$CN0575_IP")" "$(js "$CN0575_HOST_IP")" "$(js "$CN0575_IF")" "$(js "$CN0575_USER")"
  printf '"pfwd":{"ip":%s,"host_ip":%s,"if":%s},"spoe":{"ip":%s,"if":%s},' \
    "$(js "$PFWD_IP")" "$(js "$PFWD_HOST_IP")" "$(js "$PFWD_IF")" "$(js "$SPOE_IP")" "$(js "$PFWD_IF")"
  printf '"swiot":{"ip":%s,"host_ip":%s,"if":%s},"repo":%s,"app_dir":%s,"conf_file":%s}\n' \
    "$(js "$SWIOT_IP")" "$(js "$SWIOT_HOST_IP")" "$(js "$SWIOT_IF")" "$(js "$REPO_URL")" "$(js "$REPO_DIR/$APP_SUBDIR")" "$(js "$CONF_FILE")"
}

cmd_config() {  # config KEY=VALUE ...  (writes the override file; no root needed)
  [ $# -gt 0 ] || err "usage: config KEY=VALUE ..."
  local kv k v
  mkdir -p "$(dirname "$CONF_FILE")"; touch "$CONF_FILE"
  for kv in "$@"; do
    k=${kv%%=*}; v=${kv#*=}
    [[ " $CONF_KEYS " == *" $k "* ]] || err "unknown key $k (allowed: $CONF_KEYS)"
    [[ "$k" == *_IF ]] && ! [[ "$v" =~ ^[a-z0-9_-]{1,15}$ ]] && err "invalid interface name $v"
    sed -i "/^$k=/d" "$CONF_FILE"
    printf '%s=%q\n' "$k" "$v" >> "$CONF_FILE"
  done
  . "$CONF_FILE"; cmd_defaults
}

cmd_preflight() {
  local model is_pi sudo_st m overlap=() existing host
  model=$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)
  [[ "$model" == *"Raspberry Pi"* ]] && is_pi=true || is_pi=false
  sudo -n true 2>/dev/null && sudo_st=ok || sudo_st=needs_password
  m=$(mgmt_if)
  for host in "$CN0575_HOST_IP" "$PFWD_HOST_IP" "$SWIOT_HOST_IP"; do
    ip -4 -o addr show 2>/dev/null | awk '$2 !~ /^t1l_/ {print $4}' | cut -d/ -f1 \
      | grep -q "^$(net24 "$host")\." && overlap+=("$(net24 "$host").0/24")
  done
  existing=$(ls /sys/class/net 2>/dev/null | grep '^t1l_' | tr '\n' ' ')
  printf '{"model":%s,"is_pi":%s,"sudo":%s,"mgmt_if":%s,"network_manager":%s,"overlap":%s,"existing_t1l":%s,"boards_json":%s,"conf_file":%s}\n' \
    "$(js "$model")" "$is_pi" "$(js $sudo_st)" "$(js "$m")" "$(js "$(netmgr)")" "$(jarr "${overlap[@]}")" \
    "$(jarr $existing)" "$([ -f ~/.config/datax-industrial/boards.json ] && echo true || echo false)" \
    "$([ -f "$CONF_FILE" ] && echo true || echo false)"
}

cmd_discover() {
  local m out="" p n mac drv usb link addr cls
  m=$(mgmt_if)
  for p in /sys/class/net/*; do
    n=$(basename "$p"); [ "$n" = lo ] && continue
    mac=$(cat "$p/address" 2>/dev/null)
    drv=$(basename "$(readlink -f "$p/device/driver" 2>/dev/null)" 2>/dev/null); [ "$drv" = . ] && drv=""
    readlink -f "$p/device" 2>/dev/null | grep -q usb && usb=true || usb=false
    link=$(cat "$p/carrier" 2>/dev/null || echo 0)
    addr=$(ip -4 -o addr show dev "$n" 2>/dev/null | awk '{print $4}' | tr '\n' ' ')
    if   [ "$n" = "$m" ]; then cls=management
    elif [[ " $T1L_PORTS " == *" $n "* ]] || [[ "$drv" == adin* ]]; then cls=t1l_port
    elif [[ " $T1L_USB " == *" $n "* ]]; then cls=usb_adapter
    elif $usb && [[ "$drv" != smsc95xx && "$drv" != lan78xx ]]; then cls=usb_adapter
    else cls=other; fi
    out+="${out:+,}{\"name\":$(js "$n"),\"mac\":$(js "$mac"),\"driver\":$(js "$drv"),\"usb\":$usb,\"link\":$([ "$link" = 1 ] && echo true || echo false),\"ipv4\":$(jarr $addr),\"class\":$(js $cls)}"
  done
  printf '[%s]\n' "$out"
}

cmd_backup() {
  local b; b="$STATE_DIR/backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$b"
  ip -br addr > "$b/ip-addr.txt"; ip route > "$b/ip-route.txt"
  nmcli -t -f NAME,UUID,DEVICE,AUTOCONNECT,FILENAME con show > "$b/nm-connections.txt" 2>/dev/null || true
  cp /etc/dhcpcd.conf "$b/" 2>/dev/null || true
  cp -a /etc/systemd/network "$b/" 2>/dev/null || true
  echo "$b" > "$STATE_DIR/last_backup"
  printf '{"backup":%s}\n' "$(js "$b")"
}

cmd_probe() {  # probe <port> [port] -> which port carries CN0575 / PFWD
  [ $# -gt 0 ] || err "usage: probe <port> [port]"
  local p cn="" pf="" a1 a2
  for p in "$@"; do
    guard "$p"; has_if "$p" || err "no interface $p"
    run sudo ip link set "$p" up
    a1=0; a2=0
    run sudo ip addr add "$CN0575_HOST_IP/$PREFIX" dev "$p" 2>/dev/null && a1=1
    run sudo ip addr add "$PFWD_HOST_IP/$PREFIX" dev "$p" 2>/dev/null && a2=1
    if [ "$DRY_RUN" != 1 ]; then
      ping -c 2 -W 1 -I "$p" "$CN0575_IP" >/dev/null 2>&1 && cn=$p
      ping -c 2 -W 1 -I "$p" "$PFWD_IP"   >/dev/null 2>&1 && pf=$p
    fi
    [ $a1 = 1 ] && run sudo ip addr del "$CN0575_HOST_IP/$PREFIX" dev "$p"
    [ $a2 = 1 ] && run sudo ip addr del "$PFWD_HOST_IP/$PREFIX" dev "$p"
  done
  # Only one board found: the other goes on the remaining port (two ports given).
  if [ $# -eq 2 ]; then
    [ -n "$cn" ] && [ -z "$pf" ] && { [ "$cn" = "$1" ] && pf=$2 || pf=$1; }
    [ -n "$pf" ] && [ -z "$cn" ] && { [ "$pf" = "$1" ] && cn=$2 || cn=$1; }
  fi
  printf '{"cn0575":%s,"pfwd":%s}\n' "$(js "$cn")" "$(js "$pf")"
  [ -n "$cn$pf" ] || exit 4
}

cmd_rename() {  # rename <if> <newname>
  [ $# -eq 2 ] || err "usage: rename <if> <newname>"
  local i=$1 new=$2 mac f content
  [[ "$new" =~ ^[a-z0-9_-]{1,15}$ ]] || err "invalid name $new"
  has_if "$new" && i=$new
  has_if "$i" || err "no interface $1"
  guard "$i"
  mac=$(cat "/sys/class/net/$i/address")
  if [ "$i" != "$new" ]; then
    run sudo ip link set "$i" down && run sudo ip link set "$i" name "$new" && run sudo ip link set "$new" up \
      || err "rename $i -> $new failed"
  fi
  f=/etc/systemd/network/10-$new.link
  content=$(printf '[Match]\nMACAddress=%s\n[Link]\nName=%s' "$mac" "$new")
  [ "$(cat "$f" 2>/dev/null)" = "$content" ] || { run sudo mkdir -p /etc/systemd/network; write_root "$f" "$content"; }
  printf '{"from":%s,"to":%s,"mac":%s,"link_file":%s}\n' "$(js "$1")" "$(js "$new")" "$(js "$mac")" "$(js "$f")"
}

cmd_configure() {  # configure <if> <host-ip>
  [ $# -eq 2 ] || err "usage: configure <if> <host-ip>"
  local i=$1 hip=${2%/*} mgr b prof
  has_if "$i" || err "no interface $i"; guard "$i"
  mgr=$(netmgr); b=$(last_backup)
  case $mgr in
    NetworkManager)
      nmcli -t -f NAME,DEVICE,FILENAME con show 2>/dev/null | while IFS=: read -r name dev file; do
        [ "$dev" = "$i" ] && [ "$name" != "$i" ] || continue
        [ -n "$b" ] && [ -n "$file" ] && run sudo cp -a "$file" "$b/"
        run sudo nmcli con down "$name"; run sudo nmcli con modify "$name" connection.autoconnect no
      done
      if nmcli -t -f NAME con show 2>/dev/null | grep -qx "$i"; then
        prof=$(nmcli -g GENERAL.FILENAME con show "$i" 2>/dev/null)
        [ -n "$b" ] && [ -n "$prof" ] && run sudo cp -a "$prof" "$b/"
        run sudo nmcli con modify "$i" connection.interface-name "$i" ipv4.method manual \
          ipv4.addresses "$hip/$PREFIX" ipv4.never-default yes ipv6.method disabled connection.autoconnect yes
      else
        run sudo nmcli con add type ethernet ifname "$i" con-name "$i" ipv4.method manual \
          ipv4.addresses "$hip/$PREFIX" ipv4.never-default yes ipv6.method disabled connection.autoconnect yes
      fi
      run sudo nmcli con up "$i" >/dev/null ;;
    dhcpcd)
      grep -q "^interface $i\$" /etc/dhcpcd.conf 2>/dev/null \
        || write_root /etc/dhcpcd.conf "$(printf '\ninterface %s\nstatic ip_address=%s/%s\nnogateway' "$i" "$hip" "$PREFIX")" -a
      run sudo dhcpcd -n "$i" ;;
    systemd-networkd)
      write_root "/etc/systemd/network/10-$i.network" "$(printf '[Match]\nName=%s\n[Network]\nAddress=%s/%s' "$i" "$hip" "$PREFIX")"
      run sudo networkctl reload; run sudo networkctl reconfigure "$i" ;;
    *)
      log "no network manager active: address is set for this session only"
      run sudo ip link set "$i" up; run sudo ip addr replace "$hip/$PREFIX" dev "$i" ;;
  esac
  local ok=false; [ "$DRY_RUN" = 1 ] && ok=null
  sleep 1; ip -4 -o addr show dev "$i" 2>/dev/null | grep -q " $hip/" && ok=true
  printf '{"if":%s,"addr":%s,"manager":%s,"ok":%s}\n' "$(js "$i")" "$(js "$hip/$PREFIX")" "$(js "$mgr")" "$ok"
  [ "$ok" = false ] && exit 5; return 0
}

boards() {  # name|if|ip for the boards in the topology
  echo "CN0575|$CN0575_IF|$CN0575_IP"
  echo "APARD32690 #1|$PFWD_IF|$PFWD_IP"
  [ -n "$SPOE_IP" ]  && echo "APARD32690 #2|$PFWD_IF|$SPOE_IP"
  [ -n "$SWIOT_IP" ] && echo "SWIOT1L|$SWIOT_IF|$SWIOT_IP"
  return 0
}

cmd_reach() {
  local out="" fail=0 name i ip res rtt
  while IFS='|' read -r name i ip; do
    rtt=""
    if ! has_if "$i"; then res=no_interface
    elif r=$(ping -c 3 -W 1 -I "$i" "$ip" 2>/dev/null); then
      res=ok; rtt=$(echo "$r" | awk -F/ '/^rtt|^round-trip/ {print $5}')
    else res=unreachable; fi
    [ "$res" = ok ] || fail=1
    out+="${out:+,}{\"board\":$(js "$name"),\"if\":$(js "$i"),\"ip\":$(js "$ip"),\"result\":$(js $res),\"rtt_ms\":$(js "$rtt")}"
  done < <(boards)
  printf '[%s]\n' "$out"; exit $fail
}

cmd_deploy() {  # deploy the CN0575 server over SSH
  local e reply pid
  if ! e=$(ssh "${SSH_OPTS[@]}" "$REMOTE" true 2>&1); then
    case $e in
      *"Permission denied"*)                 printf '{"status":"auth_failed","target":%s}\n' "$(js "$REMOTE")"; exit 10 ;;
      *"IDENTIFICATION HAS CHANGED"*|*"Host key verification failed"*)
                                             printf '{"status":"host_key_changed","target":%s}\n' "$(js "$REMOTE")"; exit 11 ;;
      *)                                     log "$e"; printf '{"status":"unreachable","target":%s}\n' "$(js "$REMOTE")"; exit 13 ;;
    esac
  fi
  ssh "${SSH_OPTS[@]}" "$REMOTE" 'grep -H . /sys/bus/iio/devices/*/name 2>/dev/null' | grep -q adt75 \
    || log "adt75 not found: probable missing dtoverlay=rpi-cn0575; server falls back to hwmon/I2C"
  reply=$(read_temp)
  if [[ "$reply" == TEMP:* ]]; then printf '{"status":"reused","reply":%s}\n' "$(js "$reply")"; return 0; fi
  run ssh "${SSH_OPTS[@]}" "$REMOTE" 'pkill -f cn0575_state_machine.py; sleep 1' || true
  if [ "$DRY_RUN" != 1 ] && ssh "${SSH_OPTS[@]}" "$REMOTE" "ss -ltn | grep -q ':$PORT '"; then
    printf '{"status":"port_busy","port":%s}\n' "$PORT"; exit 12
  fi
  clone_repo || err "cannot clone $REPO_URL on the host" 14
  [ "$DRY_RUN" = 1 ] || [ -f "$APP_DIR/RPI_CN0575/cn0575_state_machine.py" ] || err "missing $APP_DIR/RPI_CN0575 (check APP_SUBDIR)" 14
  run ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p ~/$REMOTE_DIR"
  run scp -q -r "${SSH_OPTS[@]}" "$APP_DIR/RPI_CN0575" "$REMOTE:$REMOTE_DIR/"
  pid=$(run ssh "${SSH_OPTS[@]}" "$REMOTE" "cd ~/$REMOTE_DIR/RPI_CN0575 &&"'
    setsid nohup python3 cn0575_state_machine.py > ~/cn0575_server.log 2>&1 < /dev/null & echo $!')
  [ "$DRY_RUN" = 1 ] && { printf '{"status":"dry_run"}\n'; return 0; }
  sleep 3; reply=$(read_temp)
  if [[ "$reply" == TEMP:* ]]; then
    printf '{"status":"started","pid":%s,"reply":%s,"log":"~/cn0575_server.log"}\n' "$(js "$pid")" "$(js "$reply")"
  else
    ssh "${SSH_OPTS[@]}" "$REMOTE" 'tail -n 20 ~/cn0575_server.log' >&2 || true
    printf '{"status":"no_reply","pid":%s,"log":"~/cn0575_server.log"}\n' "$(js "$pid")"; exit 15
  fi
}

cmd_gui() {
  local py=python3 pid boards
  clone_repo || err "cannot clone $REPO_URL" 14
  if ! python3 -c 'import tkinter, matplotlib, PIL' 2>/dev/null; then
    if ! { run sudo apt-get update -qq && run sudo apt-get install -y -qq python3-tk python3-matplotlib python3-pil; }; then
      log "apt failed; using a venv"
      run python3 -m venv --system-site-packages ~/.venvs/datax \
        && run ~/.venvs/datax/bin/pip install -q -r "$APP_DIR/requirements.txt" && py=~/.venvs/datax/bin/python \
        || err "dependency install failed" 21
    fi
  fi
  [ -z "${DISPLAY:-}" ] && [ -e /tmp/.X11-unix/X0 ] && export DISPLAY=:0
  [ -z "${XAUTHORITY:-}" ] && [ -f ~/.Xauthority ] && export XAUTHORITY=~/.Xauthority
  if [ "$DRY_RUN" != 1 ] && ! "$py" -c 'import tkinter; tkinter.Tk().destroy()' 2>/dev/null; then
    printf '{"status":"no_display","display":%s}\n' "$(js "${DISPLAY:-}")"; exit 20
  fi
  boards="\"APARD32690 #1\": $(js "$PFWD_IP")"
  [ -n "$SPOE_IP" ]  && boards+=", \"APARD32690 #2\": $(js "$SPOE_IP")"
  [ -n "$SWIOT_IP" ] && boards+=", \"SWIOT1L\": $(js "$SWIOT_IP")"
  if [ "$DRY_RUN" = 1 ]; then echo "DRY: write ~/.config/datax-industrial/boards.json" >&2
  else
    mkdir -p ~/.config/datax-industrial
    printf '{"boards": {%s}, "cn0575": %s, "port": %s}\n' "$boards" "$(js "$CN0575_IP")" "$PORT" > ~/.config/datax-industrial/boards.json
  fi
  if pid=$(pgrep -f 'RPI_T1LPSE/datax-industrial.py' | head -1) && [ -n "$pid" ]; then
    printf '{"status":"already_running","pid":%s}\n' "$pid"; return 0
  fi
  [ "$DRY_RUN" = 1 ] && { echo "DRY: start GUI with $py" >&2; printf '{"status":"dry_run"}\n'; return 0; }
  [ "$DRY_RUN" = 1 ] || [ -f "$APP_DIR/RPI_T1LPSE/datax-industrial.py" ] || err "missing $APP_DIR/RPI_T1LPSE (check APP_SUBDIR)" 14
  cd "$APP_DIR" && setsid nohup "$py" RPI_T1LPSE/datax-industrial.py > ~/datax-industrial.log 2>&1 < /dev/null &
  pid=$!; sleep 5
  if kill -0 "$pid" 2>/dev/null; then
    printf '{"status":"started","pid":%s,"display":%s,"log":"~/datax-industrial.log"}\n' "$pid" "$(js "${DISPLAY:-}")"
  else
    tail -n 20 ~/datax-industrial.log >&2; printf '{"status":"exited","log":"~/datax-industrial.log"}\n'; exit 22
  fi
}

cmd_status() {  # read-only health check
  local reach reply gui
  reach=$(cmd_reach 2>/dev/null)
  reply=$(read_temp)
  gui=$(pgrep -f 'RPI_T1LPSE/datax-industrial.py' | head -1)
  printf '{"reach":%s,"cn0575_reply":%s,"gui_pid":%s,"last_backup":%s}\n' \
    "${reach:-[]}" "$(js "$reply")" "$(js "$gui")" "$(js "$(last_backup)")"
}

cmd_rollback() {  # rollback [backup-dir]  - the skill asks the user first
  local b=${1:-$(last_backup)} i mgr
  [ -d "$b" ] || err "no backup directory: $b"
  mgr=$(netmgr)
  for i in "$CN0575_IF" "$PFWD_IF" "$SWIOT_IF"; do
    run sudo rm -f "/etc/systemd/network/10-$i.link" "/etc/systemd/network/10-$i.network"
    [ -f "$b/network/10-$i.link" ] && run sudo cp -a "$b/network/10-$i.link" /etc/systemd/network/
    [ "$mgr" = NetworkManager ] && nmcli -t -f NAME con show | grep -qx "$i" && run sudo nmcli con delete "$i"
  done
  if [ "$mgr" = NetworkManager ] && [ -f "$b/nm-connections.txt" ]; then
    while IFS=: read -r name uuid dev auto file; do
      [ "$auto" = yes ] && run sudo nmcli con modify "$uuid" connection.autoconnect yes
    done < "$b/nm-connections.txt"
  fi
  if [ "$mgr" = dhcpcd ] && [ -f "$b/dhcpcd.conf" ]; then
    run sudo cp "$b/dhcpcd.conf" /etc/dhcpcd.conf
    for i in "$CN0575_IF" "$PFWD_IF" "$SWIOT_IF"; do has_if "$i" && run sudo dhcpcd -n "$i"; done
  fi
  [ "$mgr" = systemd-networkd ] && run sudo networkctl reload
  printf '{"status":"rolled_back","backup":%s,"note":"original interface names return after a reboot"}\n' "$(js "$b")"
}

usage() {
  cat >&2 <<EOF
t1l.sh $VERSION - deterministic actions for the t1l-bringup skill
Usage: bash t1l.sh [--dry-run] <command> [args]
  defaults                     print the active defaults
  config KEY=VALUE ...         save overrides to $CONF_FILE
  preflight                    host checks (read-only)
  discover                     classify interfaces (read-only)
  backup                       save the current network state
  probe <port> [port]          find which T1L port carries CN0575 / PFWD
  rename <if> <newname>        rename now and persistently (.link file)
  configure <if> <host-ip>     set the static host address persistently
  reach                        ping all boards
  deploy                       copy and start the CN0575 server over SSH
  gui                          install deps, write boards.json, start the GUI
  status                       read-only health check
  rollback [backup-dir]        undo the network changes
EOF
  exit 2
}

[ "${1:-}" = --dry-run ] && { DRY_RUN=1; shift; }
c=${1:-}; shift 2>/dev/null || true
case $c in
  defaults|config|preflight|discover|backup|probe|rename|configure|reach|deploy|gui|status|rollback) "cmd_$c" "$@" ;;
  *) usage ;;
esac
