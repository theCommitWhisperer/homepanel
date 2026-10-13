# PC agent (temperatures, drives, PC buttons)

The HomePanel agent is a small background program for each PC you want on a screen (e.g. the gaming PC). It reads
temperatures from **LibreHardwareMonitor**, drive space, and offers allowlisted actions (open a folder, launch Steam,
sleep…). It only connects *out* to the MQTT broker, so it opens no ports.

It is part of `HomePanel.exe` — there is nothing separate to download.

## Set it up (Windows)

1. Download **`HomePanel-Setup.exe`** from <https://github.com/theCommitWhisperer/homepanel/releases>
   (or, if a HomePanel server already runs on your network, from `http://<server-ip>:8080/download/HomePanel.exe`).
2. Double-click it. SmartScreen: **More info → Run anyway** (the file isn't code-signed). Allow administrator rights.
3. Choose:
   - **1. Host HomePanel on this PC** if this PC is also the server (tonight's gaming-PC setup), or
   - **2. Join this PC to my HomePanel** if the server runs elsewhere. It finds the server (or asks for its address)
     and asks for the admin password and the MQTT password (both shown at the end of the server's setup).
4. Setup then does, showing each action first:
   - installs **LibreHardwareMonitor** and the **PawnIO** driver with winget,
   - writes LibreHardwareMonitor's settings file (web server on port 8085, start minimized to the tray) — no menus to click,
   - registers the **HomePanel Sensors** task (starts LHM elevated at logon) and checks `http://localhost:8085/data.json`,
   - registers the PC with the server (`POST /api/admin/agents`, with the MAC address for Wake-on-LAN) and writes
     `C:\ProgramData\HomePanel\agent.yaml` with the suggested buttons (readable only by you, SYSTEM and Administrators),
   - registers the **HomePanel Agent** task (at your logon, in your session, highest privileges, restarted if it stops)
     and waits until the PC shows **online**.

Run setup again any time: finished steps are detected and skipped, and an existing `agent.yaml` keeps your buttons
(only the connection lines are updated).

Then add `pc-temps`, `pc-drives` and `buttons` widgets with `pc: gaming-pc` (see [widgets.md](widgets.md)) — the
`desk-monitor` example profile already has them.

## Buttons and day-to-day

- Edit buttons: `notepad C:\ProgramData\HomePanel\agent.yaml` (as administrator), then restart the agent
  (Task Scheduler → *HomePanel Agent* → End, Run). Action types and examples: [apps/agent/README.md](../apps/agent/README.md#adding-actions).
- Your sensors: `"C:\Program Files\HomePanel\HomePanel.exe" agent list-sensors`
- Try a button: `"C:\Program Files\HomePanel\HomePanel.exe" agent test-action open-drive-c --really`
- Log: `C:\ProgramData\HomePanel\logs\agent.log`

Commands from HomePanel are HMAC-signed with the PC's key, and the PC only runs actions listed in its own `agent.yaml`.

## Troubleshooting

- **No temperatures, only CPU load / memory.** Open <http://localhost:8085>. Nothing? Look for the LibreHardwareMonitor
  tray icon; if a "PawnIO is not installed" box is waiting, click OK. Check *Options → Remote Web Server → Run*.
- **The PC never shows online.** Read `agent.log`. "Not authorized" = wrong MQTT password (run setup → Join again);
  a timeout = port 1883 blocked on the server PC (its setup adds the firewall rule; the network must be *Private*).
- More: [apps/agent/README.md → Troubleshooting](../apps/agent/README.md#troubleshooting).

---

## Appendix: by hand

1. **Register the PC** (from any computer that ran `homepanel setup`, or in `/admin` → Computers → Add):
   ```bash
   homepanel agent-key gaming-pc --name "Gaming PC" --mac AA:BB:CC:DD:EE:FF   # MAC optional, enables Wake-on-LAN
   ```
   This calls the server's admin API (`POST /api/admin/agents`) and writes `~/.homepanel/agent-gaming-pc.yaml` with the
   MQTT login and the PC's signing key.
2. **LibreHardwareMonitor** on the PC: run as administrator, *Options → Run On Windows Startup* and
   *Options → Remote Web Server → Run* (port 8085).
3. **Install the agent** from a source build: copy the yaml to `C:\ProgramData\HomePanel\agent.yaml`, then in an admin
   PowerShell in `apps\agent\dist\windows` run `.\install.ps1` (it needs Node.js 22 and creates the *HomePanel Agent*
   scheduled task). Details: [apps/agent/README.md](../apps/agent/README.md).
4. Within seconds the PC shows **online** in `/admin` and in `homepanel doctor`.
