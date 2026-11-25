# T1L industrial agent

A [Claude Code](https://docs.claude.com/en/docs/claude-code) skill that brings up the ADI
10BASE-T1L industrial reference design from the host Raspberry Pi. In one guided run it:
1. confirms the board topology with you;
2. finds, renames and addresses the T1L interfaces;
3. pings every board;
4. starts the CN0575 temperature server on the sensor node over SSH;
5. starts the DataX Industrial GUI from
   [dataX-collaterals](https://github.com/analogdevicesinc/dataX-collaterals/tree/main/applications/industrial-network).

Version 1.1.0

---

## 1. Hardware
```
                 ┌──────────────────────────────┐
                 │ HOST: RPi + AD-RPI-T1L-PSE   │  <- the agent runs here
                 └──────┬──────────────┬────┬───┘
                 T1L #1 │       T1L #2 │    │ USB
        ┌───────────────┴──┐           │  ┌─┴────────────────────┐
        │ RPi + EVAL-CN0575│           │  │ T1L-to-USB adapter   │
        └──────────────────┘           │  └─┬────────────────────┘
                                       │    │ T1L
                                       │  ┌─┴────────────────────┐
                                       │  │ AD-SWIOT1L-SL        │
                                       │  └──────────────────────┘
                          ┌────────────┴───────────────┐
                          │ APARD32690 #1 + APARD-PFWD │
                          └────────────┬───────────────┘
                                       │ daisy chain (optional)
                          ┌────────────┴───────────────┐
                          │ APARD32690 #2 + APARD-SPOE │
                          └────────────────────────────┘
```
Boards can be replaced or left out. The agent asks about this at the start.

## 2. Prerequisites
On the **host RPi** (ADI Kuiper Linux):

| Requirement | Check | Fix |
|---|---|---|
| Claude Code installed and logged in | `claude --version` | see the Claude Code docs |
| T1L-PSE overlay enabled | `ls /sys/class/net` shows 2 T1L ports | add the overlay to `/boot/firmware/config.txt`, reboot |
| Passwordless sudo | `sudo -n true` prints nothing | `sudo visudo` or a file in `/etc/sudoers.d/` |
| Internet access | `ping -c1 github.com` | needed for `git clone` and `apt` |
| SSH key on the CN0575 node | `ssh analog@192.168.10.2 true` asks no password | `ssh-copy-id analog@192.168.10.2` (after the T1L link is up) |

On the **CN0575 node**: `dtoverlay=rpi-cn0575` in its `config.txt`.

You can't copy the SSH key until the T1L link has an address. You can also do it when the agent
asks for it in step S5.

## 3. Install
Copy the `skills/t1l-bringup` folder into `~/.claude/skills/` on the host RPi.
In the commands below, replace:
- `<user>`: the RPi login (`analog` on Kuiper);
- `<host-rpi-ip>`: the host RPi's management IP;
- `<path-to-this-folder>`: where you downloaded or cloned this package.

**Option A: on the RPi itself** (run inside this folder):
```bash
mkdir -p ~/.claude/skills
cp -r skills/t1l-bringup ~/.claude/skills/
```

**Option B: from another PC** (Linux, macOS, WSL, or Windows PowerShell with OpenSSH):
```bash
ssh <user>@<host-rpi-ip> 'mkdir -p ~/.claude/skills'
scp -r <path-to-this-folder>/skills/t1l-bringup <user>@<host-rpi-ip>:~/.claude/skills/
```
Create the folder first. If `~/.claude/skills` does not exist, `scp -r` copies the files into a folder named `skills` instead of `skills/t1l-bringup`.

**Line endings:** if you copied the files through Windows, make sure `t1l.sh` still has LF line endings: `file ~/.claude/skills/t1l-bringup/t1l.sh` must not say `CRLF`. If it does, fix it with `sed -i 's/\r$//' ~/.claude/skills/t1l-bringup/t1l.sh`.

**Check:**
```bash
ls ~/.claude/skills/t1l-bringup          # SKILL.md  reference.md  t1l.sh
```

## 4. Start
```bash
claude
```
Then type at the Claude prompt:

| Command | What it does |
|---|---|
| `/t1l-bringup` | the real setup |
| `/t1l-bringup status` | read-only health check: pings, CN0575 reply, GUI process |

You can also ask in plain words, such as "bring up the T1L demo".
If `/t1l-bringup` is unknown, exit (`/exit`) and start `claude` again.

## 5. What happens during a run
The agent asks **4 questions**, one at a time. Everything else runs on its own.

| Stage | What the agent does | You |
|---|---|---|
| S0 Topology | Checks the host, shows the diagram | **C1** "Is this your configuration?" <br> **C2** "Is a board daisy-chained after the APARD-PFWD?" |
| S1 Discovery | Lists the interfaces: management, T1L ports, USB adapter | — |
| S2 Plan | Shows the IP and name table, then the change plan | **C3** "Use the standard IPs and interface names?" <br> **C4** "Apply this plan?" |
| S3 Interfaces | Backs up, probes which port is which, renames, sets static IPs | — |
| S4 Reachability | Pings every board, retries up to 2 times | — |
| S5 CN0575 server | Copies and starts the server over SSH, checks `READ_TEMP` | — |
| S6 Application | Installs the dependencies, writes `boards.json`, starts the GUI | — |
| Final report | Interfaces, pings, PIDs, logs, backup path | optional: autostart unit |

The agent asks extra questions only when it is blocked: a missing SSH key, sudo, no display, a cable or power.
An unreachable board doesn't stop the run. The GUI shows it as offline.

### Standard values
| Board | Board IP | Host interface | Host IP |
|---|---|---|---|
| RPi + EVAL-CN0575 | `192.168.10.2/24` | `t1l_cn0575` | `192.168.10.1/24` |
| APARD32690 #1 + APARD-PFWD | `192.168.98.50/24` | `t1l_pfwd` | `192.168.98.1/24` |
| APARD32690 #2 + APARD-SPOE | `192.168.98.60/24` | `t1l_pfwd` (same) | — |
| AD-SWIOT1L-SL | `192.168.97.40/24` | `t1l_swiot` (USB) | `192.168.97.1/24` |

TCP port `10000`. If you answer "no" at C3, the agent asks for each value that differs.

## 6. Results and files
| What | Where |
|---|---|
| App source | `~/dataX-collaterals/applications/industrial-network` |
| GUI log | `~/datax-industrial.log` |
| CN0575 server log (on the node) | `~/cn0575_server.log` |
| Board list for the GUI | `~/.config/datax-industrial/boards.json` |
| Your overrides | `~/.config/datax-industrial/t1l.env` |
| Network backups | `~/.local/state/setup-t1l/backup-*` |
| Persistent renames | `/etc/systemd/network/10-t1l_*.link` |

## 7. Run it again
- **Rerun:** type `/t1l-bringup` again. The agent detects the existing `t1l_*` interfaces and asks only C1. It skips the steps that are already done, and it reuses a running server and GUI.
- **Status:** `/t1l-bringup status`.

## 9. Troubleshooting
| Symptom | Most probable cause | Check |
|---|---|---|
| No T1L ports found | overlay missing or misspelled | `ls /boot/overlays \| grep -i pse`, then `config.txt` |
| No USB adapter found | adapter not enumerated | `lsusb`, `dmesg \| tail` |
| Board unreachable | no link or PoDL power, board still booting, wrong IP | `ethtool <if>`, `ip neigh show dev <if>` |
| SPOE unreachable, PFWD ok | PFWD forwarding or the second link | the PFWD firmware and cable |
| SSH asks for a password | key not installed | `ssh-copy-id analog@192.168.10.2` |
| No `TEMP:` reply | missing `smbus2` or overlay on the node | `ssh analog@192.168.10.2 tail ~/cn0575_server.log` |
| GUI has no display | run from SSH without X | run from the desktop terminal, or set `DISPLAY=:0` |

More detail: `skills/t1l-bringup/reference.md`.

## 10. Safety and security
- The agent never touches the interface that carries your SSH session or default route.
- It never reboots, edits `/boot/*config.txt` or flashes firmware without asking.
- It never types or stores passwords.
- The CN0575 server listens on TCP `10000` with no authentication, and SSH trusts the node's key on first connection (`accept-new`). **Use it only on an isolated lab network.**

## Layout
```
README.md
skills/t1l-bringup/
├── SKILL.md        # workflow and rules (loaded when the skill runs)
├── reference.md    # topology, defaults, troubleshooting, exit codes
└── t1l.sh          # all actions: JSON output, --dry-run, exit codes
```
