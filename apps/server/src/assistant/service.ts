import type { AssistantReply, ChatMessage, ServerConfigFile } from "@homepanel/protocol";
import type { EnvConfig } from "../config.js";
import { SYSTEM, toolsFor, type AssistantDeps, type ToolDef } from "./tools.js";

export type { AssistantDeps, ToolDef } from "./tools.js";

/* Local mirror of the @homepanel/ai interface (CONTRACTS.md). The module is loaded lazily so the
   server runs (and typechecks) even when the package is not built. */
type ProviderId = "gemini" | "groq" | "openrouter" | "ollama" | "lmstudio" | "custom";
export interface ProviderConfig {
  provider: ProviderId;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}
interface AssistantLike {
  step(messages: ChatMessage[]): Promise<AssistantReply>;
  approve(callId: string): Promise<AssistantReply>;
  reject(callId: string): Promise<AssistantReply>;
}
interface AiModule {
  Assistant: new (opts: {
    provider: ProviderConfig;
    system: string;
    tools: ToolDef[];
    redact?: (s: string) => string;
  }) => AssistantLike;
}

const PROVIDERS: ProviderId[] = ["gemini", "groq", "openrouter", "ollama", "lmstudio", "custom"];

/** config.yaml `assistant` with env overrides (AI_PROVIDER / AI_API_KEY / AI_MODEL / AI_BASE_URL). */
export function resolveProviderConfig(cfg: ServerConfigFile, env: EnvConfig["ai"]): ProviderConfig | undefined {
  const provider = (env.provider || cfg.assistant.provider) as ProviderId | undefined;
  if (!provider || !PROVIDERS.includes(provider)) return undefined;
  const sameAsFile = !env.provider || env.provider === cfg.assistant.provider;
  const pick = (e?: string, f?: string) => e || (sameAsFile ? f : undefined);
  const out: ProviderConfig = { provider };
  const baseUrl = pick(env.baseUrl, cfg.assistant.baseUrl);
  const model = pick(env.model, cfg.assistant.model);
  const apiKey = pick(env.apiKey, cfg.assistant.apiKey);
  if (baseUrl) out.baseUrl = baseUrl;
  if (model) out.model = model;
  if (apiKey) out.apiKey = apiKey;
  return out;
}

let aiModulePromise: Promise<AiModule> | null = null;
/** Overridable in tests. */
export let loadAi = (): Promise<AiModule> => {
  const spec = "@homepanel/ai";
  aiModulePromise ??= (import(spec) as Promise<AiModule>).catch((e) => {
    aiModulePromise = null;
    throw e;
  });
  return aiModulePromise;
};
export function setAiLoader(fn: () => Promise<AiModule>) {
  loadAi = fn;
}

/** One Assistant per admin session. */
export class AssistantService {
  private sessions = new Map<string, { assistant: AssistantLike; providerKey: string; lastUsed: number }>();

  constructor(private deps: AssistantDeps) {}

  provider(): ProviderConfig | undefined {
    return resolveProviderConfig(this.deps.config.config, this.deps.env.ai);
  }

  private async get(session: string): Promise<AssistantLike | { error: string }> {
    const provider = this.provider();
    if (!provider) return { error: "no-provider" };
    const providerKey = JSON.stringify(provider);
    const existing = this.sessions.get(session);
    if (existing && existing.providerKey === providerKey) {
      existing.lastUsed = Date.now();
      return existing.assistant;
    }
    let mod: AiModule;
    try {
      mod = await loadAi();
    } catch {
      return { error: "assistant-unavailable" };
    }
    const secrets = [provider.apiKey, this.deps.env.haToken, this.deps.env.mqttPass, this.deps.env.adminPassword].filter(
      (s): s is string => !!s && s.length >= 6,
    );
    const redact = (s: string) => secrets.reduce((acc, sec) => acc.split(sec).join("***"), s);
    const assistant = new mod.Assistant({ provider, system: SYSTEM, tools: toolsFor(this.deps), redact });
    this.sessions.set(session, { assistant, providerKey, lastUsed: Date.now() });
    // drop idle sessions
    for (const [k, v] of this.sessions) if (Date.now() - v.lastUsed > 12 * 3_600_000) this.sessions.delete(k);
    return assistant;
  }

  async step(session: string, messages: ChatMessage[]): Promise<AssistantReply | { error: string }> {
    const a = await this.get(session);
    if ("error" in a && !("step" in a)) return a;
    return wrap(() => (a as AssistantLike).step(messages), messages);
  }

  async decide(session: string, callId: string, approve: boolean): Promise<AssistantReply | { error: string }> {
    const a = await this.get(session);
    if ("error" in a && !("step" in a)) return a;
    const as = a as AssistantLike;
    return wrap(() => (approve ? as.approve(callId) : as.reject(callId)), []);
  }
}

async function wrap(fn: () => Promise<AssistantReply>, messages: ChatMessage[]): Promise<AssistantReply> {
  try {
    return await fn();
  } catch (e) {
    return { messages, error: (e as Error).message || "assistant-error" };
  }
}
