# @homepanel/server

The HomePanel server: talks to Home Assistant (WebSocket API) and PC agents (MQTT), pairs screens,
serves dashboard profiles, the camera proxy, media, doorbell takeovers, the AI setup assistant and the
kiosk web app. Fastify 5, Node 22, no native modules; everything persists as JSON/YAML in `DATA_DIR`.

## Run

```bash
pnpm --filter @homepanel/protocol build
pnpm --filter @homepanel/kiosk build      # optional; without it / shows a "kiosk not built" page
pnpm --filter @homepanel/server build
HA_URL=http://homeassistant.local:8123 HA_TOKEN=... MQTT_URL=mqtt://homeassistant.local:1883 \
MQTT_USER=homepanel MQTT_PASS=... ADMIN_PASSWORD=... pnpm --filter @homepanel/server start
```

### Demo (no Home Assistant, no MQTT)

```bash
pnpm --filter @homepanel/server demo     # builds, then runs with --demo, data in ./.demo-data (wiped and re-created every start)
```

- Screens: `http://localhost:8080/?token=demo` (desk-monitor), `?token=ipad` → kitchen-ipad, `?token=fire` → fire-hd8 (lite)
  (the kiosk stores the token and strips it from the URL)
- Admin: `http://localhost:8080/admin`, password `demo`
- Ring the doorbell: `curl -X POST localhost:8080/api/demo/ring`
- Fake HA: `light.living_room|kitchen|desk_lamp` (toggle, brightness, rgb), `switch.desk_fan`, `sensor.outdoor_temperature`,
  `weather.home`, `binary_sensor.front_doorbell_ringing` + `event.front_door_visitor` + `camera.front_door` (Reolink-style),
  `lock.front_door`. Service calls change the fake state and push it to screens. Camera snapshots are generated SVGs
  with the current time; the stream is a multipart stream of SVG frames.
- Fake PC `gaming-pc`: CPU package / hottest core, GPU core / hotspot / VRAM, NVMe0/1 temps, CPU/GPU load, 3 fans
  (values drift with simulated thermal mass), drives C: 1 TB, D: 2 TB, E: 4 TB, 19 actions — `sleep` needs confirm,
  `restart`/`shutdown` need confirm and are home-only. Actions succeed after 300 ms. It has a MAC, so "Wake PC" sends a
  real (harmless) WOL broadcast.

Demo refuses to wipe a non-empty `DATA_DIR` that it didn't create.

## Environment

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | |
| `HOST` | `0.0.0.0` | |
| `DATA_DIR` | `./data` (`./.demo-data` in demo) | copied from `data-example/` on first start when empty |
| `HA_URL` | – | e.g. `http://homeassistant.local:8123`. As an HA app: `http://supervisor/core` automatically |
| `HA_TOKEN` | – | long-lived access token. As an HA app `SUPERVISOR_TOKEN` is used (needs `homeassistant_api: true`) |
| `SUPERVISOR_TOKEN` | – | set by the Supervisor |
| `MQTT_URL`, `MQTT_USER`, `MQTT_PASS` | – | without `MQTT_URL` PC agents are disabled |
| `ADMIN_PASSWORD` | generated | if unset, a random one is written to `DATA_DIR/admin-password.txt` and logged once |
| `KIOSK_DIST` | `../kiosk/dist` (relative to this package) | |
| `DEMO` | – | `1` = demo mode (also `--demo` flag) |

Variables can also live in `DATA_DIR/.env` (written by the installer); real environment variables win.
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | – | override `config.yaml` → `assistant` |
| `TRUST_PROXY` | – | `1` behind a reverse proxy (uses `X-Forwarded-For` for the home/remote decision) |
| `WOL_BROADCAST` | `255.255.255.255` | e.g. `192.168.1.255` |
| `LOG_LEVEL` | `info` | |

## Data dir

```
DATA_DIR/
  config.yaml          doorbells, on_ring, fully_kiosk, assistant  (ServerConfigFileSchema)
  profiles/<id>.yaml   dashboard profiles (ProfileSchema); hand edits are picked up live and pushed to screens
  devices.json         paired screens; tokens stored as sha256 only
  agents.json          {pcId: {name, key, mac?}} — key is the HMAC secret for that PC's agent.yaml
  media/               GIFs/images/videos served at /media/
  admin-password.txt   only if ADMIN_PASSWORD is not set
```

## Routes

All of `packages/protocol` (`REST API` comment), plus a few extras:

| Route | Auth | |
| --- | --- | --- |
| `GET /api/health` | – | `{ok, ha, mqtt, version, demo}` |
| `POST /api/pair/start`, `GET /api/pair/status/:id` | – | 6-digit code, valid 10 min |
| `POST /api/admin/login` `{password}` | – | `{session}` (12 h, in memory; 5 wrong tries → 1 min lockout) |
| `POST /api/admin/logout` | admin | extra |
| `GET /api/admin/pairings`, `POST …/:id/approve {name, profileId}`, `POST …/:id/reject` | admin | `:id` may also be the 6-digit code |
| `GET/PATCH/DELETE /api/admin/devices[/:id]` | admin | list adds `online`, `lastSeen` |
| `GET /api/admin/profiles`, `PUT/DELETE /api/admin/profiles/:id` | admin | PUT body `text/yaml` (or JSON `{yaml}`); DELETE refuses profiles in use (409) |
| `GET/POST /api/admin/agents`, `DELETE /api/admin/agents/:pcId` | admin | |
| `GET /api/admin/entities` | admin | |
| `GET /api/admin/config` (`?format=yaml` for the commented YAML), `PUT /api/admin/config` | admin | secrets redacted as `***`; sending `***` back keeps the stored secret |
| `POST /api/admin/doorbells/:name/test` | admin | extra: fire a takeover now |
| `POST /api/admin/assistant {messages}` | admin | `AssistantReply` or `{error:"no-provider"|"assistant-unavailable"}` |
| `POST /api/admin/assistant/approve {callId}`, `POST /api/admin/assistant/reject {callId}` | admin | reject is an extra |
| `GET /api/camera/:entity/snapshot`, `/stream` | device or admin | proxied from HA `camera_proxy[_stream]` (`image.*` → `image_proxy`) |
| `GET /api/media`, `GET /media/*` | none on LAN, device token when remote | |
| `POST /api/demo/ring {doorbell?}` | – (demo only) | |
| `GET /ws` | `hello` message | kiosk WebSocket (`KioskToServer`/`ServerToKiosk`) |
| everything else (GET) | – | kiosk SPA (`index.html` fallback) |

Device auth: `Authorization: Bearer <token>` or `?t=<token>`. Admin auth: `Authorization: Bearer <session>`.

## Security notes

- Home vs remote: loopback, RFC1918, link-local and IPv6 ULA are **home**; everything else — including
  Tailscale `100.64.0.0/10` and `fd7a:115c:a1e0::/48` — is **remote**. Remote screens get `device.remote: true`
  and agent actions with a `home-only` guard are refused (`error: "home-only"`).
- Actions with a `confirm` guard need `confirmed: true` in the WS `action` message, else `error: "confirm-required"`.
- Agent commands are signed: `sig = hex(HMAC-SHA256(agentKey, "${id}.${action}.${ts}"))`, result awaited 10 s.
- Screens never see the HA token; camera images go through the proxy.

## Doorbells

`config.yaml`:

```yaml
doorbells:
  front: { provider: reolink, ring: binary_sensor.front_door_visitor, camera: camera.front_door_fluent }
on_ring: { show_on: [], wake_screens: true, close_after: 60s }
fully_kiosk:
  <deviceId>: { url: "http://192.168.1.50:2323", password: "..." }
```

A `binary_sensor` rings on its off→on edge, an `event.*` entity on every new state. Rings are debounced 10 s
per doorbell. Screens whose profile is in `show_on` (or all) get a `takeover`; Fully Kiosk screens get
`screenOn` + `toForeground`. A `takeover_end` follows after `close_after`.

## Live updates

Screens subscribe to data keys; the current value is sent at once, then changes. `agent:<pc>:sensors` is throttled per
screen to 1/s (1 per 10 s for `lite: true` profiles), always delivering the newest value.

## Develop

```bash
pnpm --filter @homepanel/server typecheck
pnpm --filter @homepanel/server test
```

## Docker

`apps/server/Dockerfile` builds protocol, ai, kiosk and server from the **repo root** context:

```bash
docker build -f apps/server/Dockerfile -t homepanel .
docker run -p 8080:8080 -v homepanel-data:/data -e HA_URL=... -e HA_TOKEN=... homepanel
```
