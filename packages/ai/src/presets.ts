export type ProviderId = "gemini" | "groq" | "openrouter" | "ollama" | "lmstudio" | "custom";

export interface ProviderConfig {
  provider: ProviderId;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  needsKey: boolean;
  keyUrl?: string;
  notes: string;
}

/**
 * Free / local OpenAI-compatible providers. Model names change often; every field can be
 * overridden in ProviderConfig. Last checked: October 2026.
 */
export const PRESETS: Record<ProviderId, ProviderPreset> = {
  gemini: {
    id: "gemini",
    label: "Google Gemini (free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-3.8-flash",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
    notes:
      "Free tier with a Google account. On the free tier Google may use your prompts to improve its products — " +
      "don't paste anything private. Gemini model names change; if the default stops working, set a current one " +
      "(e.g. gemini-3.6-flash or gemini-3.5-flash-lite) as the model; list: https://ai.google.dev/gemini-api/docs/models",
  },
  groq: {
    id: "groq",
    label: "Groq (free tier)",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
    needsKey: true,
    keyUrl: "https://console.groq.com/keys",
    notes:
      "Very fast, free tier with per-minute and per-day limits. If the default model is unavailable try " +
      "llama-3.3-70b-versatile.",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter (free models)",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/free",
    needsKey: true,
    keyUrl: "https://openrouter.ai/keys",
    notes:
      "openrouter/free routes to a free model that supports tool calling. About 50 free requests per day " +
      "without credits. Free models may log prompts.",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen3:8b",
    needsKey: false,
    notes:
      "Runs on your own computer, nothing leaves your network. Use a PC with a GPU (e.g. the gaming PC), not the " +
      "N100 mini PC. Pull the model first: `ollama pull qwen3:8b`. To reach it from another machine set " +
      "OLLAMA_HOST=0.0.0.0 and use http://<pc-ip>:11434/v1.",
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "qwen3-8b",
    needsKey: false,
    notes:
      "Start the local server in LM Studio (Developer tab) and load a model that supports tool use. The model " +
      "name must match what LM Studio shows; the default is a guess.",
  },
  custom: {
    id: "custom",
    label: "Custom OpenAI-compatible endpoint",
    baseUrl: "",
    defaultModel: "",
    needsKey: false,
    notes: "Any server that speaks the OpenAI /chat/completions API with tool calling. Supply baseUrl, model and key.",
  },
};

export interface ResolvedProvider {
  id: ProviderId;
  label: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export function resolveProvider(p: ProviderConfig): ResolvedProvider {
  const preset = PRESETS[p.provider];
  if (!preset) throw new Error(`Unknown AI provider "${String(p.provider)}"`);
  const baseUrl = (p.baseUrl || preset.baseUrl).trim();
  const model = (p.model || preset.defaultModel).trim();
  if (!baseUrl) throw new Error(`Provider "${p.provider}" needs a baseUrl`);
  if (!model) throw new Error(`Provider "${p.provider}" needs a model name`);
  if (preset.needsKey && !p.apiKey) {
    throw new Error(`${preset.label} needs an API key — get one at ${preset.keyUrl ?? "the provider's website"}`);
  }
  return { id: p.provider, label: preset.label, baseUrl, model, apiKey: p.apiKey || undefined };
}

export function chatUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/chat/completions";
}
