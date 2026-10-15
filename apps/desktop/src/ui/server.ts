/**
 * The HomePanel window's local server (UI-CONTRACT.md "Local UI server"):
 *
 *   - 127.0.0.1 only, random free port; Host must be exactly 127.0.0.1:<port> (no DNS rebinding),
 *     a foreign Origin is refused
 *   - every /api request needs header `x-hp-ui: <secret>` or cookie `hpui=<secret>`; the window is
 *     opened at http://127.0.0.1:<port>/#k=<secret> and the UI moves the secret into the cookie
 *   - POST /api/ui/show also accepts the handoff token from ui.secret (single-instance handoff)
 *   - static files: the desktop-ui build (index.html fallback for client routes)
 *   - Setup API (one run at a time, SSE with replay), system check (SSE or JSON), Control API
 *
 * Liveness: the window keeps an SSE stream open (/api/ui/live or /api/setup/events); `onIdle` fires
 * when the last one has been gone for `idleMs` and no setup run is active.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Control } from "./control.js";
import { safeEqual } from "./handoff.js";
import type {
  Check,
  PrecheckEnv,
  PrecheckResult,
  Recommendation,
  SetupDeps,
  SetupEvent,
  SetupHandle,
  SetupMode,
} from "../../../installer/src/ui-api.js";
import { MODES, runPrechecks, startSetup } from "../../../installer/src/ui-api.js";

export interface UiServerOptions {
  version: string;
  /** folder with the desktop-ui build (index.html); a built-in placeholder page when missing */
  staticDir?: string;
  secret?: string;
  /** token from ui.secret that may call POST /api/ui/show */
  handoffToken?: string;
  port?: number;
  control: Control;
  precheckEnv: () => PrecheckEnv;
  setupDeps: () => SetupDeps;
  /** is HomePanel installed on this PC (decides Setup vs Control)? */
  installed: () => Promise<boolean>;
  /** which modes make sense here */
  modeAvailability?: () => Promise<Partial<Record<SetupMode, { available: boolean; why?: string }>>>;
  /** POST /api/ui/show: open (or focus) the window */
  onShow?: (view?: string) => void;
  /** no live window and no run for `idleMs` */
  onIdle?: () => void;
  idleMs?: number;
  /** grace period after start before the first window must have connected */
  firstConnectMs?: number;
  /** label shown by the UI in demo mode */
  fake?: string;
  log?: (line: string) => void;
}

interface Run {
  id: string;
  mode: SetupMode;
  state: "running" | "done" | "failed" | "cancelled";
  history: SetupEvent[];
  handle: SetupHandle;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const MODE_INFO: Record<SetupMode, { title: string; summary: string }> = {
  host: { title: "Host HomePanel on this PC", summary: "Server + MQTT broker + this PC's temperatures and buttons, all here. Fastest real setup; Home Assistant can come later." },
  join: { title: "Join this PC to my HomePanel", summary: "Another computer or Home Assistant already runs HomePanel: add this PC's temperatures, drives and buttons." },
  ha: { title: "Set up Home Assistant", summary: "Home Assistant OS on a mini PC or Proxmox VM, onboarding, MQTT, the HomePanel app, Zigbee ZBT-1, doorbells." },
  move: { title: "Move the server to Home Assistant", summary: "This PC hosts HomePanel today: hand it over to the HomePanel app on Home Assistant, then retire the local server." },
};

export const PLACEHOLDER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>HomePanel</title>
<style>body{font:15px system-ui,sans-serif;background:#0b0c0d;color:#e8eae6;margin:40px}code{color:#c6f24e}</style></head>
<body><h1>HomePanel</h1><p>The window's user interface is not part of this build.</p>
<p>The local API is running: <code>/api/setup/precheck</code>, <code>/api/setup/modes</code>, <code>/api/control/status</code>.</p>
<p>Use <code>HomePanel setup --console</code> for the terminal setup.</p></body></html>`;

function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  return new Promise((resolveP, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolveP({});
      try {
        resolveP(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export class UiServer {
  readonly secret: string;
  private server?: Server;
  private port = 0;
  private live = new Set<ServerResponse>();
  private setupClients = new Set<ServerResponse>();
  private run?: Run;
  private runSeq = 0;
  private idleTimer?: NodeJS.Timeout;
  private everConnected = false;
  private lastRecommendation?: Recommendation;
  private closed = false;

  constructor(private readonly o: UiServerOptions) {
    this.secret = o.secret ?? randomBytes(24).toString("base64url");
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }
  /** what the window opens (the UI moves #k into the hpui cookie) */
  get openUrl(): string {
    return `${this.url}#k=${this.secret}`;
  }
  get listeningPort(): number {
    return this.port;
  }
  get runActive(): boolean {
    return this.run?.state === "running";
  }
  get liveConnections(): number {
    return this.live.size;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e: Error & { status?: number }) => {
        if (!res.headersSent) this.json(res, e.status ?? 500, { error: e.message });
        else res.end();
      });
    });
    this.server.keepAliveTimeout = 5000;
    await new Promise<void>((r, j) => {
      this.server!.once("error", j);
      this.server!.listen(this.o.port ?? 0, "127.0.0.1", () => r());
    });
    this.port = (this.server.address() as AddressInfo).port;
    if (this.o.onIdle) this.armIdle(this.o.firstConnectMs ?? 120_000);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.run?.handle.cancel();
    for (const r of [...this.live, ...this.setupClients]) r.end();
    await new Promise<void>((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
      this.server.closeAllConnections();
    });
  }

  /** Push an event to the window(s) (e.g. "show" after a second launch). */
  notify(e: Record<string, unknown>): void {
    for (const r of this.live) r.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  /* ---------------- plumbing ---------------- */

  private armIdle(ms: number) {
    clearTimeout(this.idleTimer);
    if (!this.o.onIdle || this.closed) return;
    this.idleTimer = setTimeout(() => {
      if (this.live.size === 0 && this.setupClients.size === 0 && !this.runActive) this.o.onIdle?.();
      else if (this.live.size === 0 && this.setupClients.size === 0) this.armIdle(this.o.idleMs ?? 30_000); // a run is still going
    }, ms);
    this.idleTimer.unref?.();
  }

  private connectionGone() {
    if (this.live.size === 0 && this.setupClients.size === 0) this.armIdle(this.o.idleMs ?? 30_000);
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(data) });
    res.end(data);
  }

  private sse(req: IncomingMessage, res: ServerResponse, set: Set<ServerResponse>) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": hello\n\n");
    set.add(res);
    this.everConnected = true;
    clearTimeout(this.idleTimer);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    ping.unref?.();
    const done = () => {
      clearInterval(ping);
      if (set.delete(res)) this.connectionGone();
    };
    req.on("close", done);
    res.on("close", done);
  }

  private allowedHost(req: IncomingMessage): boolean {
    return req.headers.host === `127.0.0.1:${this.port}`;
  }

  private allowedOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return !origin || origin === `http://127.0.0.1:${this.port}`;
  }

  private authed(req: IncomingMessage): boolean {
    const h = req.headers["x-hp-ui"];
    const v = (Array.isArray(h) ? h[0] : h) ?? cookie(req, "hpui");
    return !!v && safeEqual(v, this.secret);
  }

  private handoffOk(req: IncomingMessage): boolean {
    const h = req.headers["x-hp-handoff"];
    const v = Array.isArray(h) ? h[0] : h;
    return !!v && !!this.o.handoffToken && safeEqual(v, this.o.handoffToken);
  }

  /* ---------------- routes ---------------- */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowedHost(req)) return this.json(res, 421, { error: "wrong host" });
    if (!this.allowedOrigin(req)) return this.json(res, 403, { error: "wrong origin" });
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const p = url.pathname;
    const method = req.method ?? "GET";
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");

    if (!p.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") return this.json(res, 405, { error: "method not allowed" });
      return this.static(p, res);
    }

    if (p === "/api/ui/show" && method === "POST" && (this.handoffOk(req) || this.authed(req))) {
      const b = (await readBody(req, 4096)) as { view?: string };
      const view = typeof b.view === "string" ? b.view : undefined;
      if (this.live.size) this.notify({ type: "show", ...(view ? { view } : {}) });
      this.o.onShow?.(view);
      return this.json(res, 200, { ok: true, windows: this.live.size });
    }
    if (!this.authed(req)) return this.json(res, 401, { error: "missing or wrong x-hp-ui secret" });
    if (method !== "GET" && method !== "HEAD" && !/^application\/json\b/.test(req.headers["content-type"] ?? "application/json"))
      return this.json(res, 415, { error: "send JSON" });

    const body = method === "POST" || method === "PUT" ? await readBody(req) : undefined;
    const b = (body ?? {}) as Record<string, unknown>;

    /* ---- window ---- */
    if (p === "/api/ui/info" && method === "GET") {
      const installed = await this.o.installed();
      return this.json(res, 200, { version: this.o.version, installed, view: installed ? "control" : "setup", platform: process.platform, ...(this.o.fake ? { fake: this.o.fake } : {}) });
    }
    if (p === "/api/ui/live" && method === "GET") {
      this.sse(req, res, this.live);
      res.write(`data: ${JSON.stringify({ type: "hello", version: this.o.version })}\n\n`);
      return;
    }
    if (p === "/api/ui/quit" && method === "POST") {
      this.json(res, 200, { ok: true });
      if (!this.runActive) setTimeout(() => this.o.onIdle?.(), 200);
      return;
    }

    /* ---- setup ---- */
    if (p === "/api/setup/modes" && method === "GET") return this.json(res, 200, await this.modes());
    if (p === "/api/setup/precheck" && method === "GET") return this.precheck(req, res, url);
    if (p === "/api/setup/start" && method === "POST") return this.startRun(res, b);
    if (p === "/api/setup/events" && method === "GET") {
      this.sse(req, res, this.setupClients);
      for (const e of this.run?.history ?? []) res.write(`data: ${JSON.stringify(e)}\n\n`);
      return;
    }
    if (p === "/api/setup/answer" && method === "POST") {
      if (!this.run || this.run.state !== "running") return this.json(res, 409, { ok: false, error: "No setup is running." });
      if (typeof b.questionId !== "string") return this.json(res, 400, { ok: false, error: "questionId missing" });
      const r = this.run.handle.answer(b.questionId, b.value);
      return r.ok ? this.json(res, 200, { ok: true }) : this.json(res, r.status, { ok: false, error: r.error });
    }
    if (p === "/api/setup/cancel" && method === "POST") {
      if (!this.run || this.run.state !== "running") return this.json(res, 200, { ok: true, running: false });
      this.run.handle.cancel();
      return this.json(res, 200, { ok: true });
    }
    if (p === "/api/setup/ai/message" && method === "POST") {
      if (!this.run || this.run.state !== "running") return this.json(res, 409, { ok: false, error: "No setup is running." });
      const text = typeof b.text === "string" ? b.text.trim() : "";
      if (!text) return this.json(res, 400, { ok: false, error: "text missing" });
      return this.run.handle.chat(text.slice(0, 4000)) ? this.json(res, 200, { ok: true }) : this.json(res, 409, { ok: false, error: "The AI guide is not active in this run." });
    }

    /* ---- control ---- */
    const c = this.o.control;
    if (p === "/api/control/status" && method === "GET") return this.json(res, 200, await c.status());
    const act = /^\/api\/control\/([a-z-]+)\/(start|stop|restart|private)$/.exec(p);
    if (act && method === "POST") return this.json(res, 200, await c.act(act[1]!, act[2]!));
    const lg = /^\/api\/control\/logs\/([a-z-]+)$/.exec(p);
    if (lg && method === "GET") return this.json(res, 200, await c.logs(lg[1]!, Number(url.searchParams.get("lines") ?? 200)));
    if (p === "/api/control/agent-config" && method === "GET") return this.json(res, 200, c.getAgentConfig());
    if (p === "/api/control/agent-config" && method === "PUT") {
      if (typeof b.yaml !== "string") return this.json(res, 400, { ok: false, errors: ["yaml missing"] });
      const r = await c.putAgentConfig(b.yaml);
      return this.json(res, r.ok ? 200 : 422, r);
    }
    if (p === "/api/control/test-action" && method === "POST") {
      if (typeof b.id !== "string") return this.json(res, 400, { ok: false, error: "id missing" });
      return this.json(res, 200, await c.testAction(b.id, b.really === true));
    }
    if (p === "/api/control/open" && method === "POST") {
      if (typeof b.target !== "string" || !["dashboard", "admin", "logs-folder", "ha"].includes(b.target)) return this.json(res, 400, { ok: false, error: "target must be dashboard, admin, logs-folder or ha" });
      return this.json(res, 200, await c.open(b.target));
    }
    if (p === "/api/control/update-check" && method === "POST") return this.json(res, 200, await c.updateCheck());

    return this.json(res, 404, { error: "not found" });
  }

  private static_root(): string | undefined {
    const d = this.o.staticDir;
    return d && existsSync(join(d, "index.html")) ? resolve(d) : undefined;
  }

  private static(p: string, res: ServerResponse): void {
    const root = this.static_root();
    if (!root) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PLACEHOLDER_HTML);
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(p);
    } catch {
      return this.json(res, 400, { error: "bad path" });
    }
    let file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) return this.json(res, 403, { error: "forbidden" });
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      if (extname(rel)) return this.json(res, 404, { error: "not found" });
      file = join(root, "index.html"); // client-side routes
    }
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const data = readFileSync(file);
    const immutable = /[\\/]assets[\\/]/.test(file) && !file.endsWith("index.html");
    res.writeHead(200, {
      "content-type": type,
      "content-length": data.length,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
      ...(type.startsWith("text/html") ? { "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" } : {}),
    });
    res.end(data);
  }

  private async modes() {
    const installed = await this.o.installed();
    const avail: Partial<Record<SetupMode, { available: boolean; why?: string }>> = (await this.o.modeAvailability?.().catch(() => ({}))) ?? {};
    const rec = this.lastRecommendation;
    return {
      modes: MODES.map((id) => ({
        id,
        ...MODE_INFO[id],
        ...(rec?.mode === id ? { recommended: true } : {}),
        available: avail[id]?.available ?? true,
        ...(avail[id]?.why ? { why: avail[id]!.why } : {}),
      })),
      installed,
      version: this.o.version,
    };
  }

  private async precheck(req: IncomingMessage, res: ServerResponse, url: URL) {
    const wantsSse = /text\/event-stream/.test(req.headers.accept ?? "") || url.searchParams.get("stream") === "1";
    const env = this.o.precheckEnv();
    if (!wantsSse) {
      const r = await runPrechecks(env);
      this.lastRecommendation = r.recommendation;
      return this.json(res, 200, { checks: r.checks, recommendation: r.recommendation } satisfies PrecheckResult);
    }
    // one-shot SSE stream: {type:"check", check} … then {type:"done", checks, recommendation}; then it ends
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    let open = true;
    req.on("close", () => (open = false));
    const send = (e: unknown) => open && res.write(`data: ${JSON.stringify(e)}\n\n`);
    const r = await runPrechecks(env, (check: Check) => send({ type: "check", check }));
    this.lastRecommendation = r.recommendation;
    send({ type: "done", checks: r.checks, recommendation: r.recommendation });
    res.end();
  }

  private startRun(res: ServerResponse, b: Record<string, unknown>) {
    if (this.runActive) return this.json(res, 409, { error: "A setup is already running.", runId: this.run!.id });
    const mode = b.mode as SetupMode;
    if (!MODES.includes(mode)) return this.json(res, 400, { error: `mode must be one of ${MODES.join(", ")}` });
    const fromStep = typeof b.fromStep === "string" && /^[a-z0-9.-]{1,40}$/.test(b.fromStep) ? b.fromStep : undefined;
    const ai = b.ai && typeof b.ai === "object" && typeof (b.ai as { provider?: unknown }).provider === "string" ? (b.ai as { provider: string; apiKey?: string; model?: string; baseUrl?: string }) : undefined;
    const id = `run-${Date.now().toString(36)}-${++this.runSeq}`;
    const history: SetupEvent[] = [];
    const run = { id, mode, state: "running", history } as Run;
    const emit = (ev: SetupEvent) => {
      const e = { ...ev, ts: ev.ts ?? Date.now() } as SetupEvent;
      if (history.length < 20_000) history.push(e);
      const line = `data: ${JSON.stringify(e)}\n\n`;
      for (const r of this.setupClients) r.write(line);
    };
    this.run = run;
    emit({ type: "run", runId: id, mode, state: "running", ai: !!ai });
    this.o.log?.(`setup run ${id}: ${mode}${fromStep ? ` from ${fromStep}` : ""}${ai ? ` (AI: ${ai.provider})` : ""}`);
    run.handle = startSetup({ mode, ...(fromStep ? { fromStep } : {}), ...(ai ? { ai } : {}) }, { emit }, this.o.setupDeps());
    run.handle.done.then(
      (r) => {
        run.state = r.state;
        emit({ type: "run", runId: id, mode, state: r.state, ai: !!ai });
        this.o.log?.(`setup run ${id}: ${r.state} (code ${r.code})`);
        if (!this.live.size && !this.setupClients.size) this.armIdle(this.o.idleMs ?? 30_000);
      },
      (e: Error) => {
        run.state = "failed";
        emit({ type: "log", level: "err", text: `Setup crashed: ${e.message}` });
        emit({ type: "run", runId: id, mode, state: "failed", ai: !!ai });
      },
    );
    return this.json(res, 200, { runId: id });
  }
}

/** Where the desktop-ui build is: extracted from the exe, else the checkout's apps/desktop-ui/dist. */
export function findStaticDir(root: string): string | undefined {
  const c = join(root, "apps", "desktop-ui", "dist");
  return existsSync(join(c, "index.html")) ? c : undefined;
}
