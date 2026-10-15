import type { LogLevel, Question, RunState, SetupEvent, StepState, SummaryItem } from "./types";

export const INTRO = "__intro";

export interface LogEntry {
  n: number;
  level: LogLevel;
  text: string;
  items?: string[];
}
export interface StepView {
  id: string;
  title: string;
  summary?: string;
  state: StepState;
  detail?: string;
  startedAt?: number;
  endedAt?: number;
}
export interface Progress {
  label: string;
  pct?: number;
}
export interface PendingQuestion extends Question {
  error?: string;
  /** step the question belongs to (explicit or the current one) */
  at: string;
}

export interface SetupRunState {
  runId?: string;
  mode?: string;
  state?: RunState;
  steps: StepView[];
  /** stepId (or INTRO) -> log lines */
  logs: Record<string, LogEntry[]>;
  current: string;
  question?: PendingQuestion;
  progress: Record<string, Progress>;
  ai: { role: "assistant" | "tool" | "user"; text: string }[];
  summary?: SummaryItem[];
  seq: number;
}

export const emptyRun: SetupRunState = { steps: [], logs: {}, current: INTRO, progress: {}, ai: [], seq: 0 };

export type SetupAction =
  | { type: "reset" }
  | { type: "event"; event: SetupEvent; at?: number }
  | { type: "local-ai"; text: string };

const ACTIVE: StepState[] = ["checking", "running", "failed", "manual"];
const FINISHED: StepState[] = ["done", "skipped", "failed", "manual"];

/** Pure: fold one event into the run view. Replaying a run's history after `reset` rebuilds the same state. */
export function setupReducer(s: SetupRunState, a: SetupAction): SetupRunState {
  if (a.type === "reset") return emptyRun;
  if (a.type === "local-ai") return { ...s, ai: [...s.ai, { role: "user", text: a.text }] };
  const e = a.event;
  // events may carry the server's own timestamp (`ts`), which keeps durations right after a replay
  const at = typeof (e as { ts?: unknown }).ts === "number" ? (e as unknown as { ts: number }).ts : a.at ?? 0;
  switch (e.type) {
    case "run": {
      if (s.runId && s.runId !== e.runId) return { ...emptyRun, runId: e.runId, mode: e.mode, state: e.state };
      const ended = e.state !== "running";
      return { ...s, runId: e.runId, mode: e.mode, state: e.state, question: ended ? undefined : s.question, progress: ended ? {} : s.progress };
    }
    case "steps": {
      const old = new Map(s.steps.map((x) => [x.id, x]));
      return {
        ...s,
        steps: e.steps.map((x) => ({ id: x.id, title: x.title, summary: x.summary, state: old.get(x.id)?.state ?? "pending", detail: old.get(x.id)?.detail, startedAt: old.get(x.id)?.startedAt, endedAt: old.get(x.id)?.endedAt })),
      };
    }
    case "step": {
      let found = false;
      const steps = s.steps.map((x) => {
        if (x.id !== e.id) return x;
        found = true;
        const starting = (e.state === "checking" || e.state === "running") && !x.startedAt;
        return {
          ...x,
          state: e.state,
          detail: e.detail ?? x.detail,
          startedAt: starting ? at : e.state === "pending" ? undefined : x.startedAt,
          endedAt: FINISHED.includes(e.state) ? at : undefined,
        };
      });
      if (!found) steps.push({ id: e.id, title: e.id, state: e.state, detail: e.detail, startedAt: at });
      const progress = { ...s.progress };
      if (FINISHED.includes(e.state)) delete progress[e.id];
      return { ...s, steps, progress, current: ACTIVE.includes(e.state) || e.state === "done" || e.state === "skipped" ? e.id : s.current };
    }
    case "log": {
      const key = e.stepId ?? s.current;
      const entry: LogEntry = { n: s.seq, level: e.level, text: e.text, ...(e.items ? { items: e.items } : {}) };
      return { ...s, seq: s.seq + 1, logs: { ...s.logs, [key]: [...(s.logs[key] ?? []), entry] } };
    }
    case "question": {
      const { type: _t, ...q } = e;
      // a question for another step makes that step the one to show (some steps ask before their "running" event)
      return { ...s, current: e.stepId ?? s.current, question: { type: "question", ...q, at: e.stepId ?? s.current } };
    }
    case "question_error":
      return s.question && s.question.id === e.id ? { ...s, question: { ...s.question, error: e.error } } : s;
    case "answered":
      return s.question && s.question.id === e.id ? { ...s, question: undefined } : s;
    case "progress": {
      const key = e.stepId ?? s.current;
      return { ...s, progress: { ...s.progress, [key]: { label: e.label, pct: e.pct } } };
    }
    case "ai":
      return { ...s, ai: [...s.ai, { role: e.role, text: e.text }] };
    case "summary":
      return { ...s, summary: e.items };
    default:
      return s;
  }
}

export function replay(events: SetupEvent[]): SetupRunState {
  return events.reduce((st, ev) => setupReducer(st, { type: "event", event: ev }), emptyRun);
}

export function stepIndex(s: SetupRunState, id: string): number {
  return s.steps.findIndex((x) => x.id === id);
}

export function doneCount(s: SetupRunState): number {
  return s.steps.filter((x) => x.state === "done" || x.state === "skipped" || x.state === "manual").length;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return "<1 s";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  return `${m} min ${String(sec % 60).padStart(2, "0")} s`;
}

/** "1/13  LibreHardwareMonitor" headings repeat the step title the rail already shows. */
export function isStepHeading(text: string): boolean {
  return /^\d+\/\d+\s{1,}/.test(text);
}
