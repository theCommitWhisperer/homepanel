# v0.3 contract: windows for setup and control

Kevin's ask: "add a UI to the installers and HomePanel". Decisions (made, follow them):

- **No Electron/Tauri.** `HomePanel.exe` serves a local web UI on `127.0.0.1:<random port>` and opens it
  in an **app window**: `msedge.exe --app=<url> --window-size=1100,760` (Edge ships with Windows 11;
  fall back to Chrome `--app`, then the default browser). Same React + CSS stack as the kiosk.
- **One UI app** `apps/desktop-ui` (Vite + React, ES2020) with two areas: **Setup** and **Control**.
  Built into the exe as SEA assets next to the kiosk (served from the extracted app dir).
- **The existing installer flows are reused unchanged** through their interfaces: a web `Prompter`
  and a web `Out` bridge every `prompt.select/input/password/confirm` and every `out.*` line to the UI.
  Step progress comes from small hooks added to the step runners.
- **Tray:** `HomePanel.exe tray` runs the UI server and a hidden PowerShell `System.Windows.Forms.NotifyIcon`
  child (talks over stdin/stdout lines). Menu: Open HomePanel · Open dashboard · Restart agent ·
  Run setup · Quit tray. Registered as scheduled task `HomePanel Tray` (at logon, highest privileges,
  conhost --headless) by the host/join flows, so no UAC prompt on every open.
- **Double-click** `HomePanel.exe` (no args): if a tray instance is running → ask it to open the window
  (POST to its port from `%ProgramData%\HomePanel\ui.json`) and exit. Else: not installed → elevate
  (UAC) and open **Setup**; installed → elevate and open **Control**. The console window is hidden by
  relaunching detached with `windowsHide` (a brief flash is acceptable). `HomePanel.exe setup --console`
  keeps the old terminal wizard.

## Local UI server (apps/desktop/src/ui/server.ts) — owned by the backend builder

- Binds `127.0.0.1` only, random free port. Every request needs header `x-hp-ui: <secret>` or cookie
  `hpui=<secret>`; the opener URL is `http://127.0.0.1:<port>/#k=<secret>` and the UI moves the secret
  into a cookie on load. Origin/Host checked (no DNS rebinding: Host must be `127.0.0.1:<port>`).
- `%ProgramData%\HomePanel\ui.json` = `{ port, pid, secretHash }` written for single-instance handoff
  (`POST /api/ui/show` with the secret stored in a 0600 file next to it).
- Static: `/` → desktop-ui dist.

### Pre-checks (run automatically when the window opens; "make it simpler for the user")
- `GET /api/setup/precheck` (SSE or long-poll JSON; the UI shows checks ticking in as they finish, all within ~10 s)
  → `{ checks: Check[], recommendation: { mode: "host"|"join"|"ha"|"move"|"control"|"done", title, why, then?: string } }`
  `Check = { id, label, state: "ok"|"warn"|"fail"|"info"|"running", detail, fix?: { label, mode?, action?, href? } }`
  Checks (read-only, nothing changed): this PC (Windows version, admin rights, winget present, network
  interface + IP, firewall profile Private/Public); internet reachable; saved setup state (what's done);
  **Home Assistant**: found via mDNS/saved URL on :8123 *and* :80, version, onboarded?, token saved & still
  valid?, HA OS (apps available)?; **Mosquitto app** installed/running on HA (needs token) or local Mosquitto
  service; **HomePanel app** installed/running on HA and its `/api/health` on :8080; local HomePanel server
  task + health; this PC registered + agent task running + online on its server; LibreHardwareMonitor web
  server answering + sensor count; ZBT-1 seen by HA (ZHA) or USB present; Proxmox host on :8006 found on LAN.
  The recommendation picks the next sensible mode (e.g. HA found + onboarded, no HomePanel app, this PC is
  in Host mode → "Set up Home Assistant (continue at the HomePanel app step), then Move"). Each failed
  check carries a one-click `fix` (start that mode at the right step, open a URL, or run a safe action
  like starting a stopped task). The mode picker stays one click away ("Choose something else").
- `POST /api/setup/start` accepts `{ mode, fromStep?: string }` so a fix can jump straight to the step.

### Setup API
- `GET  /api/setup/modes` → `{ modes: [{id:"host"|"join"|"ha"|"move", title, summary, recommended?:bool, available:bool, why?:string}], installed: bool, version }`
- `POST /api/setup/start {mode, ai?: {provider, apiKey?, model?, baseUrl?}}` → `{ runId }` (one run at a time)
- `GET  /api/setup/events` (Server-Sent Events) → stream of `SetupEvent` (below); replays the current run's history on connect
- `POST /api/setup/answer {questionId, value}` → answers a pending question
- `POST /api/setup/cancel`
- `POST /api/setup/ai/message {text}` → user chat message to the AI guide when the run is in AI mode

```ts
type SetupEvent =
  | { type: "run"; runId: string; mode: string; state: "running" | "done" | "failed" | "cancelled" }
  | { type: "steps"; steps: { id: string; title: string; summary?: string }[] }            // the plan
  | { type: "step"; id: string; state: "checking" | "pending" | "running" | "done" | "skipped" | "failed" | "manual"; detail?: string }
  | { type: "log"; level: "line" | "heading" | "info" | "ok" | "warn" | "err" | "code" | "steps"; text: string; items?: string[]; stepId?: string }
  | { type: "question"; id: string; kind: "select" | "input" | "password" | "confirm"; message: string;
      choices?: { value: string; name: string; description?: string }[]; default?: string | boolean; stepId?: string }
  | { type: "question_error"; id: string; error: string }           // validate() failed; ask again
  | { type: "answered"; id: string }
  | { type: "progress"; stepId?: string; label: string; pct?: number }   // downloads, waits ("still preparing… 4 min")
  | { type: "ai"; role: "assistant" | "tool"; text: string }            // AI guide transcript
  | { type: "summary"; items: { label: string; value: string; secret?: boolean; href?: string }[] }  // end screen: URLs, passwords
```
Select choice values are strings on the wire (the bridge maps them back to the original values by index).
Password answers are never echoed in events or logs.

### Control API
- `GET  /api/control/status` →
  `{ version, role: "host"|"agent"|"ha-client"|"none", pcId?, serverUrl?, dashboardUrl?, adminUrl?,
     items: [{ id: "server"|"agent"|"sensors"|"mosquitto"|"tray"|"ha", label, state: "running"|"stopped"|"missing"|"error"|"unknown", detail?, canStart?, canStop?, canRestart? }],
     sensors?: { ok: bool, count: number, top: {name, value, unit}[] }, agentOnline?: bool }`
- `POST /api/control/:item/(start|stop|restart)` → `{ ok, error? }` (scheduled tasks / mosquitto service)
- `GET  /api/control/logs/:item?lines=200` → `{ lines: string[] }`
- `GET  /api/control/agent-config` → `{ path, yaml, actions: [{id,label,type,icon?,guard?,...}] }`
- `PUT  /api/control/agent-config {yaml}` → validates with the agent's own schema; `{ ok } | { ok:false, errors }`; on ok restarts the agent
- `POST /api/control/test-action {id, really?: bool}` → dry-run description or result
- `POST /api/control/open {target: "dashboard"|"admin"|"logs-folder"|"ha"}`
- `POST /api/control/update-check` → `{ current, latest?, url? }` (GitHub releases API of theCommitWhisperer/homepanel)

## Desktop UI (apps/desktop-ui) — owned by the frontend builder

Look and feel: same "instrument panel" family as the kiosk (near-black, one lime accent, crisp tabular
numerals) but a calmer desktop density; light theme follows the OS. System font stack, no CDNs.

- **Home / System check** (first screen): checks tick in live (grouped: This PC · Home Assistant ·
  HomePanel · Sensors), each with state icon, one-line detail and a Fix button when it has one; a
  prominent "Recommended next step" card with one big button; "Choose something else" link to the mode
  picker; "Check again" button.
- **Setup**: mode picker (cards, recommended badge) → optional "Use the AI guide" toggle with provider
  picker (Gemini / Groq / OpenRouter / Ollama, key field, privacy note) → run view: left rail of step
  cards with states, main pane shows the current step's log + the pending question rendered as a
  proper control (buttons for select ≤ 5 choices, list otherwise; text/password fields; Yes/No for
  confirm; `code` lines with a Copy button), progress bars, and an AI chat panel when in AI mode.
  Ends on a summary screen (URLs as buttons, passwords with reveal/copy). Failed step shows the fix text
  and Retry/Skip/Stop (these are just the installer's own select question).
- **Control**: header with role + version + "Open dashboard"; status tiles per item with Start/Stop/
  Restart; a live sensors strip; tabs: **Buttons** (visual editor for agent.yaml actions: list, add/edit
  form per type — open path, launch exe, keys, script, url, system — guard dropdown, icon; Save validates
  and restarts the agent; "Test" runs a dry run; an "Edit YAML" escape hatch), **Logs** (per item,
  auto-refresh), **Setup** (re-run any mode), **About** (version, update check, links).
- Dev: `apps/desktop-ui/dev/mock.mjs` mock of both APIs (scripted setup run incl. questions, failures,
  AI chat, summary; fake status) on port 8790, plus Playwright screenshots (chromium at /tmp/chromium or
  CHROMIUM_PATH) of every main screen at 1100×760, light and dark. Look at them and polish.

## Rules
TypeScript strict, vitest, `pnpm -r build && pnpm -r test` green (also with CI=true), don't edit outside
your paths, don't commit. The lead integrates, bumps to 0.3.0 and releases.
