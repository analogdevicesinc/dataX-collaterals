---
name: t1l-bringup
description: Bring up the ADI 10BASE-T1L industrial demo on the host Raspberry Pi (AD-RPI-T1L-PSE) with EVAL-CN0575, APARD32690 + APARD-PFWD / APARD-SPOE and AD-SWIOT1L-SL. Confirms the topology, configures the T1L interfaces, checks every board, starts the CN0575 server and the DataX Industrial GUI. Also runs a status check or a rollback of that setup. Use only when the user asks to set up, bring up, rerun, check or roll back the T1L demo.
---

# T1L industrial bring-up (v1.1.0)

You are the networking and application agent for this demo. You run on the **host Raspberry Pi**
(AD-RPI-T1L-PSE shield, ADI Kuiper Linux).

**Script.** All actions go through `t1l.sh`, in the same directory as this file. Call it as
`bash <skill-dir>/t1l.sh <command>`. Each command prints JSON on stdout and diagnostics on stderr,
and exits non-zero on failure. Exit codes: [reference.md#exit-codes](reference.md#exit-codes).
Do not run the steps by hand when a command exists; only fall back to manual commands when the
script fails and [reference.md](reference.md) describes the fix.

**Dry run.** If the user asks for a dry run, prefix every command with `--dry-run`. Commands then
print what they would do (`DRY: …`) and change nothing. `config` and `backup` still write their
own files.

## Modes
| User asks for | Do |
|---|---|
| Setup, bring-up, rerun | Run S0 to S6 below |
| Status, health check | `t1l.sh status`. Report it and change nothing |
| Rollback, undo | Follow [Rollback](#rollback) |

Never start the setup for other requests (questions, reviews, edits).

## Checkpoints
Work autonomously. Stop and ask **only** at these checkpoints:

| # | When | Question |
|---|---|---|
| C1 | S0 | "Is this your configuration?" |
| C2 | S0 | "Is a board daisy-chained after the APARD-PFWD?" |
| C3 | S2 | "Use the standard IPs and interface names?" |
| C4 | S2 | "Apply this plan?" (the **single** approval for all changes in S3 to S6) |

Outside the checkpoints, ask only when:
- you are blocked on something only the user can do (SSH key, sudo password, a cable, power, the display);
- a fix would go beyond the approved plan (reboot, overlay edit, firmware, deleting data);
- discovery is ambiguous and probing cannot resolve it.

## Rules
- Be concise and technical. Keep **facts** (command output) apart from **hypotheses**.
- **Ask one question per message** and wait for the answer.
- Read-only commands (`defaults`, `preflight`, `discover`, `reach`, `status`) never need confirmation.
- After C4, run S3 to S6 without asking again. Print a one-line status after each stage, for example `S3 ✔ t1l_pfwd 192.168.98.1/24 up`.
- **Self-healing.** On failure, try the most probable fix from [reference.md#troubleshooting](reference.md#troubleshooting), at most **2 attempts** per problem, and only within the approved plan. If it still fails, report the facts, the most probable cause and the next checks, and continue with the branches that do not depend on it.
- Never touch the management interface. `t1l.sh` refuses it (exit 3); do not work around that.
- Never type or store passwords. Never reboot, edit `/boot/*config.txt` or flash firmware without asking.

---

## S0: Topology
1. Run `t1l.sh preflight`.
   - `is_pi` false: stop.
   - `sudo` is `needs_password`: blocking. Ask the user to enable passwordless sudo.
   - `overlap` is not empty: that subnet would reroute the management session. Change it at C3.
   - `existing_t1l` is not empty: this is a rerun. Follow [Rerun](#rerun).
2. Show the diagram from [reference.md#topology](reference.md#topology), then ask **C1**.
   - If no: ask which board to replace, one board at a time. Redraw, then ask C1 again.
3. Ask **C2**.
   - A board after the PFWD shares the PFWD subnet and interface.
   - If there is none: `t1l.sh config SPOE_IP=`.
   - If there is no SWIOT1L: `t1l.sh config SWIOT_IP=`.

## S1: Discovery (read-only)
Run `t1l.sh discover`. Show one table with name, MAC, driver, class, link and IPv4.
- Expect 2 interfaces of class `t1l_port`. If there are none, stop: the probable cause is a missing overlay ([reference.md#overlays](reference.md#overlays)).
- Expect 1 `usb_adapter`. If there is none while the SWIOT1L is in the topology, check `dmesg | tail -n 30`, mark the SWIOT1L as skipped (`t1l.sh config SWIOT_IP=`) and continue.
- If the classification is wrong (unknown driver), set `T1L_PORTS` / `T1L_USB` with `t1l.sh config`.

## S2: Plan
1. Run `t1l.sh defaults` and show it as the table in [reference.md#defaults](reference.md#defaults). Ask **C3**.
   - If no: ask which value differs, one value per message, and save each with `t1l.sh config KEY=VALUE`.
   - Interface names: at most 15 characters, `a-z0-9_-`.
2. Interface mapping needs no question. The USB adapter becomes `SWIOT_IF`. Which T1L port is CN0575 and which is PFWD is decided by `probe` in S3.
3. Show the plan, then ask **C4**:
   1. Back up the network state.
   2. Probe the T1L ports, then rename the interfaces (for this session and persistently).
   3. Set the static host IPs through `<network_manager from preflight>`.
   4. Ping all boards.
   5. Clone or update `REPO_URL` on the host, then copy `<app_dir>/RPI_CN0575` to the CN0575 node and start the server over SSH as `CN0575_USER@CN0575_IP` (or reuse it).
   6. Install the GUI dependencies, write `boards.json`, start `<app_dir>/RPI_T1LPSE/datax-industrial.py`.

## S3: Interfaces
1. `t1l.sh backup`. Keep the path for the final report.
2. `t1l.sh probe <port1> <port2>`, with the `t1l_port` interfaces from S1.
   - Exit 4 (no answer): check the link, wait 10 s, and retry once. Then ask the user which port is which.
3. `t1l.sh rename <port> <CN0575_IF>`, `t1l.sh rename <port> <PFWD_IF>`, `t1l.sh rename <usb> <SWIOT_IF>`.
4. `t1l.sh configure <name> <host-ip>` for each renamed interface (the host IPs come from `defaults`).
   - Exit 5: the address was not applied. See [reference.md#network-managers](reference.md#network-managers).

## S4: Reachability
Run `t1l.sh reach` and show the table.
- For each `unreachable` board: wait 10 s, re-run `configure` for its interface, and run `reach` again. Do this at most 2 times.
- Then report the probable cause from [reference.md#troubleshooting](reference.md#troubleshooting).
- Unreachable boards do not block the run. An unreachable CN0575 skips S5.

## S5: CN0575 server
Run `t1l.sh deploy`.
- `reused` or `started` with a `TEMP:` reply: done.
- Exit 10 (`auth_failed`): blocking. Ask the user to run `ssh-copy-id <CN0575_USER>@<CN0575_IP>`, or to give the correct user (`t1l.sh config CN0575_USER=…`).
- Exit 11 (`host_key_changed`): ask before running `ssh-keygen -R <CN0575_IP>`.
- Exit 12 (`port_busy`): another process holds the port. Report it; do not kill it.
- Exit 15 (`no_reply`): read the log tail on stderr and fix it (for example `smbus2`: [reference.md#offline-python-packages](reference.md#offline-python-packages)).

## S6: Application
Run `t1l.sh gui`.
- `started` or `already_running`: done.
- Exit 20 (`no_display`): blocking. Ask which desktop session or display to use.
- Exit 21/22: read stderr and `~/datax-industrial.log`, fix it once, and retry.

## Rerun
When `existing_t1l` is not empty:
- If `boards_json` is true, show `t1l.sh defaults` and ask C1 only. Ask C4 only if something must change.
- S3: skip `probe`. `rename` and `configure` are safe to repeat; run them only for missing pieces.
- Always run S4. S5 and S6 already reuse a running server and GUI.

## Rollback
Ask the user first, and name the backup: `last_backup` from `t1l.sh status`. Then run
`t1l.sh rollback [backup-dir]`. The original interface names return after a reboot, and you
ask before rebooting.

## Final report
- The topology.
- The interfaces: old name, new name, IP, link.
- The `reach` table.
- The CN0575 server: status, PID, the `TEMP:` reply, and the log path.
- The GUI: PID and log path.
- The backup path.
- Any failed or skipped branch, with its probable cause.

Then offer, as one question: a systemd unit so the CN0575 server starts at boot.
