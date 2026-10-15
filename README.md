# HomePanel

Dashboards for every screen in the house, powered by Home Assistant. One web app runs fullscreen
on tablets and monitors; a small agent on each PC streams its temperatures and runs the buttons you
define; a setup wizard (with an optional AI guide) installs and connects everything.

## Install (Windows 11)

1. Download **`HomePanel-Setup.exe`** from the
   [latest release](https://github.com/theCommitWhisperer/homepanel/releases/latest).
2. Double-click it. The exe isn't code-signed yet, so Windows SmartScreen may say
   "Windows protected your PC": click **More info → Run anyway**, then allow the admin prompt.
3. The HomePanel window opens with a **system check** (this PC, Home Assistant, the HomePanel app,
   sensors) and a **recommended next step**: one button. Typically **Host on this PC** for the fastest
   setup (server, MQTT broker and this PC's agent, all local; it installs Mosquitto and
   LibreHardwareMonitor with winget after showing you exactly what it will do), or **Join this PC to my
   HomePanel** on your other PCs. Afterwards the same window is the **control panel** (status, logs,
   buttons editor), reachable from the tray icon without another admin prompt.
4. On each screen (iPad, Fire tablet, monitor), open `http://<that-pc>:8080`, then approve its
   6-digit code in **Admin → Screens**.

No Node, pnpm or git needed: everything is inside the one exe. It also runs by hand:

| Command | What |
| --- | --- |
| `HomePanel-Setup.exe server --demo` | Try it with fake devices, then open http://localhost:8080/?token=demo (admin password `demo`) |
| `HomePanel.exe` | The HomePanel window: system check, setup, control (the installer copies itself to `C:\Program Files\HomePanel\HomePanel.exe`) |
| `HomePanel.exe setup --console` | The same setup as a terminal wizard |
| `HomePanel.exe agent list-sensors` | Show this PC's temperatures |
| `HomePanel.exe host-key 192.168.1.251` | Show a host's SSH key fingerprint (compare before trusting your Proxmox host) |
| `HomePanel.exe --help` | Everything else |

Other PCs on your network can download the same exe from the server at
`http://<server>:8080/download/HomePanel.exe`.

Guides: [getting started](docs/getting-started.md) · [hosts](docs/hosts.md) ·
[screens (iPad, Fire HD 8)](docs/screens.md) · [PC agent](docs/pc-agent.md) · [doorbells](docs/doorbells.md) ·
[Zigbee ZBT-1](docs/zigbee-zbt1.md) · [remote access](docs/remote-access.md) ·
[AI assistant](docs/ai-assistant.md) · [widgets & profiles](docs/widgets.md).

## Developers: run from source

Requires Node 22 and pnpm (`npm i -g pnpm`).

```bash
pnpm install
pnpm build
pnpm --filter @homepanel/server demo:run
```

Then open, on the same machine:

| URL | What |
| --- | --- |
| http://localhost:8080/?token=demo | Desk monitor: gaming PC temps, drives, PC buttons, lights |
| http://localhost:8080/?token=ipad | Kitchen iPad: lights, weather, front-door camera |
| http://localhost:8080/?token=fire | Fire HD 8 lite profile |
| http://localhost:8080/admin | Admin (password `demo`) |

Ring the fake doorbell: `curl -X POST http://localhost:8080/api/demo/ring`.

Later, **3. Set up Home Assistant / mini PC** → *Proxmox* creates the Home Assistant OS VM on your Proxmox host over SSH
(root password typed once, never saved) and continues into onboarding; **4. Move the server to Home Assistant** then
hands the gaming PC's server (agent, layouts) to the HomePanel app on HA and retires the local one.

Home Assistant OS on a mini PC instead (the ACEMAGICIAN T8 Plus path): follow
[docs/getting-started.md](docs/getting-started.md), or run `pnpm --filter @homepanel/installer start setup`
(add `--ai` for the AI guide) from any computer on the network. Windows PCs without the exe can still
use `irm http://<server>:8080/agent/install.ps1 | iex` in an admin PowerShell.

Build the exe yourself (on Windows for a `.exe`; Linux/macOS build a native binary the same way):

```bash
pnpm install && pnpm -r build
pnpm --filter @homepanel/desktop sea      # → apps/desktop/dist/HomePanel(.exe)
```

Without packaging, the same bundle runs with plain Node: `node apps/desktop/dist/homepanel.cjs server --demo`.
The window works on Linux too, against a simulated Windows PC + Home Assistant:
`node apps/desktop/dist/homepanel.cjs ui --no-open --fake` prints its address (`--fake=<scenario>`:
kevin, fresh, proxmox, preparing, ha-down, token-expired, ready-to-move, done, second-pc, host-broken).
Pushes to `main` build `HomePanel-Setup.exe` in GitHub Actions (artifact) and publish a release when
`apps/desktop/package.json` has a new version; CI also builds the Home Assistant app image and checks `/api/health`.

## What's in here

| Path | What |
| --- | --- |
| `apps/server` | The hub: HA bridge, MQTT, pairing, profiles, doorbell takeover, camera proxy, admin API, AI assistant, demo mode |
| `apps/kiosk` | The screen app (React PWA) and the admin UI |
| `apps/agent` | Windows/Linux PC agent: LibreHardwareMonitor sensors, drives, allowlisted actions |
| `apps/installer` | `homepanel setup` wizard + AI setup guide |
| `apps/desktop` | `HomePanel.exe`: server, agent and wizard in one Node single executable |
| `packages/protocol` | Shared message, topic and profile contract |
| `packages/ai` | OpenAI-compatible assistant: Gemini, Groq, OpenRouter, Ollama, LM Studio |
| `deploy/` | Home Assistant app (add-on), Docker image, compose file |

`pnpm test` runs about 250 tests across all packages.

## Security model in one paragraph

Screens hold revocable device tokens; the HA token stays on the server. PCs only run action ids
listed in their own `agent.yaml`, and only when the command carries a valid HMAC signature less than
10 s old. Restart/shutdown need a confirm tap and are refused from outside the home network. Use
Tailscale for remote access and never port-forward. Known trade-offs: any paired screen can call any
HA service; all PCs share one MQTT login; the agent bootstrap is fetched over plain HTTP on your LAN.
