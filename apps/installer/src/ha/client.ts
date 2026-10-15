import WebSocket from "ws";

/** Thrown for any HA API failure; `status` is the HTTP status when there was one. */
export class HaError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: string,
  ) {
    super(message);
    this.name = "HaError";
  }
}

/** True when the text names a port explicitly (e.g. "1.2.3.4:80", "http://ha.local:8123/"). */
export function hasExplicitPort(input: string): boolean {
  const s = input.trim().replace(/^https?:\/\//i, "");
  const host = s.split("/")[0] ?? "";
  return /^\[.*\]:\d+$/.test(host) || /^[^:\[\]]+:\d+$/.test(host);
}

/**
 * Normalize a Home Assistant address: add http:// and, when no port is given, the classic :8123.
 * An explicit port is always kept — including :80, which newer Home Assistant OS versions use
 * (they answer on plain http://<ip>/), so "http://192.168.1.81:80" becomes "http://192.168.1.81".
 * Prefer resolveHaUrl() for typed input: it tries both ports.
 */
export function normalizeHaUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  const u = new URL(s);
  if (!u.port && u.protocol === "http:" && !hasExplicitPort(input)) u.port = "8123";
  return `${u.protocol}//${u.host}`;
}

/** Same address without guessing a port (used for saved, already-resolved URLs). */
export function cleanHaUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  const u = new URL(s);
  return `${u.protocol}//${u.host}`;
}

/** The same host on the other usual Home Assistant port (8123 <-> 80), or undefined. */
export function alternateHaUrl(url: string): string | undefined {
  const u = new URL(cleanHaUrl(url));
  if (u.protocol !== "http:") return undefined;
  if (u.port === "8123") return `http://${u.hostname.includes(":") ? `[${u.hostname}]` : u.hostname}`;
  if (u.port === "") return `http://${u.host}:8123`;
  return undefined;
}

/** Does a Home Assistant answer at this base URL? (/auth/providers: 200 once set up, 400 while onboarding.) */
export async function isHomeAssistant(url: string, fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = 4000): Promise<boolean> {
  try {
    const r = await fetchImpl(cleanHaUrl(url) + "/auth/providers", { signal: AbortSignal.timeout(timeoutMs) });
    if (r.status !== 200 && r.status !== 400) {
      // HA OS "Preparing Home Assistant" landing page: no API yet, but it is the right place
      const m = await fetchImpl(cleanHaUrl(url) + "/", { signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
      const text = m ? await m.text().catch(() => "") : "";
      return /Home Assistant/i.test(text);
    }
    const text = await r.text();
    return r.status === 200 ? text.trim().startsWith("[") || text.includes("providers") : /onboarding/i.test(text);
  } catch {
    return false;
  }
}

/**
 * Turn what someone typed (or an IP we found) into the URL Home Assistant really answers on.
 * Without a port it tries :8123 first, then plain http (port 80, newer HA OS). Falls back to the
 * :8123 form when nothing answers yet (e.g. still booting).
 */
export async function resolveHaUrl(input: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ url: string; reachable: boolean }> {
  const first = normalizeHaUrl(input);
  const candidates = hasExplicitPort(input) ? [first] : [first, alternateHaUrl(first)].filter((x): x is string => !!x);
  for (const c of candidates) if (await isHomeAssistant(c, fetchImpl)) return { url: c, reachable: true };
  return { url: first, reachable: false };
}

/** HA's own frontend uses the base URL with a trailing slash as OAuth client_id. */
export const clientIdFor = (haUrl: string) => `${haUrl.replace(/\/+$/, "")}/`;

export type OnboardingStatus =
  | { state: "unreachable"; error: string }
  /** HA OS first boot: the Supervisor's landing page answers while Core is still being downloaded/installed */
  | { state: "preparing" }
  | { state: "onboarding"; steps: { step: string; done: boolean }[] }
  | { state: "onboarded" };

export interface CoreLocation {
  location_name?: string;
  country?: string;
  time_zone?: string;
  unit_system?: "metric" | "us_customary";
  currency?: string;
  language?: string;
  latitude?: number;
  longitude?: number;
  elevation?: number;
}

export interface FlowResult {
  type: "form" | "create_entry" | "abort" | "external" | "external_done" | "progress" | "progress_done" | "menu";
  flow_id: string;
  handler: string;
  step_id?: string;
  reason?: string;
  errors?: Record<string, string> | null;
  data_schema?: { name: string; required?: boolean; type?: string; default?: unknown }[];
  menu_options?: string[] | Record<string, string>;
  title?: string;
  description_placeholders?: Record<string, string> | null;
}

export interface FlowInProgress {
  flow_id: string;
  handler: string;
  step_id?: string;
  context?: { source?: string; title_placeholders?: Record<string, string>; unique_id?: string };
}

interface SupervisorJob {
  name: string;
  done?: boolean;
  progress?: number;
  stage?: string | null;
  child_jobs?: SupervisorJob[];
}

/** REST + WebSocket client for the parts of the HA API the installer needs. */
export class HaClient {
  readonly url: string;
  token?: string;
  private fetchImpl: typeof fetch;

  constructor(url: string, opts: { token?: string; fetchImpl?: typeof fetch } = {}) {
    // saved URLs are already resolved (port included, or none = port 80): don't guess a port here
    this.url = hasExplicitPort(url) || /^https?:\/\//i.test(url.trim()) ? cleanHaUrl(url) : normalizeHaUrl(url);
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  get clientId() {
    return clientIdFor(this.url);
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean; form?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    let payload: string | undefined;
    if (body !== undefined) {
      if (opts.form) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        payload = new URLSearchParams(body as Record<string, string>).toString();
      } else {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
    }
    if (opts.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url + path, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      throw new HaError(`Cannot reach Home Assistant at ${this.url}: ${err.cause?.code ?? err.message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new HaError(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  /** Is HA up (any HTTP answer on /)? */
  async reachable(timeoutMs = 4000): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url + "/manifest.json", { signal: AbortSignal.timeout(timeoutMs) });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  /**
   * GET /api/onboarding (no auth). While onboarding it lists the steps; once onboarding is
   * finished the endpoint no longer exists (404) or needs auth (401).
   */
  async onboardingStatus(timeoutMs = 4000): Promise<OnboardingStatus> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url + "/api/onboarding", { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      return { state: "unreachable", error: err.cause?.code ?? err.message };
    }
    // 404/401: either onboarding is finished, or this is HA OS's "Preparing Home Assistant" landing page,
    // which answers 401 on every /api/ path while Core downloads. Core always answers /auth/providers with JSON.
    if (res.status === 404 || res.status === 401) return (await this.coreAnswers(timeoutMs)) ? { state: "onboarded" } : { state: "preparing" };
    if (!res.ok) return { state: "unreachable", error: `HTTP ${res.status}` };
    const steps = (await res.json().catch(() => [])) as { step: string; done: boolean }[];
    if (Array.isArray(steps) && steps.length && steps.every((s) => s.done)) return { state: "onboarded" };
    return { state: "onboarding", steps: Array.isArray(steps) ? steps : [] };
  }

  /** True when Home Assistant Core itself (not the HA OS landing page) answers: /auth/providers is JSON. */
  async coreAnswers(timeoutMs = 4000): Promise<boolean> {
    try {
      const r = await this.fetchImpl(this.url + "/auth/providers", { signal: AbortSignal.timeout(timeoutMs) });
      // 200 = list of providers; 400 {code: "onboarding_required"} before the owner exists
      if (r.status !== 200 && r.status !== 400) return false;
      const j = await r.json().catch(() => undefined);
      return j !== undefined && typeof j === "object";
    } catch {
      return false;
    }
  }

  /**
   * While HA OS prepares (first boot), its landing page exposes the Supervisor's job list. Returns a
   * short progress text such as "home_assistant_core_install 40%", or undefined.
   */
  async preparingProgress(): Promise<string | undefined> {
    try {
      const r = await this.fetchImpl(this.url + "/supervisor-api/jobs/info", { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return undefined;
      const j = (await r.json()) as { data?: { jobs?: SupervisorJob[] } };
      const flat: SupervisorJob[] = [];
      const walk = (list: SupervisorJob[] | undefined) => {
        for (const x of list ?? []) {
          flat.push(x);
          walk(x.child_jobs);
        }
      };
      walk(j.data?.jobs);
      const running = flat.filter((x) => !x.done);
      const job = running.reverse().find((x) => typeof x.progress === "number" && x.progress > 0) ?? running[0];
      if (!job) return undefined;
      return `${job.name}${job.stage ? ` (${job.stage})` : ""}${typeof job.progress === "number" && job.progress > 0 ? ` ${Math.round(job.progress)}%` : ""}`;
    } catch {
      return undefined;
    }
  }

  /* ---- onboarding (each call mirrors what HA's own onboarding page does) ---- */

  async onboardUser(u: { name: string; username: string; password: string; language?: string }): Promise<string> {
    const r = await this.request<{ auth_code: string }>(
      "POST",
      "/api/onboarding/users",
      { client_id: this.clientId, name: u.name, username: u.username, password: u.password, language: u.language ?? "en" },
      { auth: false },
    );
    if (!r?.auth_code) throw new HaError("Onboarding did not return an auth code");
    return r.auth_code;
  }

  async exchangeAuthCode(code: string): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const r = await this.request<{ access_token: string; refresh_token?: string; expires_in?: number }>(
      "POST",
      "/auth/token",
      { grant_type: "authorization_code", code, client_id: this.clientId },
      { auth: false, form: true },
    );
    if (!r?.access_token) throw new HaError("Token exchange did not return an access token");
    this.token = r.access_token;
    return r;
  }

  onboardCoreConfig() {
    return this.request("POST", "/api/onboarding/core_config", {});
  }
  onboardAnalytics() {
    return this.request("POST", "/api/onboarding/analytics", {});
  }
  onboardIntegration() {
    return this.request<{ auth_code: string }>("POST", "/api/onboarding/integration", {
      client_id: this.clientId,
      redirect_uri: `${this.url}/?auth_callback=1`,
    });
  }

  /* ---- config flows (REST) ---- */

  startFlow(handler: string, extra: Record<string, unknown> = {}) {
    return this.request<FlowResult>("POST", "/api/config/config_entries/flow", {
      handler,
      show_advanced_options: false,
      ...extra,
    });
  }
  continueFlow(flowId: string, input: Record<string, unknown>) {
    return this.request<FlowResult>("POST", `/api/config/config_entries/flow/${flowId}`, input);
  }
  abortFlow(flowId: string) {
    return this.request("DELETE", `/api/config/config_entries/flow/${flowId}`);
  }
  /** Discovered flows waiting for the user (e.g. Mosquitto via hassio, ZBT-1 via USB). */
  flowsInProgress() {
    return this.request<FlowInProgress[]>("GET", "/api/config/config_entries/flow");
  }

  async apiOk(): Promise<boolean> {
    try {
      const r = await this.request<{ message?: string }>("GET", "/api/");
      return !!r;
    } catch {
      return false;
    }
  }

  /* ---- websocket ---- */
  async ws(): Promise<HaSocket> {
    if (!this.token) throw new HaError("No Home Assistant token");
    return HaSocket.connect(this.url, this.token);
  }

  /** Run a function with a connected socket, always closing it. */
  async withWs<T>(fn: (s: HaSocket) => Promise<T>): Promise<T> {
    const s = await this.ws();
    try {
      return await fn(s);
    } finally {
      s.close();
    }
  }
}

export class HaSocket {
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  haVersion?: string;

  private constructor(private sock: WebSocket) {
    sock.on("message", (data) => {
      let msgs: any;
      try {
        msgs = JSON.parse(String(data));
      } catch {
        return;
      }
      for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
        if (m.type !== "result" || typeof m.id !== "number") continue;
        const w = this.waiting.get(m.id);
        if (!w) continue;
        this.waiting.delete(m.id);
        if (m.success) w.resolve(m.result);
        else w.reject(new HaError(m.error?.message ?? m.error?.code ?? "HA command failed", undefined, JSON.stringify(m.error)));
      }
    });
    sock.on("close", () => {
      for (const w of this.waiting.values()) w.reject(new HaError("Home Assistant WebSocket closed"));
      this.waiting.clear();
    });
  }

  static connect(haUrl: string, token: string, timeoutMs = 10_000): Promise<HaSocket> {
    const wsUrl = haUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/api/websocket";
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        sock.terminate();
        reject(new HaError(`Timed out connecting to ${wsUrl}`));
      }, timeoutMs);
      const fail = (e: Error) => {
        clearTimeout(timer);
        reject(e instanceof HaError ? e : new HaError(`WebSocket error: ${e.message}`));
      };
      sock.once("error", fail);
      const onMsg = (data: WebSocket.RawData) => {
        const m = JSON.parse(String(data));
        if (m.type === "auth_required") {
          sock.send(JSON.stringify({ type: "auth", access_token: token }));
        } else if (m.type === "auth_ok") {
          clearTimeout(timer);
          sock.off("message", onMsg);
          sock.off("error", fail);
          sock.on("error", () => undefined);
          const s = new HaSocket(sock);
          s.haVersion = m.ha_version;
          resolve(s);
        } else if (m.type === "auth_invalid") {
          clearTimeout(timer);
          sock.close();
          reject(new HaError(`Home Assistant rejected the token: ${m.message ?? "invalid"}`, 401));
        }
      };
      sock.on("message", onMsg);
    });
  }

  call<T = any>(type: string, data: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new HaError(`Timed out waiting for ${type}`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.sock.send(JSON.stringify({ id, type, ...data }));
    });
  }

  createLongLivedToken(clientName = "HomePanel", lifespanDays = 3650) {
    return this.call<string>("auth/long_lived_access_token", { client_name: clientName, lifespan: lifespanDays });
  }

  updateCoreConfig(cfg: CoreLocation) {
    const clean = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== ""));
    return this.call("config/core/update", clean);
  }

  /** Supervisor API passthrough (HA OS / Supervised only; admin user). */
  supervisor<T = any>(endpoint: string, method: "get" | "post" = "get", data?: unknown, timeoutSec: number | null = 60) {
    const body: Record<string, unknown> = { endpoint, method, timeout: timeoutSec };
    if (data !== undefined) body.data = data;
    return this.call<T>("supervisor/api", body, ((timeoutSec ?? 900) + 15) * 1000);
  }

  configEntries(domain?: string) {
    return this.call<{ entry_id: string; domain: string; title: string; state: string; source?: string }[]>(
      "config_entries/get",
      domain ? { domain } : {},
    );
  }

  listUsers() {
    return this.call<{ id: string; username: string | null; name: string; system_generated: boolean }[]>("config/auth/list");
  }

  async createLocalUser(name: string, username: string, password: string, groupIds = ["system-users"]) {
    const r = await this.call<{ user: { id: string } }>("config/auth/create", {
      name,
      group_ids: groupIds,
      local_only: true,
    });
    await this.call("config/auth_provider/homeassistant/create", {
      user_id: r.user.id,
      username,
      password,
    });
    return r.user.id;
  }

  async changeLocalUserPassword(userId: string, password: string) {
    return this.call("config/auth_provider/homeassistant/admin_change_password", { user_id: userId, password });
  }

  getStates() {
    return this.call<{ entity_id: string; state: string; attributes: Record<string, unknown> }[]>("get_states");
  }

  getConfig() {
    return this.call<Record<string, unknown> & { components?: string[]; version?: string }>("get_config");
  }

  close() {
    try {
      this.sock.close();
    } catch {
      /* ignore */
    }
  }
}
