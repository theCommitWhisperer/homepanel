/**
 * runSetup: run one setup mode (host / join / ha / move) for the setup window, reusing the console
 * flows unchanged through a WebPrompter + WebOut, with step hooks feeding the window's step list.
 */
import { PRESETS, testProvider, type ProviderConfig, type ProviderId } from "@homepanel/ai";
import { aiGuide } from "../ai-guide.js";
import { SERVER_PORT } from "../constants.js";
import { makeContext } from "../context.js";
import type { LocalCtx } from "../local/flow.js";
import { hostFlow, joinFlow, makeLocalCtx, moveFlow } from "../local/modes.js";
import { defaultOps, type WinOps } from "../local/ops.js";
import { offerMove } from "../main.js";
import { StateStore } from "../state.js";
import type { StepContext } from "../steps/types.js";
import type { Out, Prompter } from "../ui.js";
import { plainWizard } from "../wizard.js";
import type { AiChoice, EventSink, RunState, SetupMode, SummaryItem } from "./events.js";
import { withHooks, type RunHooks } from "./hooks.js";
import { WebPrompter, webOut, type AnswerResult, type StepCursor } from "./web.js";

export interface RunSetupOptions {
  mode: SetupMode;
  /** start at this step (e.g. "mqtt", "server", "host.agent") */
  fromStep?: string;
  ai?: AiChoice;
}

/** Overrides (tests and the `--fake` demo world). */
export interface SetupDeps {
  ops?: WinOps;
  /** context for host / join / move */
  localCtx?: (io: { out: Out; prompt: Prompter }) => LocalCtx;
  /** the Home Assistant wizard's state store (default ~/.homepanel) */
  haStore?: () => StateStore;
  /** context for the Home Assistant wizard */
  haCtx?: (io: { store: StateStore; out: Out; prompt: Prompter }) => StepContext;
  /** fetch for the AI provider */
  aiFetch?: typeof fetch;
  /** skip offering "Move" after the HA wizard (tests) */
  noOfferMove?: boolean;
}

export interface SetupResult {
  code: number;
  state: Exclude<RunState, "running">;
}

export interface SetupHandle {
  answer(questionId: string, value: unknown): AnswerResult;
  /** a chat message for the AI guide; false when this run has no AI guide */
  chat(text: string): boolean;
  cancel(): void;
  readonly waiting: string | undefined;
  readonly done: Promise<SetupResult>;
}

export const MODES: SetupMode[] = ["host", "join", "ha", "move"];

export function startSetup(opts: RunSetupOptions, outer: EventSink, deps: SetupDeps = {}): SetupHandle {
  const sink: EventSink = { emit: (e) => outer.emit({ ...e, ts: e.ts ?? Date.now() }) };
  const cursor: StepCursor = {};
  const prompt = new WebPrompter(sink, cursor);
  const out = webOut(sink, cursor);
  let cancelled = false;

  // AI chat: messages typed in the window, consumed by the guide loop
  const inbox: string[] = [];
  let waiter: ((t: string) => void) | undefined;
  let chatOpen = false;

  const hooks: RunHooks = {
    fromStep: opts.fromStep,
    steps: (steps) => sink.emit({ type: "steps", steps }),
    step: (id, state, detail) => {
      if (state === "checking" || state === "pending" || state === "running") cursor.current = id;
      sink.emit({ type: "step", id, state, ...(detail ? { detail } : {}) });
    },
    endSteps: () => {
      cursor.current = undefined;
    },
    progress: (p) => sink.emit({ type: "progress", ...p, ...(p.stepId || !cursor.current ? {} : { stepId: cursor.current }) }),
    ...(opts.ai
      ? {
          ai: (role, text) => sink.emit({ type: "ai", role, text }),
          chat: () =>
            new Promise<string>((resolve, reject) => {
              if (cancelled) return reject(Object.assign(new Error("stopped"), { name: "ExitPromptError" }));
              const t = inbox.shift();
              if (t !== undefined) return resolve(t);
              waiter = resolve;
              chatAbort = reject;
            }),
        }
      : {}),
  };
  let chatAbort: ((e: Error) => void) | undefined;

  const done = withHooks(hooks, async (): Promise<SetupResult> => {
    let code: number;
    try {
      code = await runMode(opts, { out, prompt, deps, setChatOpen: (v) => (chatOpen = v) });
    } catch (e) {
      const err = e as Error;
      if (err?.name === "ExitPromptError" || cancelled) {
        out.warn("Stopped. Progress is saved — run setup again to continue.");
        return { code: 130, state: "cancelled" };
      }
      out.err(`Setup stopped with an error: ${err?.message ?? err}`);
      return { code: 1, state: "failed" };
    }
    if (cancelled) return { code: 130, state: "cancelled" };
    try {
      const items = summaryFor(opts.mode, deps, out);
      if (items.length) sink.emit({ type: "summary", items });
    } catch {
      /* summary is best effort */
    }
    return { code, state: code === 0 ? "done" : "failed" };
  });

  return {
    answer: (id, value) => prompt.answer(id, value),
    chat(text) {
      if (!opts.ai || !chatOpen) return false;
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        chatAbort = undefined;
        w(text);
      } else inbox.push(text);
      return true;
    },
    cancel() {
      cancelled = true;
      prompt.cancel();
      chatAbort?.(Object.assign(new Error("stopped"), { name: "ExitPromptError" }));
    },
    get waiting() {
      return prompt.waiting;
    },
    done,
  };
}

/** The contract's entry point for the UI server: run a mode, resolve when it ends. */
export function runSetup(opts: RunSetupOptions, sink: EventSink, deps: SetupDeps = {}): Promise<SetupResult> {
  return startSetup(opts, sink, deps).done;
}

async function runMode(
  opts: RunSetupOptions,
  io: { out: Out; prompt: Prompter; deps: SetupDeps; setChatOpen(v: boolean): void },
): Promise<number> {
  const { out, prompt, deps } = io;
  const ops = deps.ops ?? defaultOps();
  const local = () => deps.localCtx?.({ out, prompt }) ?? makeLocalCtx({ out, prompt, yes: false, ops });
  switch (opts.mode) {
    case "host":
    case "join": {
      if (!deps.localCtx && ops.platform === "linux" && !(await ops.isElevated())) {
        out.err("On Linux this mode installs packages and systemd services: start HomePanel with sudo.");
        return 1;
      }
      const ctx = local();
      return opts.mode === "host" ? hostFlow(ctx) : joinFlow(ctx);
    }
    case "move":
      return moveFlow(local(), { haStore: deps.haStore?.() });
    case "ha": {
      const store = deps.haStore?.() ?? new StateStore();
      const ctx = deps.haCtx?.({ store, out, prompt }) ?? makeContext({ store, out, prompt });
      out.info(`Progress file: ${store.statePath}`);
      let code: number;
      const provider = opts.ai ? await aiProvider(ctx, opts.ai, deps.aiFetch) : undefined;
      if (provider) {
        io.setChatOpen(true);
        const r = await aiGuide(ctx, { provider, fetchImpl: deps.aiFetch });
        io.setChatOpen(false);
        if (r === "exit") return 0;
        code = await plainWizard(ctx);
      } else code = await plainWizard(ctx);
      if (code === 0 && !deps.noOfferMove)
        code = await offerMove({
          out,
          prompt,
          ops,
          yes: false,
          rest: ["--elevated"],
          haStore: store,
          ...(deps.localCtx ? { makeCtx: () => deps.localCtx!({ out, prompt }) } : {}),
        });
      return code;
    }
  }
}

/** ProviderConfig from the window's choice (saved key reused), tested once. undefined = plain wizard. */
async function aiProvider(ctx: StepContext, ai: AiChoice, fetchImpl?: typeof fetch): Promise<ProviderConfig | undefined> {
  const { out, store } = ctx;
  const id = ai.provider as ProviderId;
  const preset = PRESETS[id];
  if (!preset) {
    out.warn(`Unknown AI provider "${ai.provider}"; continuing with the plain wizard.`);
    return undefined;
  }
  const cfg: ProviderConfig = { provider: id, model: ai.model || store.state.ai?.model || preset.defaultModel };
  if (ai.baseUrl || id === "ollama" || id === "lmstudio") cfg.baseUrl = ai.baseUrl || store.state.ai?.baseUrl || preset.baseUrl;
  if (preset.needsKey) {
    const saved = store.state.ai?.provider === id ? store.secrets.extra?.ai_api_key : undefined;
    cfg.apiKey = ai.apiKey || saved;
    if (!cfg.apiKey) {
      out.warn(`${preset.label} needs an API key (free at ${preset.keyUrl}); continuing with the plain wizard.`);
      return undefined;
    }
    ctx.vault.add("ai_api_key", cfg.apiKey);
  }
  out.info(`Checking the AI provider (${preset.label})…`);
  const t = await testProvider(cfg, fetchImpl);
  if (!t.ok) {
    out.err(`${t.error ?? "provider test failed"} — continuing with the plain wizard.`);
    return undefined;
  }
  out.ok("AI guide connected. Chat in the panel; type 'wizard' to switch to the plain steps.");
  store.update({ ai: { provider: id, model: cfg.model, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}) } });
  if (cfg.apiKey) {
    store.secrets.extra = { ...(store.secrets.extra ?? {}), ai_api_key: cfg.apiKey };
    store.saveSecrets();
  }
  return cfg;
}

/** End screen: URLs and passwords, from the saved state (best effort). */
export function summaryFor(mode: SetupMode, deps: SetupDeps, out?: Out): SummaryItem[] {
  const items: SummaryItem[] = [];
  if (mode === "ha") {
    const store = deps.haStore?.() ?? new StateStore();
    const s = store.state;
    if (s.haUrl) items.push({ label: "Home Assistant", value: s.haUrl, href: s.haUrl });
    if (s.serverUrl) {
      items.push({ label: "HomePanel dashboard", value: s.serverUrl, href: s.serverUrl });
      items.push({ label: "HomePanel admin page", value: `${s.serverUrl}/admin`, href: `${s.serverUrl}/admin` });
    }
    if (store.secrets.adminPassword) items.push({ label: "Admin password", value: store.secrets.adminPassword, secret: true });
    if (s.mqtt) items.push({ label: "MQTT login", value: `${s.mqtt.username} @ ${s.mqtt.host}:${s.mqtt.port}` });
    if (store.secrets.mqttPassword) items.push({ label: "MQTT password", value: store.secrets.mqttPassword, secret: true });
    return items;
  }
  const quiet = { out: out ?? webOut({ emit: () => undefined }, {}), prompt: new WebPrompter({ emit: () => undefined }) };
  const ctx = deps.localCtx?.(quiet) ?? makeLocalCtx({ ...quiet, yes: false, ops: deps.ops });
  const store = ctx.store;
  const l = store.state.local ?? {};
  const sec = store.secrets;
  const ip = ctx.net().ip;
  if (mode === "host") {
    const local = `http://localhost:${SERVER_PORT}`;
    items.push({ label: "Dashboard on this PC", value: local, href: sec.deviceToken ? `${local}/?token=${encodeURIComponent(sec.deviceToken)}` : local });
    items.push({ label: "Admin page", value: `${local}/admin`, href: `${local}/admin` });
    if (sec.adminPassword) items.push({ label: "Admin password", value: sec.adminPassword, secret: true });
    if (ip) {
      items.push({ label: "Tablets and phones", value: `http://${ip}:${SERVER_PORT}` });
      items.push({ label: "Other PCs: download", value: `http://${ip}:${SERVER_PORT}/download/HomePanel.exe`, href: `http://${ip}:${SERVER_PORT}/download/HomePanel.exe` });
    }
    if (sec.mqttPassword) items.push({ label: "MQTT password (for other PCs)", value: sec.mqttPassword, secret: true });
  } else if (l.serverUrl) {
    items.push({ label: mode === "move" ? "Dashboard now" : "This PC reports to", value: l.serverUrl, href: l.serverUrl });
    items.push({ label: "Admin page", value: `${l.serverUrl}/admin`, href: `${l.serverUrl}/admin` });
    if (l.pcId) items.push({ label: "This PC's id", value: l.pcId });
  }
  return items;
}
