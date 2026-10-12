/**
 * The agent.yaml written by `homepanel-agent init` (and shipped as agent.example.yaml).
 * Kevin's day-one buttons for a Windows gaming PC.
 */
export interface InitOptions {
  pcId: string;
  name: string;
  mqttUrl: string;
  mqttUser?: string;
  mqttPass?: string;
  key: string;
}

const yq = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function defaultConfigYaml(o: InitOptions): string {
  return `# HomePanel PC agent configuration  (check it with: homepanel-agent check-config)
#
# Windows: C:\\ProgramData\\HomePanel\\agent.yaml   Linux: ~/.config/homepanel/agent.yaml
# Paths may use %VARS% on Windows (%USERPROFILE%, %LOCALAPPDATA%) and ~ / $VARS on Linux.
# After editing, restart the agent:  Restart-ScheduledTask "HomePanel Agent"  (or log off and on).

# Short id: lowercase letters, digits, dashes. Must match the id in HomePanel admin → PCs.
pcId: ${o.pcId}
name: ${yq(o.name)}

mqtt:
  url: ${yq(o.mqttUrl)}          # the Mosquitto broker (Home Assistant's Mosquitto app)
  username: ${yq(o.mqttUser ?? "homepanel")}
  password: ${yq(o.mqttPass ?? "")}

# HMAC key from HomePanel admin → PCs → Add. Commands with a wrong signature are ignored.
key: ${yq(o.key)}

# Hardware sensors come from LibreHardwareMonitor's Remote Web Server (Windows).
lhmUrl: http://localhost:8085/data.json
publishIntervalMs: 2000

# "auto" = temperatures, loads, fans, power, clocks (no voltages / per-thread loads),
# or a list of ids / wildcards. See the ids with:  homepanel-agent list-sensors
sensors: auto
# sensors: [cpu_package, cpu_load_total, 'gpu_*', 'nvme*_temp', 'fan*', ram_load]

# Home Assistant MQTT discovery: temperatures/loads/fans/power appear as HA entities.
haDiscovery: true

log:
  level: info
  # file: C:\\ProgramData\\HomePanel\\agent.log

# ---------------------------------------------------------------------------------------------
# Buttons. Only these ids can ever run; the dashboard just sends the id.
#   type:  open (path) | launch (exe, args) | keys (keys) | script (script, args) | url (url)
#          | system (command: lock, sleep, restart, shutdown, monitors-off)
#   label: button text      icon: emoji
#   guard: confirm | home-only | confirm+home-only
# Try one without the dashboard:  homepanel-agent test-action <id> --really
# The drive widget uses open-drive-<letter> automatically, e.g. open-drive-e for E:.
# ---------------------------------------------------------------------------------------------
actions:
  # --- folders ---------------------------------------------------------------------------------
  open-drive-c:   { type: open, path: 'C:\\', label: "C:", icon: "💽" }
  open-drive-d:   { type: open, path: 'D:\\', label: "D:", icon: "💾" }
  open-downloads: { type: open, path: '%USERPROFILE%\\Downloads', label: Downloads, icon: "📥" }
  open-projects:  { type: open, path: 'D:\\Projects', label: Projects, icon: "🗂️" }

  # --- programs --------------------------------------------------------------------------------
  # Roblox Studio lives in a versioned folder that changes with each update. The roblox-studio:
  # link (registered by the Roblox installer) always opens the current version. If it does not
  # work on your PC, use the wildcard path instead - the newest match is started:
  #   exe: '%LOCALAPPDATA%\\Roblox\\Versions\\*\\RobloxStudioBeta.exe'
  launch-studio:  { type: launch, exe: 'roblox-studio:', label: Roblox Studio, icon: "🧱" }
  launch-steam:   { type: launch, exe: 'steam://open/main', label: Steam, icon: "🎮" }
  # Discord's own updater picks the current version:
  launch-discord:
    type: launch
    exe: '%LOCALAPPDATA%\\Discord\\Update.exe'
    args: ['--processStart', 'Discord.exe']
    label: Discord
    icon: "💬"

  # --- media (work whichever window has focus) ---------------------------------------------------
  media-playpause: { type: keys, keys: media_play_pause, label: "Play / Pause", icon: "⏯️" }
  media-next:      { type: keys, keys: media_next, label: Next, icon: "⏭️" }
  vol-up:          { type: keys, keys: volume_up, label: "Vol +", icon: "🔊" }
  vol-down:        { type: keys, keys: volume_down, label: "Vol −", icon: "🔉" }

  # --- audio -----------------------------------------------------------------------------------
  # Toggles mute on the default microphone for every app (Windows Core Audio, no module needed).
  # Prefer Discord's own mute? Set a keybind in Discord → Settings → Keybinds → Toggle Mute and use:
  #   mute-mic: { type: keys, keys: ctrl+shift+m, label: "Mute mic", icon: "🎙️" }
  mute-mic:         { type: script, script: 'scripts\\mic-mute.ps1', label: "Mute mic", icon: "🎙️" }
  # Need the AudioDeviceCmdlets module and your device names: see the comments in the scripts.
  audio-speakers:   { type: script, script: 'scripts\\audio-switch.ps1', args: ['-Name', 'Speakers'], label: Speakers, icon: "🔈" }
  audio-headphones: { type: script, script: 'scripts\\audio-switch.ps1', args: ['-Name', 'Headphones'], label: Headphones, icon: "🎧" }

  # --- system ----------------------------------------------------------------------------------
  monitors-off: { type: system, command: monitors-off, label: "Screens off", icon: "🖥️" }
  lock:         { type: system, command: lock, label: Lock, icon: "🔒" }
  sleep:        { type: system, command: sleep, label: Sleep, icon: "😴", guard: confirm }
  restart:      { type: system, command: restart, label: Restart, icon: "🔄", guard: confirm+home-only }
  shutdown:     { type: system, command: shutdown, label: "Shut down", icon: "⏻", guard: confirm+home-only }
`;
}

export const EXAMPLE_INIT: InitOptions = {
  pcId: "gaming-pc",
  name: "Gaming PC",
  mqttUrl: "mqtt://homeassistant.local:1883",
  mqttUser: "homepanel",
  mqttPass: "change-me",
  key: "paste-the-key-from-homepanel-admin",
};
