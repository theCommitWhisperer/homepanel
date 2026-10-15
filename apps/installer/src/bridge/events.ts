/** Wire types of the setup window (UI-CONTRACT.md). */
import type { PlannedStep, StepState } from "./hooks.js";

export type LogLevel = "line" | "heading" | "info" | "ok" | "warn" | "err" | "code" | "steps";
export type RunState = "running" | "done" | "failed" | "cancelled";
export type SetupMode = "host" | "join" | "ha" | "move";

export interface SummaryItem {
  label: string;
  value: string;
  secret?: boolean;
  href?: string;
}

export type SetupEvent = SetupEventBody & {
  /** when it happened (ms since epoch); stamped by startSetup / the UI server */
  ts?: number;
};

export type SetupEventBody =
  | { type: "run"; runId: string; mode: string; state: RunState; ai: boolean }
  | { type: "steps"; steps: PlannedStep[] }
  | { type: "step"; id: string; state: StepState; detail?: string }
  | { type: "log"; level: LogLevel; text: string; items?: string[]; stepId?: string }
  | {
      type: "question";
      id: string;
      kind: "select" | "input" | "password" | "confirm";
      message: string;
      choices?: { value: string; name: string; description?: string }[];
      default?: string | boolean;
      stepId?: string;
    }
  | { type: "question_error"; id: string; error: string }
  | { type: "answered"; id: string }
  | { type: "progress"; stepId?: string; label: string; pct?: number }
  | { type: "ai"; role: "assistant" | "tool"; text: string }
  | { type: "summary"; items: SummaryItem[] };

/** Where the bridge sends events (the UI server's run: history + SSE fan-out). */
export interface EventSink {
  emit(e: SetupEvent): void;
}

/** AI guide settings from POST /api/setup/start. */
export interface AiChoice {
  provider: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}
