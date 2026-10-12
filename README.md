# HomePanel

Dashboards for every screen in the house, powered by Home Assistant. One web app runs fullscreen
on tablets and monitors; a small agent on each PC streams its temperatures and runs the buttons you
define; a setup wizard (with an optional AI guide) installs and connects everything.

## See it in 2 minutes (no hardware needed)

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

## Set it up for real

Follow **[docs/getting-started.md](docs/getting-started.md)**: the ACEMAGICIAN T8 Plus path, end to end.
Other guides: [hosts](docs/hosts.md) · [screens (iPad, Fire HD 8)](docs/screens.md) ·
[PC agent](docs/pc-agent.md) · [doorbells](docs/doorbells.md) · [Zigbee ZBT-1](docs/zigbee-zbt1.md) ·
[remote access](docs/remote-access.md) · [AI assistant](docs/ai-assistant.md) · [widgets & profiles](docs/widgets.md).

Short version:

1. Install Home Assistant OS on the mini PC, then run `pnpm --filter @homepanel/installer start setup`
   (add `--ai` for the AI guide) from any computer on the network. It onboards HA, sets up MQTT and
   the ZBT-1, mints the token and installs the HomePanel app.
2. On each PC, open PowerShell as administrator: `irm http://<mini-pc>:8080/agent/install.ps1 | iex`.
3. On each screen, open `http://<mini-pc>:8080`, then approve its 6-digit code in **Admin → Screens**.

## What's in here

| Path | What |
| --- | --- |
| `apps/server` | The hub: HA bridge, MQTT, pairing, profiles, doorbell takeover, camera proxy, admin API, AI assistant, demo mode |
| `apps/kiosk` | The screen app (React PWA) and the admin UI |
| `apps/agent` | Windows/Linux PC agent: LibreHardwareMonitor sensors, drives, allowlisted actions |
| `apps/installer` | `homepanel setup` wizard + AI setup guide |
| `packages/protocol` | Shared message, topic and profile contract |
| `packages/ai` | OpenAI-compatible assistant: Gemini, Groq, OpenRouter, Ollama, LM Studio |
| `deploy/` | Home Assistant app (add-on), Docker image, compose file |

`pnpm test` runs 237 tests across all packages.

## Security model in one paragraph

Screens hold revocable device tokens; the HA token stays on the server. PCs only run action ids
listed in their own `agent.yaml`, and only when the command carries a valid HMAC signature less than
10 s old. Restart/shutdown need a confirm tap and are refused from outside the home network. Use
Tailscale for remote access and never port-forward. Known trade-offs: any paired screen can call any
HA service; all PCs share one MQTT login; the agent bootstrap is fetched over plain HTTP on your LAN.
