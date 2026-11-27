# t1l-bringup reference

Open the section you need. You don't need to read the whole file.

## Topology
```
                         ┌───────────────────────────────┐
                         │ HOST: RPi + AD-RPI-T1L-PSE    │
                         │  (runs datax-industrial.py)   │
                         └───────┬───────────────┬───┬───┘
                          T1L #1 │        T1L #2 │   │ USB
                                 │               │   │
             ┌───────────────────┴──┐            │ ┌─┴──────────────────┐
             │ RPi + EVAL-CN0575    │            │ │ T1L-to-USB adapter │
             │ (temp server :10000) │            │ └─┬──────────────────┘
             └──────────────────────┘            │   │ T1L
                                                 │ ┌─┴──────────────────┐
                                                 │ │ AD-SWIOT1L-SL      │
                                                 │ └────────────────────┘
                                        ┌────────┴─────────────────────┐
                                        │ APARD32690 #1 + APARD-PFWD   │
                                        │ (2x T1L, forwarding)         │
                                        └────────┬─────────────────────┘
                                                 │ PFWD T1L #2 (daisy chain)
                                        ┌────────┴─────────────────────┐
                                        │ APARD32690 #2 + APARD-SPOE   │
                                        └──────────────────────────────┘
  Subnet A: host T1L port <-> CN0575
  Subnet B: host T1L port <-> PFWD <-> SPOE   (same subnet, same host interface)
  Subnet C: host USB T1L adapter <-> SWIOT1L
```
- A board daisy-chained after the PFWD is always in the PFWD subnet and uses the PFWD's host interface.
- A replaced board takes the default IP of the position it fills.

## Defaults
The values live in `t1l.sh` (`t1l.sh defaults`). User overrides go to `~/.config/datax-industrial/t1l.env` (`t1l.sh config KEY=VALUE`).

| Board | Board IP | Subnet | Host interface | Name (`*_IF`) | Host IP |
|---|---|---|---|---|---|
| RPi + EVAL-CN0575 | `192.168.10.2/24` | A | T1L port (probed) | `t1l_cn0575` | `192.168.10.1/24` |
| APARD32690 #1 + APARD-PFWD | `192.168.98.50/24` | B | T1L port (probed) | `t1l_pfwd` | `192.168.98.1/24` |
| APARD32690 #2 + APARD-SPOE | `192.168.98.60/24` | B | same as PFWD | — | — |
| AD-SWIOT1L-SL | `192.168.97.40/24` | C | USB adapter | `t1l_swiot` | `192.168.97.1/24` |

- The CN0575 server uses TCP port `10000`, and the SSH user is `analog`.
- App source: `https://github.com/analogdevicesinc/dataX-collaterals`, cloned to `~/dataX-collaterals`. The app is in `applications/industrial-network` (`APP_SUBDIR`), with `RPI_T1LPSE/` (GUI) and `RPI_CN0575/` (server). On the CN0575 node, the server is copied to `~/industrial-network/RPI_CN0575`.
- These values match the DataX app's built-in defaults.
- An empty `SPOE_IP` or `SWIOT_IP` means that board is not in the topology.

## Interface classes
How `discover` classifies interfaces:
- **management**: carries the SSH session, or the default route without SSH. It is never touched.
- **t1l_port**: driver `adin*` (ADIN1110/ADIN2111), or listed in `T1L_PORTS`.
- **usb_adapter**: on USB, or listed in `T1L_USB`. The onboard Ethernet of older Pis is also on USB (`smsc95xx`, `lan78xx`); it is excluded and classed as `other`.

## Overlays
The host needs the T1L-PSE overlay in `/boot/firmware/config.txt` (`/boot/config.txt` on older images). The CN0575 node needs `dtoverlay=rpi-cn0575`.
- **Host overlay name:**
  - The file shipped with the demo is `rpi-t1lpse-class12.dtbo`, so the line is `dtoverlay=rpi-t1lpse-class12`.
  - The repo README spells it `rpi-tl1pse-class12`.
  - Check with `ls /boot/overlays | grep -i pse` and use the name that exists.
- **Changes need approval:** editing `config.txt` and rebooting both need the user's approval.

## Network managers
How `configure` applies addresses, by network manager:
- **NetworkManager**:
  - It disables (does not delete) other profiles active on the interface, so the change can be undone.
  - It creates or updates a profile named after the interface, with `ipv4.never-default yes`.
  - It copies each profile file to the backup before changing it.
- **dhcpcd**: it appends `interface` / `static ip_address` / `nogateway` to `/etc/dhcpcd.conf`, then runs `dhcpcd -n <if>`. It never restarts dhcpcd, because that would also bounce the management link.
- **systemd-networkd**: it writes `/etc/systemd/network/10-<if>.network`, then reloads and reconfigures that interface.
- **none**: the address is set for this session only. Report that it is not persistent.

If `configure` exits 5, run `ip -br addr`.
- If a DHCP address appeared, disable the profile that holds it and run `configure` again.

**Renames** are matched by MAC address in `/etc/systemd/network/10-<name>.link`.
- Hypothesis to check after the next reboot: some ADIN setups and some USB adapters use a random MAC. If the MAC changed, the `.link` file no longer matches.
- In that case, match on `Path=` instead; get it with `udevadm info /sys/class/net/<if> | grep ID_PATH=`.

## Troubleshooting
Most probable cause first.

**Board unreachable (`reach`)**
1. **No link** (`"link":false` in `discover`, or `ethtool <if>`): cable or PoDL power. For the CN0575, check the PSE class of the overlay.
2. **Board still booting**: wait 10 s and retry.
3. **Wrong IP on the board**: run `ip neigh show dev <if>` and `sudo arping -c 3 -I <if> <ip>`. A reply from a different MAC or IP is a fact; report it.
4. **SPOE only** (the PFWD answers): PFWD forwarding, the second T1L link, or the SPOE firmware.
5. **SWIOT1L only**:
   - the adapter dropped off USB (`lsusb`, `dmesg`);
   - hypothesis: the board has no power, because the adapter may not supply it; ask the user;
   - the firmware uses another IP.

**CN0575 server**
- **No `adt75`** in the deploy log: probably `dtoverlay=rpi-cn0575` is missing. The server falls back to hwmon, then to I²C at `0x48`, which needs `smbus2`.
- **`no_reply`**: read `~/cn0575_server.log` on the node: `ssh analog@<ip> tail -n 50 ~/cn0575_server.log`.

**GUI**
- **`no_display`**: the desktop session may belong to another user, or need its `XAUTHORITY`. Ask which session to use.
- **`exited`**: read `~/datax-industrial.log`. A missing module means the install failed; run `gui` again.

## Offline Python packages
The CN0575 node has no internet on the T1L subnet. To install a missing package such as `smbus2`:
```bash
pip3 download smbus2 -d /tmp/whl
scp -o BatchMode=yes /tmp/whl/*.whl analog@<cn0575-ip>:/tmp/
ssh analog@<cn0575-ip> 'pip3 install --user --no-index /tmp/smbus2-*.whl'
```
If pip reports `externally-managed-environment`, add `--break-system-packages`. Then run `t1l.sh deploy` again.

## Exit codes
| Code | Command | Meaning |
|---|---|---|
| 0 | all | success |
| 1 | all | generic error (see stderr) |
| 2 | all | usage error |
| 3 | probe/rename/configure | refused: management interface |
| 4 | probe | no board answered on any port |
| 5 | configure | address not present after applying |
| 1 | reach | at least one board is not `ok` (JSON is still printed) |
| 10 | deploy | SSH authentication failed |
| 11 | deploy | SSH host key changed |
| 12 | deploy | port 10000 held by another process |
| 13 | deploy | SSH unreachable |
| 14 | deploy/gui | repo clone failed, or app files missing under `APP_SUBDIR` |
| 15 | deploy | server started but no `TEMP:` reply |
| 20 | gui | no usable display |
| 21 | gui | dependency install failed |
| 22 | gui | GUI exited at startup |
