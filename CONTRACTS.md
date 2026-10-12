# HomePanel build contracts

Read this before writing code. `packages/protocol/src/index.ts` is the source of truth for all
messages, topics, schemas and REST routes. Do not change it without a very good reason; if you
must, keep changes additive and list them in your final report.

## Layout and ownership

| Path | Owner | What |
| --- | --- | --- |
| `packages/protocol` | lead | shared types + zod schemas (done) |
| `apps/server` | server agent | Fastify server: HA bridge, MQTT, pairing, profiles, takeover, camera proxy, media, admin API, AI assistant route, serves kiosk build, DEMO mode |
| `apps/kiosk` | kiosk agent | React + Vite PWA: pairing screen, widget grid, all built-in widgets, takeover overlay, `/admin` UI |
| `apps/agent` | agent agent | Node/TS PC agent (Windows first, Linux works): LibreHardwareMonitor sensors, drives, allowlisted actions, MQTT + HA discovery, Windows install script |
| `apps/installer` + `packages/ai` + `deploy/` + `docs/` | installer agent | `homepanel setup` CLI wizard, AI setup agent, HA onboarding automation, HA app (add-on) packaging, compose file, user guides |

Never edit files outside your paths. If you need something from another part, code against
the contract and note the assumption in your report.

## Tech rules

- Node 22, TypeScript strict, ESM (`"type": "module"`), pnpm workspace. Depend on the protocol
  with `"@homepanel/protocol": "workspace:*"`.
- Every package has `build`, `typecheck` and (where it makes sense) `test` scripts. Use vitest for tests.
- No native modules (no better-sqlite3 etc.); persist with JSON/YAML files under `DATA_DIR`.
- Use `yaml` (npm) for YAML, `zod` for validation, `mqtt` for MQTT.
- Ports: server 8080. Mosquitto 1883. HA 8123. LibreHardwareMonitor web server 8085.
- Don't run long-lived processes in the foreground without a timeout.

## @homepanel/ai interface (installer agent implements; server agent imports)

```ts
import type { ChatMessage, AssistantReply } from "@homepanel/protocol";

export type ProviderId = "gemini" | "groq" | "openrouter" | "ollama" | "lmstudio" | "custom";
export interface ProviderConfig { provider: ProviderId; baseUrl?: string; model?: string; apiKey?: string }
export interface ProviderPreset { id: ProviderId; label: string; baseUrl: string; defaultModel: string;
  needsKey: boolean; keyUrl?: string; notes: string }
export const PRESETS: Record<ProviderId, ProviderPreset>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;        // JSON Schema object
  kind: "look" | "act" | "build";            // act = needs user approval before run()
  summarize?(args: any): string;              // for act: exact human-readable description of the change
  run(args: any): Promise<unknown>;
}

export class Assistant {
  constructor(opts: { provider: ProviderConfig; system: string; tools: ToolDef[]; fetchImpl?: typeof fetch });
  /** Send the transcript; runs look/build tools automatically (bounded loop),
   *  stops and returns `pending` when the model calls an act tool. */
  step(messages: ChatMessage[]): Promise<AssistantReply>;
  approve(callId: string): Promise<AssistantReply>;
  reject(callId: string): Promise<AssistantReply>;
}
export function testProvider(p: ProviderConfig, fetchImpl?: typeof fetch): Promise<{ ok: boolean; error?: string }>;
```

Server route `/api/admin/assistant` creates one `Assistant` per admin session with tools:
`list_entities` (look), `list_agents` (look), `list_devices` (look), `get_profile` (look),
`draft_widget` (build: returns YAML snippet for a widget from a description, validated),
`save_profile` (act), `register_agent` (act), `add_doorbell` (act). If no provider is
configured, the route returns `{ error: "no-provider" }` and the UI shows setup instructions.

## DEMO mode

`DEMO=1 pnpm --filter @homepanel/server demo` must run with no HA, no MQTT: the server fakes
HA entities (3 lights, a Reolink-style doorbell + camera serving a generated snapshot, a weather
sensor) and one fake PC `gaming-pc` whose sensors wiggle realistically, with drives and
actions. Admin password in demo: `demo`. A demo device token `demo` is pre-paired to profile
`desk-monitor`. The kiosk must look complete in demo mode — it's how the user first sees it.
A ring can be triggered with `POST /api/demo/ring` (no auth in demo only).

## Example profiles (server ships these in `apps/server/data-example/profiles/`)

- `desk-monitor`: 12×8, dark — clock, pc-temps (gaming-pc), pc-drives, buttons (PC actions), lights, media gif.
- `kitchen-ipad`: 6×8 portrait-ish — clock, lights, entity weather, camera, buttons.
- `fire-hd8`: 4×6, `lite: true` — clock, lights, buttons.
