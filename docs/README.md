# HomePanel guides

HomePanel turns tablets, old phones and spare monitors into wall dashboards on top of Home Assistant: PC temperatures
and drives, buttons that do things on your PC, lights, doorbell camera pop-ups, GIFs and more.

## Start here

1. **[getting-started.md](getting-started.md)**: the full path on an ACEMAGICIAN T8 Plus (Intel N100) mini PC, from
   wiping Windows to a working dashboard, in about 30–45 minutes.
2. Different hardware? **[hosts.md](hosts.md)** covers other mini PCs, Raspberry Pi 4/5, Home Assistant Green,
   Linux + Docker, NAS/Proxmox VMs and Windows-only (VirtualBox).

Or just run the installer from a checkout on any computer on your network. It does most steps for you and remembers
where you stopped:

```bash
pnpm install && pnpm -r build
node apps/installer/dist/cli.js setup          # add --ai for the optional AI guide
```

## Guides

| Guide | What |
| --- | --- |
| [screens.md](screens.md) | iPad, Fire HD 8 (10th gen, incl. removing ads), Android, Raspberry Pi, Windows monitors |
| [pc-agent.md](pc-agent.md) | Show the gaming PC's temps/drives and add PC buttons |
| [doorbells.md](doorbells.md) | Reolink (official), Eufy (community), any camera + button |
| [zigbee-zbt1.md](zigbee-zbt1.md) | Home Assistant Connect ZBT-1 + ZHA |
| [remote-access.md](remote-access.md) | Tailscale, never port-forward |
| [widgets.md](widgets.md) | Profile YAML reference, every built-in widget, writing a new one |
| [ai-assistant.md](ai-assistant.md) | Optional AI helper: free providers, local Ollama, privacy |

## Installer commands

| Command | What |
| --- | --- |
| `homepanel setup [--ai \| --plain]` | Guided setup (resumable; state in `~/.homepanel/setup-state.json`) |
| `homepanel setup --step <id>` | Run one step: detect, host, onboard, token, mqtt, server, env, zigbee, doorbells, remote, screens, pcs, health |
| `homepanel agent-key <pcId>` | Register a PC with the server and write its `agent.yaml` |
| `homepanel screens [ipad\|fire-hd8\|android\|pi\|windows]` | Print per-device setup steps with your server address |
| `homepanel doctor` | Check HA, token, MQTT, server and PC agents, with fixes |

## Deployment files

- `deploy/ha-app/`: the Home Assistant app (add-on) for HA OS
- `deploy/compose/`: Docker Compose for Linux (HA Container + Mosquitto + HomePanel)
- `deploy/docker/Dockerfile`: the HomePanel image (server + kiosk), built from the repo root
