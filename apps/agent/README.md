# HomePanel PC agent

A small Node.js program that runs on a PC (Windows first; Linux works too) and:

- publishes **temperatures, loads, fans and power** from [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) (LHM), plus built-in CPU/RAM load, every 2 s
- publishes **drive space** every 60 s
- offers **buttons** (open a folder, launch Steam, media keys, lock, sleep…) that run only when the dashboard sends a correctly **signed** command for an id you listed
- announces the sensors to **Home Assistant** (MQTT discovery), so they also appear as HA entities

Everything goes through the Mosquitto broker on the Home Assistant mini PC. The agent only makes
outgoing connections, so no firewall ports need to be opened on the PC.

## Windows setup (Kevin's gaming PC)

1. **Add the PC in HomePanel**: admin page → **PCs → Add**, id `gaming-pc`, name "Gaming PC"
   (add the MAC address for Wake-on-LAN). Copy the **key** it shows.
2. **Build the agent** on any machine with the repo: `pnpm install && pnpm --filter @homepanel/agent build`.
   Copy the folder `apps/agent/dist/windows` to the PC (USB stick, network share…).
3. On the PC, open **PowerShell as administrator** in that folder and run:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\install.ps1 -Server 192.168.1.20 -MqttUser homepanel -MqttPass <mqtt password> -Key <key> -PcId gaming-pc
   ```
   (Leave the parameters out and it asks for them.) It installs Node.js 22 with winget if needed,
   copies the agent to `C:\Program Files\HomePanel\agent`, writes `C:\ProgramData\HomePanel\agent.yaml`
   with the suggested buttons, offers to install LibreHardwareMonitor, and registers the
   **"HomePanel Agent"** scheduled task (at your logon, highest privileges, restarts on failure).
4. **Set up LibreHardwareMonitor once** (the installer reminds you):
   - start it and let it run as administrator; when it asks to install **PawnIO**, say **yes**
     (that driver is how it reads CPU temperatures and fans);
   - **Options → Remote Web Server → Run** (port 8085);
   - **Options → Run On Windows Startup**.
   Check by opening <http://localhost:8085> in a browser.
5. Check it: `homepanel-agent list-sensors` (see the full command the installer prints) shows your
   sensors; within seconds the PC is *online* in HomePanel admin, and in Home Assistant under
   **Settings → Devices & services → MQTT → Gaming PC**.

Uninstall: `& "C:\Program Files\HomePanel\agent\uninstall.ps1"` (add `-RemoveConfig` to also delete
`C:\ProgramData\HomePanel`).

Linux (e.g. the mini PC itself, if it runs a normal distro): `pnpm build`, then
`sh apps/agent/linux/install-linux.sh` installs a systemd *user* service. Sensors come from
`/sys/class/hwmon` and `/sys/class/thermal` (no LHM), and actions run with `xdg-open`, `playerctl`,
`pactl`, `xdotool`, `loginctl` and `systemctl`.

## Commands

```
homepanel-agent run [--config f] [--mock] [--dry-run]   connect and publish (default command)
homepanel-agent list-sensors [--all] [--json] [--mock]  table of sensor id, name, value
homepanel-agent test-action <id> [--really]             show what a button runs; --really runs it
homepanel-agent init [--pc-id … --key …] [--force]      write a default agent.yaml
homepanel-agent check-config                            validate agent.yaml
homepanel-agent config-path                             which agent.yaml is used
```

On Windows run them as `& "C:\Program Files\nodejs\node.exe" "C:\Program Files\HomePanel\agent\homepanel-agent.mjs" list-sensors`.
From the repo: `pnpm --filter @homepanel/agent dev` runs `run --mock`.

`--mock` uses a bundled LHM capture (Ryzen 7 7800X3D + RTX 4080 SUPER) with drifting values, fake
drives, and logs actions instead of running them, so the whole pipeline can be tried on any machine.

**Where agent.yaml is found:** `--config`, else `HOMEPANEL_AGENT_CONFIG`, else `agent.yaml` next to
the program, else `%ProgramData%\HomePanel\agent.yaml` (Windows) / `~/.config/homepanel/agent.yaml`.

## Config reference (`agent.yaml`)

| key | default | meaning |
| --- | --- | --- |
| `pcId` | required | lowercase id, must match HomePanel admin → PCs (e.g. `gaming-pc`) |
| `name` | `pcId` | display name, also the Home Assistant device name |
| `mqtt.url` | required | `mqtt://host:1883` (also `mqtts://`, `ws://`) |
| `mqtt.username` / `mqtt.password` | – | broker login |
| `key` | required | HMAC key from HomePanel admin; commands signed with anything else are ignored |
| `lhmUrl` | `http://localhost:8085/data.json` | LibreHardwareMonitor web server |
| `lhmAuth` | – | `{username, password}` if you enabled auth in LHM's web server |
| `sensorSource` | `auto` | `auto` (LHM on Windows, hwmon on Linux), `lhm`, `hwmon`, `builtin` (CPU/RAM load only) |
| `sensors` | `auto` | `auto` = temps, loads, fans, power, clocks, data (no voltages, per-thread loads, D3D, SMART counters), or a list of ids / wildcards: `[cpu_package, 'gpu_*', 'nvme*_temp']` |
| `publishIntervalMs` | `2000` | sensor interval |
| `drivesIntervalMs` | `60000` | drive space interval |
| `haDiscovery` | `true` | publish Home Assistant MQTT discovery configs |
| `haSensors` | `default` | which published sensors become HA entities: `default` = temperature/load/fan/power, or ids / wildcards |
| `dryRun` | `false` on Windows, `true` elsewhere | log actions instead of running them |
| `log.level` / `log.file` | `info` / – | logging |
| `actions` | `{}` | the buttons, see below |

Every value is validated on start; mistakes are reported with their path, e.g.
`actions.vol-up.keys: unknown key "volume_upp"`.

### Sensor ids

Stable slugs, the same on every PC that has the part, and the same from LHM and Linux hwmon:

| id | what |
| --- | --- |
| `cpu_package`, `cpu_core_max`, `cpu_core_average`, `cpu_ccd1`, `cpu_core3` | CPU temperatures |
| `cpu_load_total`, `cpu_load_core_max`, `cpu_power`, `cpu_clock_core1` | CPU load / power / clocks |
| `gpu_core`, `gpu_hotspot`, `gpu_memory_junction` | GPU temperatures (VRAM temp is `gpu_memory_junction` on NVIDIA and AMD) |
| `gpu_load_core`, `gpu_power`, `gpu_fan1`, `gpu_memory_used` | GPU load / power / fans / VRAM |
| `gpu2_*`, `cpu2_*` | a second GPU (integrated graphics rank after discrete cards) / CPU |
| `nvme0_temp`, `nvme1_temp`, `disk0_temp`, `nvme0_load_used_space` | drives, numbered like LHM |
| `motherboard`, `mb_vrm_mos`, `mb_pch`, `fan1`…`fan7`, `fan_pump` | motherboard sensors and fan headers |
| `ram_load`, `ram_used` | memory (also available without LHM) |

`homepanel-agent list-sensors --all` shows everything your PC reports.

## Adding actions

Each entry under `actions:` is an id the dashboard can trigger. Nothing else can run.

```yaml
actions:
  open-drive-e:  { type: open, path: 'E:\', label: "E:", icon: "💾" }    # drive widget uses open-drive-<letter>
  open-sovereign: { type: open, path: 'D:\Projects\Sovereign_V2' }
  launch-obs:    { type: launch, exe: 'C:\Program Files\obs-studio\bin\64bit\obs64.exe' }
  launch-spotify: { type: launch, exe: 'spotify:' }                         # protocol links work
  launch-studio-direct:
    type: launch
    exe: '%LOCALAPPDATA%\Roblox\Versions\*\RobloxStudioBeta.exe'           # * = newest match
  obs-record:    { type: keys, keys: ctrl+shift+f9 }
  media-prev:    { type: keys, keys: media_prev }
  backup:        { type: script, script: 'scripts\backup.ps1', args: ['-Quick'], timeoutMs: 120000 }
  router:        { type: url, url: 'http://192.168.1.1' }
  sleep:         { type: system, command: sleep, guard: confirm }
```

| type | fields | Windows does |
| --- | --- | --- |
| `open` | `path` | `explorer.exe <path>` |
| `launch` | `exe`, `args` | full path → started directly; a name on PATH or a protocol link (`steam://…`, `roblox-studio:`) → `cmd /c start "" "<exe>"`; `*` in a path → newest match |
| `url` | `url` | opens in the default browser/handler (`file:` and `javascript:` refused) |
| `keys` | `keys` | `media_play_pause`, `media_next`, `media_prev`, `volume_up`, `volume_down`, `volume_mute`, or a combo like `ctrl+shift+m`, `win+alt+k`, `f13` |
| `script` | `script`, `args`, `timeoutMs` | `.ps1` → `powershell -ExecutionPolicy Bypass -File <script>`; `.cmd/.bat` → cmd. Relative paths are next to agent.yaml |
| `system` | `command` | `lock`, `sleep`, `restart` (5 s), `shutdown` (5 s), `monitors-off` |

All types accept `label`, `icon` (emoji) and `guard`: `confirm` (the screen asks first),
`home-only` (refused from screens outside your network), `confirm+home-only`. `sleep` defaults to
`confirm`; `restart` and `shutdown` default to `confirm+home-only`.

Try an action without the dashboard: `homepanel-agent test-action <id>` (shows the command),
then `--really`. After editing agent.yaml, restart the agent:
`Stop-ScheduledTask 'HomePanel Agent'; Start-ScheduledTask 'HomePanel Agent'`.

**Audio:** `scripts\mic-mute.ps1` toggles the default microphone with Windows Core Audio (no
install needed). `scripts\audio-switch.ps1 -Name Speakers` switches the playback device and needs
the **AudioDeviceCmdlets** module once, in an admin PowerShell:
`Install-Module AudioDeviceCmdlets -Scope AllUsers -Force`. List your device names with
`Get-AudioDevice -List`, then put them in the `audio-speakers` / `audio-headphones` args.

**Roblox Studio:** `launch-studio` uses the `roblox-studio:` link the Roblox installer registers,
which always opens the current version. If it does not work, use the wildcard path shown above.

## Security

- Commands are `{id, action, ts, sig}` with `sig = HMAC-SHA256(key, "id.action.ts")` in hex. The agent
  checks it in constant time, rejects timestamps more than 10 s away from its clock, and remembers
  recent ids to reject replays. Rejections are answered on `cmd_result` with the reason.
- `action` is only ever a lookup key into `actions:`. Unknown ids are answered `unknown-action`
  and logged; nothing from MQTT reaches a shell. Launch/script values come only from agent.yaml,
  and those containing cmd.exe metacharacters are refused.
- agent.yaml holds the key and MQTT password; the installer restricts it to you, SYSTEM and Administrators.

## MQTT topics (pc = `pcId`)

| topic | retained | payload |
| --- | --- | --- |
| `homepanel/agent/<pc>/status` | yes | `online` / `offline` (offline is the last will) |
| `homepanel/agent/<pc>/sensors` | no | `{ts, pc, hostname, sensors: [{id, name, kind, value, unit, hardware}]}` |
| `homepanel/agent/<pc>/drives` | yes | `{ts, pc, drives: [{letter, label, totalGB, freeGB}]}` |
| `homepanel/agent/<pc>/actions` | yes | `{pc, actions: [{id, label, type, icon, guard}]}` |
| `homepanel/agent/<pc>/cmd` | – | command from the server |
| `homepanel/agent/<pc>/cmd_result` | no | `{id, ok, error?}` |
| `homeassistant/sensor/homepanel_<pc>/<id>/config` | yes | HA discovery (one per sensor) |

## Troubleshooting

- **Only CPU load and memory show up, no temperatures.** The agent cannot reach LHM. Is
  LibreHardwareMonitor running (tray icon)? Is **Options → Remote Web Server → Run** ticked? Open
  <http://localhost:8085/data.json>. If you changed LHM's port, set `lhmUrl`. The agent log says
  `Could not read http://localhost:8085/data.json`.
- **LHM shows no CPU temperatures / fans.** It needs administrator rights and the **PawnIO** driver.
  Reinstall/update LHM and accept the PawnIO prompt. If **Windows Defender** quarantines a
  "WinRing0" driver, that is an old LHM version: update it (current versions use PawnIO, which is
  signed). Some Memory Integrity (Core isolation) setups block older drivers too.
- **The PC never shows online.** Check `mqtt.url`, username and password (`homepanel-agent run`
  in a terminal prints `MQTT error: Not authorized` for a wrong login). Port 1883 must be reachable
  from the PC: try `Test-NetConnection 192.168.1.20 -Port 1883`. If it fails, the block is on the
  mini PC side (Mosquitto app not started, or a router/VLAN firewall), not on the gaming PC.
- **Buttons answer "bad signature".** The `key` in agent.yaml does not match HomePanel admin.
  **"stale command"**: the server's and PC's clocks differ by more than 10 s; turn on
  *Settings → Time → Set time automatically* on the PC.
- **Buttons answer "unknown-action".** The id is not in agent.yaml (or the agent was not restarted).
- **Sleep hibernates instead.** With hibernation on, Windows' `SetSuspendState` hibernates. Run
  `powercfg /h off` in an admin prompt if you want real sleep.
- **A launched program opens as administrator.** The agent task runs with highest privileges, so
  programs it starts directly are elevated too. Protocol links (`steam://`, `roblox-studio:`) and
  names started via `start` usually hand off to an already-running, non-elevated process.
- **Is it running?** `Get-ScheduledTask 'HomePanel Agent'` (State: Running). Run it by hand in a
  terminal to see the log: stop the task, then `node homepanel-agent.mjs run`. Set `log.file` to
  keep a log.

## Development

`pnpm build` (esbuild → `dist/homepanel-agent.mjs`, one file with all dependencies, plus
`dist/windows/`), `pnpm typecheck`, `pnpm test` (vitest: LHM parsing on two fixtures — Ryzen +
NVIDIA with SensorIds, and Intel + Radeon from an older LHM in a German locale — slugs, signatures,
config, actions with a dry-run executor, discovery, drives, and an end-to-end run against an
in-process aedes broker). Fixtures live in `src/fixtures/`.
