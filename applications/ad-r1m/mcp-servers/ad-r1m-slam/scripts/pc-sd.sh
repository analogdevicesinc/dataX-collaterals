#!/usr/bin/env bash
# kuiper_sd_card, on this PC (not the robot). Needs passwordless sudo for dd and mount.
#   flash <zip> <image entry> <nested 0|1> <jobs dir> <device> [<wifi profile> <profile name>]
#   wifi <device> <wifi profile> <profile name>
# The Wi-Fi profile is a 0600 NetworkManager keyfile written by the server; it is installed onto
# the card's rootfs and deleted, so the password never appears on a command line or in a log.
set -o pipefail

add_wifi() {
  local dev=$1 prof=$2 name=$3 rootfs mnt rc
  rootfs=$(lsblk -ln -o PATH,LABEL "$dev" | awk '$2=="rootfs"{print $1}' | head -1)
  [ -n "$rootfs" ] || { echo "no rootfs partition on $dev - is it a flashed Kuiper card?"; rm -f "$prof"; return 7; }
  mnt=$(mktemp -d)
  # The desktop may have auto-mounted it; a second mount of the same ext4 is fine read-write.
  sudo -n mount "$rootfs" "$mnt" || { rm -f "$prof"; rmdir "$mnt"; return 7; }
  if [ ! -d "$mnt/etc/NetworkManager/system-connections" ]; then
    echo "no NetworkManager on this card"; sudo -n umount "$mnt"; rmdir "$mnt"; rm -f "$prof"; return 7
  fi
  sudo -n install -m 600 -o root -g root "$prof" "$mnt/etc/NetworkManager/system-connections/$name"
  rc=$?
  rm -f "$prof"
  echo "Card hostname: $(cat "$mnt/etc/hostname" 2>/dev/null)"
  sudo -n ls "$mnt/etc/NetworkManager/system-connections/"
  sync; sudo -n umount "$mnt"; rmdir "$mnt"
  [ $rc -eq 0 ] && echo "Wi-Fi profile $name added"
}

case $1 in
  wifi) add_wifi "$2" "$3" "$4" || exit 7 ;;
  flash)
    ZIP=$2 ENTRY=$3 NESTED=$4 JOBS=$5 DEV=$6
    if [ "$NESTED" = 1 ]; then
      unzip -o -q "$ZIP" "$ENTRY" -d "$JOBS" || exit 3
      IMG_ZIP=$JOBS/$ENTRY
      IMG=$(unzip -Z1 "$IMG_ZIP" | grep -i '\.img$' | head -1)
    else
      IMG_ZIP=$ZIP IMG=$ENTRY
    fi
    [ -n "$IMG" ] || exit 3
    for p in $(lsblk -ln -o PATH,MOUNTPOINT "$DEV" | awk '$2!=""{print $1}'); do sudo -n umount "$p" || exit 4; done
    echo "Writing $IMG to $DEV"
    unzip -p "$IMG_ZIP" "$IMG" | sudo -n dd of="$DEV" bs=4M conv=fsync status=progress || exit 5
    sync
    A=$(unzip -p "$IMG_ZIP" "$IMG" | head -c 67108864 | sha256sum | cut -d' ' -f1)
    B=$(sudo -n head -c 67108864 "$DEV" | sha256sum | cut -d' ' -f1)
    if [ "$A" = "$B" ]; then echo "VERIFY OK (first 64 MiB match)"; else echo "VERIFY FAILED $A != $B"; exit 6; fi
    sudo -n partprobe "$DEV" 2>/dev/null
    sleep 2
    if [ -n "$7" ]; then add_wifi "$DEV" "$7" "$8" || exit 7; fi
    echo "Done - remove the card and boot the robot from it"
    ;;
  *) echo "usage: pc-sd.sh flash|wifi ..."; exit 2 ;;
esac
