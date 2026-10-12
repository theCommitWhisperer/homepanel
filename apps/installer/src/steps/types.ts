import type { HaClient } from "../ha/client.js";
import type { SecretVault, StateStore, StepStatus } from "../state.js";
import type { Exec } from "../sys.js";
import type { Out, Prompter } from "../ui.js";

export interface StepContext {
  store: StateStore;
  out: Out;
  prompt: Prompter;
  exec: Exec;
  fetchImpl: typeof fetch;
  vault: SecretVault;
  /** monorepo root if the installer runs from a checkout (needed for docs/ and deploy/) */
  repoRoot?: string;
  /** HA client for the saved URL + best token we have; throws if HA URL unknown */
  ha(): HaClient;
  /** ask for a secret with a hidden prompt (or reuse one the user gave via ask_secret) */
  secret(label: string, opts?: { confirm?: boolean; minLength?: number }): Promise<string>;
  /** true while the AI guide is running the step (prompts still go to the local terminal) */
  viaAi?: boolean;
  /** skip cosmetic waits (tests) */
  noWait?: boolean;
}

export interface DetectResult {
  done: boolean;
  detail: string;
}

export interface Step {
  id: string;
  title: string;
  /** one line: what this step does */
  summary: string;
  /** exact description of the changes, shown before running in AI mode (approval text) */
  plan(ctx: StepContext): string;
  /** longer explanation for explain_step / the plain wizard */
  explain: string;
  detect(ctx: StepContext): Promise<DetectResult>;
  run(ctx: StepContext): Promise<StepStatus>;
}
