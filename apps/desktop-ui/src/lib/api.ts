import { authHeaders } from "./auth";
import type {
  UiInfo,
  AgentConfigResponse,
  AiSettings,
  ControlStatus,
  ModeId,
  ModesResponse,
  SaveResult,
  SetupEvent,
  UpdateCheck,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { ...authHeaders(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!r.ok) {
    // PUT agent-config answers 400 with { ok:false, errors } — that is a result, not a failure
    if (data && data.ok === false && Array.isArray(data.errors)) return data as T;
    const msg = (data && (data.error || data.message)) || text || r.statusText;
    throw new ApiError(r.status === 401 || r.status === 403 ? "This window lost its session. Close it and open HomePanel again." : String(msg), r.status);
  }
  return data as T;
}

export const api = {
  modes: () => call<ModesResponse>("GET", "/api/setup/modes"),
  start: (mode: ModeId, o: { ai?: AiSettings; fromStep?: string } = {}) =>
    call<{ runId: string }>("POST", "/api/setup/start", { mode, ...(o.ai ? { ai: o.ai } : {}), ...(o.fromStep ? { fromStep: o.fromStep } : {}) }),
  answer: (questionId: string, value: string | boolean) => call<{ ok?: boolean }>("POST", "/api/setup/answer", { questionId, value }),
  cancel: () => call<{ ok?: boolean }>("POST", "/api/setup/cancel", {}),
  aiMessage: (text: string) => call<{ ok?: boolean }>("POST", "/api/setup/ai/message", { text }),
  info: () => call<UiInfo>("GET", "/api/ui/info"),
  quit: () => call<{ ok?: boolean }>("POST", "/api/ui/quit", {}),

  status: () => call<ControlStatus>("GET", "/api/control/status"),
  itemAction: (item: string, verb: string) => call<{ ok: boolean; error?: string }>("POST", `/api/control/${encodeURIComponent(item)}/${verb}`, {}),
  logs: (item: string, lines = 200) => call<{ lines: string[] }>("GET", `/api/control/logs/${encodeURIComponent(item)}?lines=${lines}`),
  agentConfig: () => call<AgentConfigResponse>("GET", "/api/control/agent-config"),
  saveAgentConfig: (yaml: string) => call<SaveResult>("PUT", "/api/control/agent-config", { yaml }),
  testAction: (id: string, really = false) => call<Record<string, unknown>>("POST", "/api/control/test-action", { id, really }),
  open: (target: "dashboard" | "admin" | "logs-folder" | "ha") => call<{ ok?: boolean }>("POST", "/api/control/open", { target }),
  updateCheck: () => call<UpdateCheck>("POST", "/api/control/update-check", {}),
};

/** Text to show for a test-action response (shape is free-form on the wire). */
export function describeTestResult(r: Record<string, unknown>): { ok: boolean; text: string } {
  const ok = r.ok !== false && !r.error;
  const pick = (k: string) => (typeof r[k] === "string" && r[k] ? (r[k] as string) : undefined);
  let text = pick("describe") ?? pick("description") ?? pick("result") ?? pick("message") ?? pick("output") ?? pick("error") ?? "";
  if (Array.isArray(r.commands) && r.commands.length) text = (text ? text + "  →  " : "") + r.commands.join("  ·  ");
  return { ok, text: text || JSON.stringify(r) };
}

/* ---------------- streams ---------------- */

/**
 * Setup events over SSE. EventSource sends the hpui cookie (same origin); it reconnects by itself,
 * and the server replays the current run on every connect, so `onOpen` lets the caller reset first.
 */
export function subscribeSetup(onEvent: (e: SetupEvent) => void, onOpen: () => void, onError?: () => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    es = new EventSource("/api/setup/events", { withCredentials: true });
    es.onopen = () => onOpen();
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as SetupEvent);
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      onError?.();
      if (es && es.readyState === EventSource.CLOSED && !closed) {
        es = null;
        retry = setTimeout(connect, 2000);
      }
    };
  };
  connect();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    es?.close();
  };
}

/**
 * Window liveness: GET /api/ui/live stays open for the whole life of the window (the process exits
 * ~30 s after the last one closes). Reconnects with backoff; `{type:"show", view?}` asks the window to
 * come forward.
 */
export function subscribeLive(onEvent: (e: { type: string; view?: string; [k: string]: unknown }) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let delay = 500;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (closed) return;
    es = new EventSource("/api/ui/live", { withCredentials: true });
    es.onopen = () => (delay = 500);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      // EventSource retries by itself while CONNECTING; when it gives up, back off and try again
      if (es && es.readyState === EventSource.CLOSED) {
        es = null;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      }
    };
  };
  connect();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    es?.close();
  };
}

/**
 * Pre-checks: the server may answer with SSE (one JSON object per `data:` line) or plain JSON
 * (a snapshot; `done: false` means "ask again"). Every parsed object goes to `onData`.
 */
export async function streamPrecheck(onData: (d: unknown) => void, signal: AbortSignal): Promise<void> {
  for (let round = 0; round < 30 && !signal.aborted; round++) {
    const r = await fetch("/api/setup/precheck" + (round ? `?wait=1&round=${round}` : ""), {
      headers: { ...authHeaders(), accept: "text/event-stream, application/json" },
      credentials: "same-origin",
      signal,
    });
    if (!r.ok) throw new ApiError(r.status === 401 || r.status === 403 ? "This window lost its session. Close it and open HomePanel again." : `System check failed (${r.status})`, r.status);
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("text/event-stream") && r.body) {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          try {
            onData(JSON.parse(data));
          } catch {
            /* ignore */
          }
        }
      }
      onData({ type: "done" });
      return;
    }
    const snap = (await r.json()) as { done?: boolean };
    onData(snap);
    if (snap.done !== false) {
      onData({ type: "done" });
      return;
    }
    await new Promise((res) => setTimeout(res, 400));
  }
}
