/**
 * @homepanel/protocol — the shared contract between every part of HomePanel.
 *
 *   kiosk (screens) ⇄ server  : WebSocket at /ws, JSON messages (KioskToServer / ServerToKiosk)
 *   server ⇄ Home Assistant   : HA WebSocket API (server only; screens never see the HA token)
 *   server ⇄ PC agents        : MQTT, topics from `topics` below, commands HMAC-signed
 *   installer / server ⇄ AI   : @homepanel/ai (OpenAI-compatible chat + tools)
 *
 * Change this file deliberately: every app depends on it.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Data keys                                                            */
/* ------------------------------------------------------------------ */
/**
 * Widgets subscribe to string keys:
 *   ha:<entity_id>               value: HaEntityState
 *   agent:<pcId>:sensors         value: AgentSensorsPayload  (all sensors of that PC)
 *   agent:<pcId>:drives          value: AgentDrivesPayload
 *   agent:<pcId>:actions         value: AgentActionsPayload  (buttons the PC offers)
 *   agent:<pcId>:status          value: "online" | "offline"
 *   agents                       value: AgentSummary[]       (all known PCs)
 */
export type DataKey = string;

export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

/* ------------------------------------------------------------------ */
/* Actions: anything a button can do                                    */
/* ------------------------------------------------------------------ */
export const ActionRequestSchema = z.discriminatedUnion("kind", [
  /** Call any Home Assistant service, e.g. light.toggle */
  z.object({
    kind: z.literal("ha"),
    domain: z.string(),
    service: z.string(),
    data: z.record(z.unknown()).optional(),
  }),
  /** Run an allowlisted action id on a PC agent. The PC decides what the id does. */
  z.object({ kind: z.literal("agent"), pc: z.string(), action: z.string() }),
  /** Wake a sleeping PC (server sends the magic packet; agent is asleep) */
  z.object({ kind: z.literal("wol"), pc: z.string() }),
]);
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

/* ------------------------------------------------------------------ */
/* Kiosk <-> Server WebSocket (/ws)                                     */
/* ------------------------------------------------------------------ */
export type KioskToServer =
  | { type: "hello"; deviceToken: string }
  | { type: "subscribe"; keys: DataKey[] } // replaces previous subscription set
  | { type: "action"; id: string; action: ActionRequest; confirmed?: boolean }
  | { type: "ping" };

export type ServerToKiosk =
  | { type: "welcome"; device: DeviceInfo; profile: Profile }
  | { type: "unauthorized"; reason: string } // token unknown/revoked → kiosk returns to pairing
  | { type: "profile"; profile: Profile } // profile edited/reassigned → re-render
  | { type: "state"; key: DataKey; value: unknown; ts: number }
  | { type: "action_result"; id: string; ok: boolean; error?: string }
  | { type: "takeover"; takeover: Takeover }
  | { type: "takeover_end"; id: string }
  | { type: "pong" };

export interface DeviceInfo {
  id: string;
  name: string;
  profileId: string;
  remote?: boolean; // connected from outside the LAN (home-only actions refused)
}

/** Full-screen overlay pushed by the server (doorbell ring, alerts). */
export interface Takeover {
  id: string;
  kind: "doorbell" | "alert";
  title: string;
  /** camera entity; kiosk loads media through the server's camera proxy */
  camera?: string;
  /** relative URLs; kiosk appends ?t=<deviceToken> */
  streamUrl?: string; // MJPEG stream (lite profiles should use snapshotUrl instead)
  snapshotUrl?: string;
  message?: string;
  closeAfterMs: number;
  actions?: { label: string; action: ActionRequest }[];
}

/* ------------------------------------------------------------------ */
/* REST API (server)                                                    */
/* ------------------------------------------------------------------ */
/**
 * Device auth: header `Authorization: Bearer <deviceToken>` or query `?t=<deviceToken>`.
 * Admin auth:  header `Authorization: Bearer <adminSession>` from POST /api/admin/login.
 *
 * Pairing (no auth):
 *   POST /api/pair/start                         → PairStartResponse
 *   GET  /api/pair/status/:pairingId             → PairStatusResponse
 * Admin:
 *   POST /api/admin/login {password}             → {session}
 *   GET  /api/admin/pairings                     → PendingPairing[]
 *   POST /api/admin/pairings/:id/approve {name, profileId} → DeviceInfo
 *   POST /api/admin/pairings/:id/reject
 *   GET  /api/admin/devices                      → DeviceInfo[]
 *   PATCH /api/admin/devices/:id {name?, profileId?}
 *   DELETE /api/admin/devices/:id                (revoke)
 *   GET  /api/admin/profiles                     → {id, name, yaml}[]
 *   PUT  /api/admin/profiles/:id  (text/yaml body) → {ok} | {ok:false, errors:string[]}
 *   DELETE /api/admin/profiles/:id
 *   GET  /api/admin/agents                       → AgentSummary[]
 *   POST /api/admin/agents {pcId, name, mac?}    → {pcId, key}  (key goes into the PC's agent.yaml)
 *   DELETE /api/admin/agents/:pcId
 *   GET  /api/admin/entities                     → HaEntityState[]
 *   GET  /api/admin/config                       → ServerConfigFile (secrets redacted)
 *   PUT  /api/admin/config  (yaml)               → {ok} | {ok:false, errors}
 *   POST /api/admin/assistant {messages: ChatMessage[]} → AssistantReply   (AI setup assistant)
 *   POST /api/admin/assistant/approve {callId}   → AssistantReply           (run an approved Act tool)
 * Device:
 *   GET  /api/camera/:entity/snapshot            → image (proxied from HA)
 *   GET  /api/camera/:entity/stream              → MJPEG (proxied from HA)
 *   GET  /media/<path>                           → files from DATA_DIR/media
 *   GET  /api/media                              → string[] (paths under media/)
 * Health:
 *   GET  /api/health → {ok, ha: "connected"|"disconnected"|"demo", mqtt: ..., version}
 */
export interface PairStartResponse {
  pairingId: string;
  code: string; // 6 digits, shown big on the screen
  expiresAt: number;
}
export type PairStatusResponse =
  | { status: "pending" }
  | { status: "approved"; deviceToken: string; device: DeviceInfo }
  | { status: "rejected" | "expired" };
export interface PendingPairing {
  pairingId: string;
  code: string;
  userAgent: string;
  ip: string;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Profiles (one per kind of screen) — stored as YAML                   */
/* ------------------------------------------------------------------ */
export const WidgetPlacementSchema = z
  .object({
    id: z.string().optional(),
    type: z.string(),
    /** [col, row, width, height] in grid cells, 0-based */
    at: z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(1), z.number().int().min(1)]),
    title: z.string().optional(),
  })
  .passthrough(); // remaining keys = widget-specific config, validated by the widget's own schema

export const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  grid: z.object({ cols: z.number().int().min(1).max(24), rows: z.number().int().min(1).max(24) }),
  theme: z.enum(["dark", "light", "auto"]).default("dark"),
  /** lite = low-power screens (Fire HD 8): no animations, slower refresh, snapshots not video */
  lite: z.boolean().default(false),
  idle: z
    .object({ after: z.string().default("5m"), show: z.string().optional() /* widget id to show fullscreen */ })
    .optional(),
  widgets: z.array(WidgetPlacementSchema).default([]),
});
export type Profile = z.infer<typeof ProfileSchema>;
export type WidgetPlacement = z.infer<typeof WidgetPlacementSchema>;

/** Built-in widget types (kiosk implements these; config keys documented in apps/kiosk/src/widgets). */
export const BUILTIN_WIDGETS = [
  "clock",
  "pc-temps",
  "pc-drives",
  "buttons", // grid of action buttons: PC actions, HA services, WOL
  "lights",
  "entity", // generic entity card
  "camera",
  "media", // gif / image / slideshow from media folder or URL
  "text",
] as const;

/* ------------------------------------------------------------------ */
/* Server config file: DATA_DIR/config.yaml                             */
/* ------------------------------------------------------------------ */
export const DoorbellSchema = z.object({
  provider: z.enum(["reolink", "eufy", "generic"]).default("generic"),
  name: z.string().optional(),
  /** entity whose change means "ring": binary_sensor (→ on) or event.* (any new state) */
  ring: z.string(),
  camera: z.string(),
  snapshot: z.string().optional(), // image.* entity, optional
});
export const ServerConfigFileSchema = z.object({
  doorbells: z.record(DoorbellSchema).default({}),
  on_ring: z
    .object({
      show_on: z.array(z.string()).default([]), // profile ids; empty = all
      wake_screens: z.boolean().default(true),
      close_after: z.string().default("60s"),
    })
    .default({}),
  /** Fully Kiosk Browser REST endpoints used to wake Android screens: deviceId → {url, password} */
  fully_kiosk: z.record(z.object({ url: z.string(), password: z.string() })).default({}),
  assistant: z
    .object({
      provider: z.enum(["gemini", "groq", "openrouter", "ollama", "lmstudio", "custom"]).optional(),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
      apiKey: z.string().optional(),
    })
    .default({}),
});
export type ServerConfigFile = z.infer<typeof ServerConfigFileSchema>;

/* ------------------------------------------------------------------ */
/* PC agent <-> server over MQTT                                        */
/* ------------------------------------------------------------------ */
export const topics = {
  /** retained "online"/"offline" (offline set as MQTT last-will) */
  status: (pc: string) => `homepanel/agent/${pc}/status`,
  /** AgentSensorsPayload, every publishIntervalMs */
  sensors: (pc: string) => `homepanel/agent/${pc}/sensors`,
  /** AgentDrivesPayload, every 60 s, retained */
  drives: (pc: string) => `homepanel/agent/${pc}/drives`,
  /** AgentActionsPayload, retained, on start */
  actions: (pc: string) => `homepanel/agent/${pc}/actions`,
  /** server → agent: AgentCommand */
  cmd: (pc: string) => `homepanel/agent/${pc}/cmd`,
  /** agent → server: AgentCommandResult */
  cmdResult: (pc: string) => `homepanel/agent/${pc}/cmd_result`,
  /** wildcard the server subscribes to */
  all: "homepanel/agent/+/+",
  /** HA MQTT discovery prefix (agent publishes sensor configs here) */
  haDiscovery: (pc: string, objectId: string) => `homeassistant/sensor/homepanel_${pc}/${objectId}/config`,
} as const;

export type SensorKind = "temperature" | "load" | "fan" | "power" | "clock" | "data" | "other";
export interface AgentSensor {
  id: string; // stable slug, e.g. "cpu_package", "gpu_hotspot", "nvme0_temp"
  name: string; // human label, e.g. "CPU Package"
  kind: SensorKind;
  value: number;
  unit: string; // "°C", "%", "RPM", "W", "MHz", "GB"
  hardware?: string; // e.g. "AMD Ryzen 7 7800X3D"
}
export interface AgentSensorsPayload {
  ts: number;
  pc: string;
  hostname: string;
  sensors: AgentSensor[];
}
export interface AgentDrive {
  letter: string; // "C:" on Windows, mount point elsewhere
  label: string;
  totalGB: number;
  freeGB: number;
}
export interface AgentDrivesPayload {
  ts: number;
  pc: string;
  drives: AgentDrive[];
}
export type AgentActionType = "open" | "launch" | "keys" | "script" | "url" | "system";
export interface AgentActionInfo {
  id: string;
  label: string;
  type: AgentActionType;
  icon?: string; // emoji or icon name, cosmetic
  guard?: "confirm" | "home-only" | "confirm+home-only";
}
export interface AgentActionsPayload {
  pc: string;
  actions: AgentActionInfo[];
}
export interface AgentCommand {
  id: string; // unique per command
  action: string; // action id from the agent's allowlist
  ts: number; // ms epoch; agent rejects if |now - ts| > 10_000
  sig: string; // hex HMAC-SHA256(agentKey, signingString(cmd))
}
export interface AgentCommandResult {
  id: string;
  ok: boolean;
  error?: string;
}
export const signingString = (c: Pick<AgentCommand, "id" | "action" | "ts">) => `${c.id}.${c.action}.${c.ts}`;

export interface AgentSummary {
  pcId: string;
  name: string;
  status: "online" | "offline" | "never-seen";
  lastSeen?: number;
  hostname?: string;
  hasMac: boolean; // Wake-on-LAN possible
}

/* ------------------------------------------------------------------ */
/* AI assistant (shared by installer and server)                        */
/* ------------------------------------------------------------------ */
export type ChatMessage = { role: "user" | "assistant"; content: string };
export interface PendingApproval {
  callId: string;
  tool: string;
  summary: string; // human-readable: exactly what will change / run
}
export interface AssistantReply {
  messages: ChatMessage[]; // full updated transcript
  pending?: PendingApproval; // an Act tool waiting for the user's Approve tap
  error?: string;
}

export const VERSION = "0.1.0";
