import { chatUrl, resolveProvider, type ProviderConfig, type ResolvedProvider } from "./presets.js";

/* OpenAI chat-completions wire format (the subset we use). */
export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Some providers (Gemini) attach extra fields that must be echoed back unchanged. */
  [extra: string]: unknown;
}
export type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[]; [extra: string]: unknown }
  | { role: "tool"; tool_call_id: string; content: string; name?: string };

export interface WireTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: WireMessage[];
  tools?: WireTool[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  toolCalls: WireToolCall[];
  /** the assistant message as returned, normalised so it can be appended to the transcript */
  message: Extract<WireMessage, { role: "assistant" }>;
  provider: ResolvedProvider;
}

export type AiErrorKind = "rate-limit" | "auth" | "no-tools" | "network" | "bad-response" | "http" | "config";

export class AiError extends Error {
  constructor(
    public kind: AiErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
  /** Worth trying the next provider in a fallback chain? */
  get retryable(): boolean {
    return this.kind === "rate-limit" || this.kind === "network" || (this.kind === "http" && (this.status ?? 0) >= 500);
  }
}

const TIMEOUT_MS = 90_000;

function describeHttpError(p: ResolvedProvider, status: number, body: string): AiError {
  let detail = body;
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j?.error;
    detail = typeof e === "string" ? e : (e?.message ?? body);
  } catch {
    /* plain text */
  }
  detail = String(detail).slice(0, 300);
  if (status === 429) {
    return new AiError(
      "rate-limit",
      `${p.label} is rate-limiting us (429: free-tier limit reached). Wait a minute, or switch to another provider ` +
        `(Gemini, Groq, OpenRouter or a local Ollama). Details: ${detail}`,
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new AiError("auth", `${p.label} rejected the API key (${status}). Check the key. Details: ${detail}`, status);
  }
  if ((status === 400 || status === 404 || status === 422 || status === 501) && /tool|function/i.test(detail)) {
    return new AiError(
      "no-tools",
      `The model "${p.model}" on ${p.label} does not seem to support tool calling, which HomePanel needs. ` +
        `Pick a tool-capable model. Details: ${detail}`,
      status,
    );
  }
  if (status === 404) {
    return new AiError("http", `${p.label}: model "${p.model}" or endpoint not found (404). Details: ${detail}`, status);
  }
  return new AiError("http", `${p.label} returned HTTP ${status}. Details: ${detail}`, status);
}

let idCounter = 0;
const genId = () => `call_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

/** One chat-completions request. Throws AiError. */
export async function chatCompletion(
  provider: ProviderConfig,
  req: ChatRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ChatResult> {
  let p: ResolvedProvider;
  try {
    p = resolveProvider(provider);
  } catch (e) {
    throw new AiError("config", (e as Error).message);
  }
  const body: Record<string, unknown> = { model: p.model, messages: req.messages };
  if (req.tools && req.tools.length) {
    body.tools = req.tools;
    body.tool_choice = "auto";
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  if (p.id === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/theCommitWhisperer/homepanel";
    headers["X-Title"] = "HomePanel";
  }

  const signal = req.signal ?? AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(chatUrl(p.baseUrl), { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const code = err.cause?.code ? ` (${err.cause.code})` : "";
    const local = /localhost|127\.0\.0\.1/.test(p.baseUrl)
      ? " Is the local server running? For Ollama run `ollama serve`; for LM Studio start the server in the Developer tab."
      : " Check your internet connection or the base URL.";
    const msg = err.name === "TimeoutError" || err.name === "AbortError" ? "timed out" : `${err.message}${code}`;
    throw new AiError("network", `Could not reach ${p.label} at ${p.baseUrl}: ${msg}.${local}`);
  }
  const text = await res.text();
  if (!res.ok) throw describeHttpError(p, res.status, text);

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiError("bad-response", `${p.label} returned something that is not JSON: ${text.slice(0, 200)}`);
  }
  if (json?.error) {
    const m = typeof json.error === "string" ? json.error : json.error.message;
    throw describeHttpError(p, Number(json.error.code) || 500, JSON.stringify({ error: m }));
  }
  const raw = json?.choices?.[0]?.message;
  if (!raw) throw new AiError("bad-response", `${p.label} returned no message: ${text.slice(0, 200)}`);

  const toolCalls: WireToolCall[] = Array.isArray(raw.tool_calls)
    ? raw.tool_calls
        .filter((tc: any) => tc && tc.function && typeof tc.function.name === "string")
        .map((tc: any) => ({
          ...tc,
          id: tc.id || genId(),
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments ?? {}),
          },
        }))
    : [];
  const content = typeof raw.content === "string" ? raw.content : "";
  const message: Extract<WireMessage, { role: "assistant" }> = { role: "assistant", content: content || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { content, toolCalls, message, provider: p };
}

/**
 * Try providers in order; move to the next one on rate limits, network errors and 5xx.
 * Returns the result of the first that works, or throws the last error.
 */
export async function chatWithFallback(
  providers: ProviderConfig[],
  req: ChatRequest,
  fetchImpl?: typeof fetch,
): Promise<ChatResult> {
  if (!providers.length) throw new AiError("config", "No AI provider configured");
  let last: AiError | undefined;
  for (const p of providers) {
    try {
      return await chatCompletion(p, req, fetchImpl);
    } catch (e) {
      last = e instanceof AiError ? e : new AiError("network", String(e));
      if (!last.retryable) throw last;
    }
  }
  throw last!;
}

/** Quick connectivity + tool-support check. Never throws. */
export async function testProvider(
  p: ProviderConfig,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await chatCompletion(
      p,
      {
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        tools: [
          {
            type: "function",
            function: {
              name: "noop",
              description: "Does nothing. Do not call it.",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        signal: AbortSignal.timeout(45_000),
      },
      fetchImpl,
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
