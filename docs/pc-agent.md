# PC agent (temperatures, drives, PC buttons)

The HomePanel agent is a small background program for each PC you want on a screen (e.g. the gaming PC). It reads
temperatures from **LibreHardwareMonitor**, drive space, and offers allowlisted actions (open a folder, launch Steam,
sleep…). It only connects *out* to the MQTT broker, so it opens no ports.

The full guide is **[apps/agent/README.md](../apps/agent/README.md)**. Short version for Windows:

1. **Register the PC** (from any computer that ran `homepanel setup`):
   ```bash
   homepanel agent-key gaming-pc --name "Gaming PC" --mac AA:BB:CC:DD:EE:FF   # MAC optional, enables Wake-on-LAN
   ```
   This calls the server's admin API (`POST /api/admin/agents`) and writes `~/.homepanel/agent-gaming-pc.yaml` with the
   MQTT login and the PC's signing key. Or do it in `/admin` → Computers → Add.
2. **LibreHardwareMonitor** on the PC: run as administrator, *Options → Run On Windows Startup* and
   *Options → Remote Web Server → Run* (port 8085).
3. **Install the agent**: copy the yaml to `C:\ProgramData\HomePanel\agent.yaml`, then in an admin PowerShell in the
   agent folder run `.\install-windows.ps1` (it creates the *HomePanel Agent* scheduled task).
4. Within seconds the PC shows **online** in `/admin` and in `homepanel doctor`. Add `pc-temps`, `pc-drives` and
   `buttons` widgets with `pc: gaming-pc` (see [widgets.md](widgets.md)).

Commands from HomePanel are HMAC-signed with the PC's key, and the PC only runs actions listed in its own `agent.yaml`.
