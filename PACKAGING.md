# v0.2 contract: one Windows exe

Goal: Kevin downloads **HomePanel-Setup.exe** from GitHub Releases, double-clicks it, answers a few
questions, and ends up with a working system. No Node, pnpm or git needed on his PC.

## One exe, subcommands

`HomePanel.exe` is a Node single executable application (SEA) containing everything:

| Invocation | Does |
| --- | --- |
| `HomePanel.exe` (double-click, no args) | `setup` (the wizard), self-elevating to admin on Windows |
| `HomePanel.exe setup [...]` | installer wizard (apps/installer) |
| `HomePanel.exe server [...]` | HomePanel server (apps/server); kiosk assets come from the exe |
| `HomePanel.exe agent <cmd> [...]` | PC agent CLI (apps/agent): run, list-sensors, test-action, init, check-config |
| `HomePanel.exe --version` | prints version |

Release asset name: `HomePanel-Setup.exe` (the same binary; the installer copies itself to
`%ProgramFiles%\HomePanel\HomePanel.exe`, and scheduled tasks run that copy).

## Entry points (no side effects on import)

- `apps/server/src/main.ts` → `export async function main(argv: string[]): Promise<void>` (index.ts just calls it)
- `apps/agent/src/main.ts`  → `export async function main(argv: string[]): Promise<number>` (cli.ts just calls it)
- `apps/installer/src/main.ts` → `export async function main(argv: string[]): Promise<number>` (cli.ts just calls it)

The packaging owner refactors server and agent entries; the installer owner owns the installer one.

## Runtime helper (installer uses it to build scheduled-task commands)

`apps/installer/src/runtime.ts`:
```ts
export function isSea(): boolean;                       // require("node:sea").isSea(), false if unavailable
/** Command line that runs a HomePanel subcommand with the *installed* binary. */
export function selfCommand(installedExe: string | null, sub: "server" | "agent", args: string[]): { file: string; args: string[] };
```
In SEA mode `file` = installed exe path and args = [sub, ...args]. From a source checkout `file` =
process.execPath (node) and args = [<repo>/apps/server/dist/index.js | <repo>/apps/agent/dist/homepanel-agent.mjs, ...args].

## Assets inside the exe

The packaging owner embeds kiosk `dist/` and the agent's Windows scripts as SEA assets and, when
`HomePanel.exe server` starts, extracts them (once per version) to
`%ProgramData%\HomePanel\app\<version>\{kiosk,agent}` (Linux/mac: `~/.homepanel/app/<version>`) and sets
`KIOSK_DIST` / `AGENT_DIST` before calling the server's `main`. The server serves the running exe at
`GET /download/HomePanel.exe` (only when running as SEA) so other PCs on the LAN can grab it.

## Windows layout written by the installer

- `%ProgramFiles%\HomePanel\HomePanel.exe`
- `%ProgramData%\HomePanel\server\` (DATA_DIR, `.env` with secrets, ACL: Administrators + SYSTEM)
- `%ProgramData%\HomePanel\agent.yaml`
- `%ProgramData%\HomePanel\mosquitto\` (config + password file when the broker is local)
- Scheduled tasks: `HomePanel Server` (at startup, SYSTEM, restart on failure), `HomePanel Agent`
  (at logon, the user, highest privileges — needs the desktop), `HomePanel Sensors` (starts
  LibreHardwareMonitor minimized at logon, elevated).
- Firewall rules: TCP 8080 (server) and 1883 (MQTT, private profile only) inbound.

## Setup modes (installer)

1. **Host on this PC** — server + Mosquitto + this PC's agent, all local. Fastest real setup; HA can be
   connected later.
2. **Join this PC to my HomePanel** — find the server (mDNS / URL), admin login, register this PC,
   install LHM + agent.
3. **Set up Home Assistant / mini PC** — the existing HA flow (detect, onboard, MQTT, token, ZBT-1...),
   plus a Proxmox path that creates the HA OS VM over SSH (ssh2, root password in memory only).
4. **Move the server to Home Assistant** — for a PC that ran Host mode: register its agent with the HomePanel app on HA,
   copy layouts + config.yaml (admin API), retire the local server task, Mosquitto and firewall rules.

## Rules

Same as CONTRACTS.md: TypeScript strict, ESM source, tests with vitest, keep all suites passing,
don't edit outside your paths, don't commit. Never install anything or change system settings
without showing the exact action and getting a yes in interactive mode (`--yes` flag accepts all).
