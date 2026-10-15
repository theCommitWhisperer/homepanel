// Wire types from UI-CONTRACT.md (local UI server <-> desktop UI).

export type ModeId = "host" | "join" | "ha" | "move";
export type RecommendedMode = ModeId | "control" | "done";

/* ---------------- pre-checks ---------------- */
export type CheckState = "ok" | "warn" | "fail" | "info" | "running";
export interface CheckFix {
  label: string;
  mode?: ModeId;
  /** step to start the mode at (also accepted as `step`) */
  fromStep?: string;
  step?: string;
  action?: string;
  href?: string;
}
export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
  fix?: CheckFix;
  /** optional: "pc" | "ha" | "homepanel" | "sensors"; inferred from the id when absent */
  group?: string;
}
export interface Recommendation {
  mode: RecommendedMode;
  title: string;
  why: string;
  then?: string;
  fromStep?: string;
}

/* ---------------- setup ---------------- */
export interface ModeInfo {
  id: ModeId;
  title: string;
  summary: string;
  recommended?: boolean;
  available: boolean;
  why?: string;
}
export interface ModesResponse {
  modes: ModeInfo[];
  installed: boolean;
  version: string;
}

export type StepState = "checking" | "pending" | "running" | "done" | "skipped" | "failed" | "manual";
export type RunState = "running" | "done" | "failed" | "cancelled";
export type LogLevel = "line" | "heading" | "info" | "ok" | "warn" | "err" | "code" | "steps";
export interface Choice {
  value: string;
  name: string;
  description?: string;
}
export type QuestionKind = "select" | "input" | "password" | "confirm";
export interface Question {
  type: "question";
  id: string;
  kind: QuestionKind;
  message: string;
  choices?: Choice[];
  default?: string | boolean;
  stepId?: string;
}
export interface SummaryItem {
  label: string;
  value: string;
  secret?: boolean;
  href?: string;
}

export type SetupEvent =
  | { type: "run"; runId: string; mode: string; state: RunState }
  | { type: "steps"; steps: { id: string; title: string; summary?: string }[] }
  | { type: "step"; id: string; state: StepState; detail?: string }
  | { type: "log"; level: LogLevel; text: string; items?: string[]; stepId?: string }
  | Question
  | { type: "question_error"; id: string; error: string }
  | { type: "answered"; id: string }
  | { type: "progress"; stepId?: string; label: string; pct?: number }
  | { type: "ai"; role: "assistant" | "tool"; text: string }
  | { type: "summary"; items: SummaryItem[] };

export type AiProvider = "gemini" | "groq" | "openrouter" | "ollama";
export interface AiSettings {
  provider: AiProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/* ---------------- control ---------------- */
export type ItemId = "server" | "agent" | "sensors" | "mosquitto" | "tray" | "ha";
export type ItemState = "running" | "stopped" | "missing" | "error" | "unknown";
export interface StatusItem {
  id: ItemId | string;
  label: string;
  state: ItemState;
  detail?: string;
  canStart?: boolean;
  canStop?: boolean;
  canRestart?: boolean;
}
export interface Sensor {
  name: string;
  value: number;
  unit: string;
}
export interface ControlStatus {
  version: string;
  role: "host" | "agent" | "ha-client" | "none";
  pcId?: string;
  serverUrl?: string;
  dashboardUrl?: string;
  adminUrl?: string;
  items: StatusItem[];
  sensors?: { ok: boolean; count: number; top: Sensor[] };
  agentOnline?: boolean;
}
export interface AgentConfigResponse {
  path: string;
  yaml: string;
  actions: { id: string; label?: string; type: string; icon?: string; guard?: string }[];
}
export type SaveResult = { ok: true; restarted?: boolean; warning?: string } | { ok: false; errors: (string | { path?: string; message: string })[] };
export interface UpdateCheck {
  current: string;
  latest?: string;
  url?: string;
}

export interface UiInfo {
  version: string;
  installed: boolean;
  view: "setup" | "control";
  platform?: string;
  /** label for demo mode (fake system) */
  fake?: string;
}
