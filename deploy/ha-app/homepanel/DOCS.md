# HomePanel

Dashboard server for wall tablets and screens. Open `http://<home-assistant-ip>:8080` on a tablet,
then approve the 6-digit code at `http://<home-assistant-ip>:8080/admin`.

## Options

| Option | What |
| --- | --- |
| `admin_password` | Password for `/admin`. If empty, one is generated and printed in the log. |
| `ai_provider`, `ai_model`, `ai_base_url`, `ai_api_key` | Optional AI assistant in the admin page (gemini, groq, openrouter, ollama, lmstudio, custom). |
| `mqtt_url`, `mqtt_username`, `mqtt_password` | Only if you don't use the Mosquitto broker app (it is detected automatically). |
| `log_level` | debug, info, warn, error |

## Before installing

Install and start the **Mosquitto broker** app (Settings → Apps → App store). HomePanel declares
`services: mqtt:need`, so the Supervisor gives it the broker address and credentials automatically.

## How it talks to Home Assistant

The app sets `homeassistant_api: true`, so the Supervisor gives it `SUPERVISOR_TOKEN`. `run.sh` starts the
server with `HA_URL=http://supervisor/core` and `HA_TOKEN=$SUPERVISOR_TOKEN` (the WebSocket is
`ws://supervisor/core/websocket`). No long-lived token needed.
Data (profiles, paired devices) lives in the app's `/data/homepanel` and is included in HA backups.

The first install builds HomePanel from source on your device (several minutes on an Intel mini PC,
much longer on a Raspberry Pi).
