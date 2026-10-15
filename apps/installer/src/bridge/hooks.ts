/**
 * Progress hooks for the step runners (UI-CONTRACT.md: "step progress comes from small hooks added to
 * the step runners"). The runners call `hooks().step(...)` etc.; outside a UI run nothing is installed
 * and every call is a no-op, so the console wizard behaves exactly as before.
 *
 * The active hooks travel with the async context (AsyncLocalStorage), so deep helpers (poll loops,
 * waitForHa, downloads) can report progress without threading a parameter through every signature.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type StepState = "checking" | "pending" | "running" | "done" | "skipped" | "failed" | "manual";

export interface PlannedStep {
  id: string;
  title: string;
  summary?: string;
}

export interface RunHooks {
  /** the plan (sent again when it changes, e.g. after the HA "host" step picked a host type) */
  steps?(steps: PlannedStep[]): void;
  step?(id: string, state: StepState, detail?: string): void;
  progress?(p: { stepId?: string; label: string; pct?: number }): void;
  /** the steps are over: following log lines (summary) belong to no step */
  endSteps?(): void;
  /** AI guide transcript */
  ai?(role: "assistant" | "tool", text: string): void;
  /** next chat message from the user (AI guide in the window); replaces the terminal "you" prompt */
  chat?(): Promise<string>;
  /** start the run at this step: earlier steps are reported as skipped and not run */
  fromStep?: string;
}

const als = new AsyncLocalStorage<RunHooks>();
const NONE: RunHooks = {};

/** The hooks of the current run, or an empty object (console mode). */
export function hooks(): RunHooks {
  return als.getStore() ?? NONE;
}

export function withHooks<T>(h: RunHooks, fn: () => Promise<T>): Promise<T> {
  return als.run(h, fn);
}

/**
 * fromStep handling shared by the runners: true while `id` comes before `fromStep` in `ids`.
 * Unknown fromStep (not in this plan) → nothing is skipped.
 */
export function beforeFromStep(ids: string[], id: string, fromStep: string | undefined): boolean {
  if (!fromStep) return false;
  const target = ids.findIndex((x) => x === fromStep || x.endsWith(`.${fromStep}`));
  if (target < 0) return false;
  const i = ids.indexOf(id);
  return i >= 0 && i < target;
}
