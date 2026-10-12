# HomePanel PC agent

A small background program for your PC. It:

- sends **temperatures, loads, fan speeds and power** to your HomePanel dashboards (and to Home
  Assistant as sensors),
- sends **drive free space** every minute,
- offers **buttons** that the dashboard can press: open a folder, start Steam or Roblox Studio,
  play/pause, volume, mute your mic, screens off, lock, sleep, restart, your own scripts.

It only connects *out* to your MQTT broker (the Mosquitto that runs next to Home Assistant). It
opens no ports, so there is nothing to allow in the firewall.

Windows is the main target; Linux works too (sensors from `/sys/class/hwmon`).

---

## Install on Windows

You need: the HomePanel server running, and the MQTT login it uses (the setup wizard printed it).

### 1. Add the computer in HomePanel

Open the HomePanel admin page → **Computers** → **Add computer**. Pick an id such as
`gaming-pc`. You'll get a **key**: a long random string. Keep the page open; you need the key in step 3.

### 2. LibreHardwareMonitor (for temperatures)

Windows doesn't let normal programs read CPU/GPU temperatures. LibreHardwareMonitor (free, open
source) does, and shares them on a small local web page that the agent reads.

The installer offers to install it for you (`winget install LibreHardwareMonitor.LibreHardwareMonitor`).
Then, once:

1. Start LibreHardwareMonitor **as administrator** (right-click → *Run as administrator*).
   Without admin rights it shows almost no sensors.
2. **Options → Run On Windows Startup**: tick it. It then starts elevated at every logon.
3. **Options → Remote Web Server → Run**: tick it. Leave the port at **8085**.
   Check it works by opening <http://localhost:8085> in a browser.
4. Optional: *Start Minimized* and *Minimize To Tray*.

> **About the driver and antivirus warnings.** To read sensors, LibreHardwareMonitor needs a kernel
> driver. Old versions used *WinRing0*, which Windows Defender now flags as vulnerable. Current
> versions use **PawnIO**, which is signed by Microsoft. If LHM offers to install PawnIO, say yes. If
> Defender complains about WinRing0, update LibreHardwareMonitor.

### 3. Run the installer

Download the agent release zip and unzip it. Then open **PowerShell as administrator** in that folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install-windows.ps1
```

It will:

- use Node.js 22+ (it offers to install Node LTS with winget if you don't have it) and keep a
  private copy of `node.exe` in `C:\Program Files\HomePanel\Agent`,
- ask for the server address, MQTT login, PC id and the **key** from step 1, and write
  `C:\ProgramData\HomePanel\agent.yaml`. Only you and administrators can read that file.
- copy the example scripts to `C:\ProgramData\HomePanel\scripts\`,
- create the scheduled task **HomePanel Agent**, which starts hidden at your logon and restarts
  itself if it crashes, and then start it.

Within a few seconds the PC shows up as **online** in the admin page.

#### Why a scheduled task and not a Windows service?

A Windows service runs in a separate, invisible session ("session 0"). If the agent ran there,
**Open D:\Projects** would open an Explorer window that nobody can see, and **Launch Steam**
would start Steam where you can't use it. Media keys and *lock* wouldn't reach you either. The
scheduled task runs the agent **as you, in your desktop session**, so every button works as if you
had clicked it yourself. The cost: the agent only runs while you're logged in. For a gaming PC,
that's when you want the buttons anyway.

By default the task runs with normal rights, so the programs it launches (games, Discord) are not
elevated. If you really need elevated actions, rerun the installer with `-Elevated`.

### Useful commands

```powershell
$agent = "C:\Program Files\HomePanel\Agent"
& "$agent\node.exe" "$agent\agent.cjs" list-sensors          # every sensor id + current value
& "$agent\node.exe" "$agent\agent.cjs" list-sensors --all    # incl. voltages, per-thread loads
& "$agent\node.exe" "$agent\agent.cjs" test-action mute-mic  # try a button locally (asks y/N)
& "$agent\node.exe" "$agent\agent.cjs" test-action lock --dry-run   # only show the command
& "$agent\node.exe" "$agent\agent.cjs" check-config
& "$agent\node.exe" "$agent\agent.cjs" print-config-path
& "$agent\node.exe" "$agent\agent.cjs" --version
Stop-ScheduledTask "HomePanel Agent"; Start-ScheduledTask "HomePanel Agent"   # restart after editing agent.yaml
```

Uninstall: `& "C:\Program Files\HomePanel\Agent\uninstall-windows.ps1"`. Add `-RemoveConfig` to
also delete `C:\ProgramData\HomePanel`.

---

## Install on Linux (Ubuntu, mini PCs, ...)

```sh
sh install-linux.sh            # copies agent.cjs, creates ~/.config/homepanel/agent.yaml, installs a systemd user unit
nano ~/.config/homepanel/agent.yaml        # set pcId, mqtt, key; replace the Windows-only actions
systemctl --user start homepanel-agent
journalctl --user -u homepanel-agent -f
sudo loginctl enable-linger $USER          # optional: keep running when nobody is logged in
```

Sensors come from `/sys/class/hwmon` (`k10temp`/`coretemp` for the CPU, `amdgpu`, `nvme`, Super
I/O chips for fans) plus `/proc/stat` and `/proc/meminfo` for loads, so you don't need lm-sensors. NVIDIA
GPUs with the proprietary driver don't appear in hwmon. Drives come from `df`.

The Linux actions are best effort: `xdg-open`, `playerctl` (media keys, with `xdotool` as a fallback), `pactl`
(volume, mic mute), `loginctl lock-session`, and `systemctl suspend|reboot|poweroff`.

---

## Configuration: `agent.yaml`

Where the agent looks, in order: `--config <file>`, the `HOMEPANEL_AGENT_CONFIG` environment
variable, `agent.yaml` next to `agent.cjs`, and finally `C:\ProgramData\HomePanel\agent.yaml` (Windows) or
`~/.config/homepanel/agent.yaml` (Linux). See [`agent.example.yaml`](agent.example.yaml) for a full example.

| key | meaning |
| --- | --- |
| `pcId` | id from the admin page (`gaming-pc`) |
| `name` | display name (also the Home Assistant device name) |
| `mqtt.url` / `username` / `password` | your broker, e.g. `mqtt://192.168.1.20:1883` |
| `key` | the key from **Add computer** |
| `sensorSource` | `auto` (LHM on Windows, hwmon on Linux), `lhm`, `hwmon`, `mock` |
| `lhmUrl` | default `http://localhost:8085/data.json` |
| `publishIntervalMs` | sensor update rate, default 2000 |
| `sensors` | `auto` or a list of ids/wildcards: `[cpu_package, "gpu_*", "nvme_*_temp"]` |
| `ha_sensors` | `default` (all main temperatures + CPU/GPU/RAM load), `none`, or a list |
| `actions` | your buttons (below) |

### Sensor ids

Ids are stable: they're built from the kind of hardware and the sensor name, not from LHM's
internal numbering, so they survive reboots and LHM updates. Typical ids:

`cpu_package`, `cpu_ccd1`, `cpu_core_1_clock`, `cpu_total_load`, `cpu_package_power`,
`gpu_core`, `gpu_hotspot`, `gpu_memory_junction`, `gpu_core_load`, `gpu_fan_1`, `gpu_package_power`,
`ram_load`, `nvme_samsung_ssd_990_pro_2tb_temp`, `mainboard_vrm_mos`, `fan_2` (motherboard fan header 2).
An integrated GPU becomes `gpu2_*`, so `gpu_*` is always your graphics card.

Run `list-sensors` to see yours.

### Buttons (`actions`)

Only actions listed here can run. The dashboard sends just the action **id**, signed with the key.
It can never send a command line, a path or arguments.

```yaml
actions:
  open-projects:  { type: open, path: 'D:\Projects', label: Projects, icon: "🗂️" }
  launch-steam:   { type: launch, exe: 'C:\Program Files (x86)\Steam\steam.exe', label: Steam, icon: "🎮" }
  launch-studio:  { type: launch, find: '%LOCALAPPDATA%\Roblox\Versions\*\RobloxStudioBeta.exe', label: Roblox Studio }
  play-pause:     { type: keys, key: media_play_pause }
  mute-mic:       { type: system, op: mute_mic }
  restart:        { type: system, op: restart, guard: confirm+home-only }
  audio-headphones: { type: script, file: 'scripts\audio-headphones.ps1' }
  open-ha:        { type: url, url: http://homeassistant.local:8123 }
```

| type | fields | Windows | Linux |
| --- | --- | --- | --- |
| `open` | `path` | `explorer.exe <path>` | `xdg-open` |
| `launch` | `exe` **or** `find`, `args` | `cmd /c start "" "<exe>"`, so names on PATH or in *App Paths* work | runs `exe` directly |
| `keys` | `key`: `media_play_pause`, `media_next`, `media_prev`, `volume_up`, `volume_down`, `volume_mute` | virtual media key | `playerctl` / `pactl` |
| `system` | `op`: `lock`, `sleep`, `restart`, `shutdown`, `monitors_off`, `mute_mic` | built in, no extra software | `loginctl` / `systemctl` / `xset` / `pactl` |
| `script` | `file`, `shell` (`powershell`/`cmd`/`sh`), `args`, `timeoutMs` (default 30 s) | your script | your script |
| `url` | `url` (http/https, `steam:`, `discord:`, `spotify:`, `ms-settings:`) | default browser/app | `xdg-open` |

Common fields: `label`, `icon` (an emoji), and `guard`:

- `confirm`: the screen asks "are you sure?" first.
- `home-only`: refused when the dashboard is used from outside your home network.
- `confirm+home-only`: both. `restart` and `shutdown` default to this, and `sleep` defaults to `confirm`.

`launch.find` takes a wildcard path and starts the **newest** match. Use it for apps that install
into versioned folders, like Roblox Studio (`Versions\version-…\`) and Discord (`app-1.0.9…\`).

`%VARIABLES%` (Windows) and `~` / `$VARS` (Linux) are expanded in paths. Relative script paths are
resolved next to `agent.yaml`.

**Audio output switching** (`audio-speakers` / `audio-headphones`) uses the free
*AudioDeviceCmdlets* PowerShell module. Install it once in an admin PowerShell:

```powershell
Install-Module -Name AudioDeviceCmdlets -Scope AllUsers -Force
Get-AudioDevice -List | Where-Object Type -eq 'Playback' | Format-Table Index, Name
```

Then edit the `-Name` in `C:\ProgramData\HomePanel\scripts\audio-speakers.ps1` and
`audio-headphones.ps1` to match part of your device names.

After editing `agent.yaml`, restart the agent. The dashboard picks up new buttons immediately.

---

## Security model

- **Allowlist only.** The agent runs only what is in `agent.yaml` on this PC. A message over MQTT
  contains an action id, never a command, path or argument. Unknown ids are logged and refused.
- **Signed commands.** Each command carries an HMAC-SHA256 signature made with the per-PC key
  (`id.action.ts`). The agent checks it in constant time and refuses commands older or newer than
  **10 seconds** (so keep the clocks synced; Windows does this by default). It also refuses any
  command id it has already seen (the last 500 are remembered). Someone who can publish on your MQTT
  broker still can't press your buttons without the key.
- **No shell.** Processes start with argument lists (`spawn`, no shell). Built-in PowerShell
  snippets are fixed text passed with `-EncodedCommand`. Values for `launch` that contain cmd.exe
  special characters (`& | < > ^ % ! "`) are refused.
- **Your session, your rights.** The agent runs as you, not as SYSTEM, and not elevated by default.
- **Secrets.** `agent.yaml` holds the key and MQTT password. The installer limits it to you,
  Administrators and SYSTEM. If the key leaks, delete and re-add the PC in the admin page and put
  the new key in `agent.yaml`.
- `home-only` and `confirm` guards are enforced by the HomePanel server and screens. The agent
  advertises them; it can't tell where a tap came from.

---

## Troubleshooting

**The PC shows offline.**
Check `C:\ProgramData\HomePanel\agent.log`. `Not authorized` means the MQTT username or password is
wrong. `ECONNREFUSED` / `ETIMEDOUT` means a wrong server address, or Mosquitto isn't reachable
from this PC (port 1883 on the *server* must be open). Is the task running? Run
`Get-ScheduledTask "HomePanel Agent"`.

**No temperatures / "sensor read failed".**
- Open <http://localhost:8085/data.json>. If nothing loads, LibreHardwareMonitor isn't running or
  *Remote Web Server → Run* is off.
- If the page loads but there are no CPU temperatures, LHM isn't running **as administrator** or its
  driver didn't load. Enable *Run On Windows Startup* (which starts it elevated) and accept the
  PawnIO driver.
- If you changed LHM's port or turned on its web server password, set `lhmUrl` / `lhmAuth`.

**A sensor shows 0 or is missing.** Run `list-sensors --all`. Some motherboard inputs aren't
connected and read 0; those are hidden automatically.

**A button does nothing.** Run `test-action <id>` in a normal (non-admin) PowerShell. It prints the
exact command and any error. Commands are rejected as *stale* if the clocks of the server and the PC
differ by more than 10 s.

**Sleep hibernates instead.** Windows' `SetSuspendState` hibernates when hibernation is on. Run
`powercfg /h off` in an admin prompt if you want real sleep.

**Mic mute.** The mic mute button toggles the default recording device, plus the default
*communications* device that Discord and Teams use. It shows the same state as the Windows sound settings.

**Firewall.** Nothing to configure. The agent only makes an outgoing connection to MQTT and reads
LibreHardwareMonitor on `localhost`.

**Home Assistant entities.** They appear under *Settings → Devices → MQTT → <your PC name>* with ids
like `sensor.gaming_pc_cpu_package`. They show *unavailable* when the PC is off.

---

## Development

```sh
pnpm --filter @homepanel/agent test        # vitest: parsers, HMAC, config, discovery, action planning
pnpm --filter @homepanel/agent typecheck
pnpm --filter @homepanel/agent build       # tsc → dist/*.js
pnpm --filter @homepanel/agent bundle      # esbuild → dist/agent.cjs + dist/release/
pnpm --filter @homepanel/agent smoke       # aedes broker + bundled agent --mock, end to end
pnpm --filter @homepanel/agent dev         # run from source with mock sensors (needs a broker + agent.yaml)
```

`--mock` uses wiggling fake sensors and drives. Real actions are only *logged*, never run. A hidden action
type `echo` (only honoured with `--mock`) lets tests exercise the signed-command path end to end.
