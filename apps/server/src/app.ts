import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import YAML from "yaml";
import { VERSION, type ChatMessage, type HaEntityState } from "@homepanel/protocol";
import { AgentManager } from "./agents.js";
import { AssistantService } from "./assistant.js";
import { copyDirMissing, randomToken, safeEqual, safeJoin, writeFileAtomic } from "./util.js";
import { DATA_EXAMPLE_DIR, type EnvConfig } from "./config.js";
import { DemoAgentTransport } from "./demo/fakeAgents.js";
import { FakeHa } from "./demo/fakeHa.js";
import { prepareDemoDataDir, seedDemo } from "./demo/seed.js";
import { AdminSessions, DeviceStore } from "./devices.js";
import { HaClient } from "./ha/client.js";
import { NullHa } from "./ha/null.js";
import type { HaSource, HaStatus } from "./ha/types.js";
import { StateHub } from "./hub.js";
import { MqttTransport, NullTransport } from "./mqtt.js";
import { isRemoteIp, sendWol } from "./net.js";
import { ProfileStore } from "./profiles.js";
import { ServerConfigStore, redactConfig } from "./serverConfig.js";
import { TakeoverManager } from "./takeover.js";
import { KioskSession } from "./ws.js";

export interface AppOptions {
  env: EnvConfig;
  /** pino logger options or false (tests) */
  logger?: boolean | object;
  /** skip starting HA/MQTT connections (tests) */
  connect?: boolean;
  /** demo sensor publish interval */
  demoIntervalMs?: number;
}

export interface HomePanel {
  app: FastifyInstance;
  hub: StateHub;
  devices: DeviceStore;
  profiles: ProfileStore;
  agents: AgentManager;
  ha: HaSource;
  takeover: TakeoverManager;
  config: ServerConfigStore;
  sessions: Set<KioskSession>;
  adminPassword: string;
}

const MEDIA_EXT = /\.(gif|png|jpe?g|webp|svg|avif|mp4|webm|mov)$/i;

function listMedia(root: string, rel = ""): string[] {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listMedia(root, r));
    else if (MEDIA_EXT.test(e.name)) out.push(r);
  }
  return out.sort();
}

const NOT_BUILT_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HomePanel</title><style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:34rem;padding:2rem}code{background:#222;padding:.15rem .4rem;border-radius:4px}</style></head>
<body><main><h1>HomePanel server is running</h1><p>The kiosk web app isn't built yet, so there is nothing to show here.</p>
<p>Build it with <code>pnpm --filter @homepanel/kiosk build</code> (or set <code>KIOSK_DIST</code>) and restart the server.</p>
<p>API health: <a style="color:#8cf" href="/api/health">/api/health</a></p></main></body></html>`;

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  return undefined;
}
function queryToken(req: FastifyRequest): string | undefined {
  const q = req.query as Record<string, unknown> | undefined;
  return typeof q?.t === "string" ? q.t : undefined;
}

/** Load or create the admin password (env wins; otherwise DATA_DIR/admin-password.txt). */
function resolveAdminPassword(env: EnvConfig): { password: string; generated: boolean } {
  if (env.adminPassword) return { password: env.adminPassword, generated: false };
  const file = path.join(env.dataDir, "admin-password.txt");
  try {
    const p = fs.readFileSync(file, "utf8").trim();
    if (p) return { password: p, generated: false };
  } catch {
    /* create below */
  }
  const password = randomToken(9);
  writeFileAtomic(file, password + "\n", 0o600);
  return { password, generated: true };
}

export async function buildApp(opts: AppOptions): Promise<HomePanel> {
  const { env } = opts;
  const app = Fastify({
    logger:
      opts.logger === undefined
        ? { level: env.logLevel, transport: undefined, redact: ["req.headers.authorization", "req.query.t"] }
        : (opts.logger as any),
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: env.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });
  const log = app.log;

  /* ---------------- data dir ---------------- */
  if (env.demo) prepareDemoDataDir(env.dataDir);
  else {
    fs.mkdirSync(env.dataDir, { recursive: true });
    const empty = fs.readdirSync(env.dataDir).filter((f) => !f.startsWith(".")).length === 0;
    if (empty) {
      copyDirMissing(DATA_EXAMPLE_DIR, env.dataDir);
      log.info({ dataDir: env.dataDir }, "initialised data dir from data-example");
    }
  }
  fs.mkdirSync(path.join(env.dataDir, "media"), { recursive: true });
  const mediaDir = path.join(env.dataDir, "media");

  const hub = new StateHub();
  hub.setMaxListeners(0);
  const config = new ServerConfigStore(env.dataDir, log);
  const devices = new DeviceStore(env.dataDir);
  const profiles = new ProfileStore(env.dataDir, log);
  const agents = new AgentManager(env.dataDir, hub, (mac) => sendWol(mac, env.wolBroadcast));
  const admin = new AdminSessions();
  const { password: adminPassword, generated } = resolveAdminPassword(env);
  if (generated) log.warn({ file: path.join(env.dataDir, "admin-password.txt") }, `generated admin password: ${adminPassword}`);

  /* ---------------- Home Assistant ---------------- */
  let ha: HaSource;
  if (env.demo) ha = new FakeHa();
  else if (env.haUrl && env.haToken) ha = new HaClient(env.haUrl, env.haToken, log);
  else {
    log.warn("HA_URL/HA_TOKEN not set — Home Assistant disabled");
    ha = new NullHa();
  }

  const sessions = new Set<KioskSession>();
  const takeover = new TakeoverManager({
    getConfig: () => config.config,
    targets: () => sessions,
    deviceProfile: (id) => devices.get(id)?.profileId,
    log,
  });

  ha.on("state", (id: string, next: HaEntityState | null, prev: HaEntityState | null, meta?: { initial?: boolean }) => {
    if (next) hub.set(`ha:${id}`, next);
    else hub.delete(`ha:${id}`);
    if (!meta?.initial) takeover.onStateChange(id, next, prev);
  });
  if (env.demo) for (const s of ha.states()) hub.set(`ha:${s.entity_id}`, s);

  /* ---------------- MQTT / agents ---------------- */
  let demoAgents: DemoAgentTransport | null = null;
  if (env.demo) {
    seedDemo(devices, agents);
    demoAgents = new DemoAgentTransport(agents, opts.demoIntervalMs);
    agents.transport = demoAgents;
  } else if (env.mqttUrl && opts.connect !== false) {
    agents.transport = new MqttTransport(env.mqttUrl, { username: env.mqttUser, password: env.mqttPass }, agents, log);
  } else {
    if (!env.mqttUrl) log.warn("MQTT_URL not set — PC agents disabled");
    agents.transport = new NullTransport();
  }

  /* ---------------- profile/device changes → screens ---------------- */
  profiles.on("changed", (id: string) => {
    const p = profiles.get(id);
    if (!p) return;
    for (const s of sessions) if (s.profileId === id) s.pushProfile(p);
  });
  profiles.on("deleted", (id: string) => {
    for (const s of sessions) if (s.profileId === id) s.pushProfile(profiles.getOrFallback(id));
  });
  devices.on("changed", (d) => {
    for (const s of sessions) if (s.deviceId === d.id) s.refreshDevice(d);
  });
  devices.on("revoked", (id: string) => {
    for (const s of [...sessions]) if (s.deviceId === id) s.revoke();
  });

  const assistant = new AssistantService({ ha, agents, devices, profiles, config, env });

  /* ---------------- plugins ---------------- */
  await app.register(fastifyWebsocket, { options: { maxPayload: 256 * 1024 } });
  for (const ct of ["text/yaml", "application/yaml", "application/x-yaml", "text/plain", "text/x-yaml"]) {
    app.addContentTypeParser(ct, { parseAs: "string" }, (_req, body, done) => done(null, body));
  }

  /* ---------------- auth helpers ---------------- */
  const remoteOf = (req: FastifyRequest) => isRemoteIp(req.ip);
  const isAdmin = (req: FastifyRequest) => admin.valid(bearer(req)) || admin.valid(req.headers["x-admin-session"] as string);
  const deviceOf = (req: FastifyRequest) => devices.byToken(bearer(req) ?? queryToken(req));
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "admin-auth-required" });
  };
  const requireDeviceOrAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!deviceOf(req) && !isAdmin(req) && !admin.valid(queryToken(req))) return reply.code(401).send({ error: "auth-required" });
  };

  /* ---------------- health ---------------- */
  app.get("/api/health", async () => ({
    ok: true,
    ha: ha.status as HaStatus,
    mqtt: agents.transport?.status ?? "disabled",
    version: VERSION,
    demo: env.demo,
  }));

  /* ---------------- pairing ---------------- */
  app.post("/api/pair/start", async (req, reply) => {
    try {
      return devices.startPairing(String(req.headers["user-agent"] ?? ""), req.ip);
    } catch {
      return reply.code(429).send({ error: "too-many-pairings" });
    }
  });
  app.get<{ Params: { id: string } }>("/api/pair/status/:id", async (req, reply) => {
    const s = devices.pairingStatus(req.params.id);
    if (!s) return reply.code(404).send({ status: "expired" });
    return s;
  });

  /* ---------------- admin ---------------- */
  const failures = new Map<string, { n: number; until: number }>();
  app.post<{ Body: { password?: string } }>("/api/admin/login", async (req, reply) => {
    const f = failures.get(req.ip);
    if (f && f.n >= 5 && f.until > Date.now()) return reply.code(429).send({ error: "too-many-attempts" });
    const pw = typeof req.body?.password === "string" ? req.body.password : "";
    if (!pw || !safeEqual(pw, adminPassword)) {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: 0 };
      failures.set(req.ip, { n: cur.n + 1, until: Date.now() + 60_000 });
      log.warn({ ip: req.ip }, "admin login failed");
      return reply.code(401).send({ error: "wrong-password" });
    }
    failures.delete(req.ip);
    return { session: admin.create() };
  });

  await app.register(async (a) => {
    a.addHook("preHandler", requireAdmin);

    a.post("/api/admin/logout", async (req) => {
      const s = bearer(req);
      if (s) admin.revoke(s);
      return { ok: true };
    });

    a.get("/api/admin/pairings", async () => devices.pendingPairings());
    a.post<{ Params: { id: string }; Body: { name?: string; profileId?: string } }>(
      "/api/admin/pairings/:id/approve",
      async (req, reply) => {
        const name = (req.body?.name ?? "").toString().trim() || "Screen";
        const profileId = (req.body?.profileId ?? "").toString();
        if (!profiles.get(profileId)) return reply.code(400).send({ error: `unknown profile "${profileId}"` });
        const d = devices.approve(req.params.id, name.slice(0, 80), profileId);
        if (!d) return reply.code(404).send({ error: "pairing-not-found" });
        log.info({ device: d.name, profile: profileId }, "screen paired");
        return d;
      },
    );
    a.post<{ Params: { id: string } }>("/api/admin/pairings/:id/reject", async (req, reply) => {
      if (!devices.reject(req.params.id)) return reply.code(404).send({ error: "pairing-not-found" });
      return { ok: true };
    });

    a.get("/api/admin/devices", async () => {
      const online = new Set([...sessions].map((s) => s.deviceId));
      return devices.list().map((d) => {
        const s = devices.get(d.id);
        return { ...d, online: online.has(d.id), ...(s?.lastSeen ? { lastSeen: s.lastSeen } : {}) };
      });
    });
    a.patch<{ Params: { id: string }; Body: { name?: string; profileId?: string } }>("/api/admin/devices/:id", async (req, reply) => {
      const b = req.body ?? {};
      if (b.profileId !== undefined && !profiles.get(b.profileId)) return reply.code(400).send({ error: `unknown profile "${b.profileId}"` });
      const d = devices.update(req.params.id, {
        ...(typeof b.name === "string" && b.name.trim() ? { name: b.name.trim().slice(0, 80) } : {}),
        ...(typeof b.profileId === "string" ? { profileId: b.profileId } : {}),
      });
      if (!d) return reply.code(404).send({ error: "device-not-found" });
      return { id: d.id, name: d.name, profileId: d.profileId };
    });
    a.delete<{ Params: { id: string } }>("/api/admin/devices/:id", async (req, reply) => {
      if (!devices.remove(req.params.id)) return reply.code(404).send({ error: "device-not-found" });
      return { ok: true };
    });

    a.get("/api/admin/profiles", async () => profiles.list().map((p) => ({ id: p.id, name: p.name, yaml: p.yaml })));
    a.put<{ Params: { id: string }; Body: unknown }>("/api/admin/profiles/:id", async (req, reply) => {
      const body = req.body;
      const text =
        typeof body === "string" ? body : body && typeof body === "object" && typeof (body as any).yaml === "string" ? (body as any).yaml : null;
      if (text === null) return reply.code(400).send({ ok: false, errors: ["send the profile as a text/yaml body"] });
      const r = profiles.put(req.params.id, text);
      if (!r.ok) return reply.code(400).send(r);
      return { ok: true };
    });
    a.delete<{ Params: { id: string } }>("/api/admin/profiles/:id", async (req, reply) => {
      const users = devices.list().filter((d) => d.profileId === req.params.id);
      if (users.length) {
        return reply.code(409).send({ ok: false, errors: [`in use by: ${users.map((u) => u.name).join(", ")}`] });
      }
      if (!profiles.delete(req.params.id)) return reply.code(404).send({ ok: false, errors: ["not found"] });
      return { ok: true };
    });

    a.get("/api/admin/agents", async () => agents.summaries());
    a.post<{ Body: { pcId?: string; name?: string; mac?: string } }>("/api/admin/agents", async (req, reply) => {
      const b = req.body ?? {};
      if (typeof b.pcId !== "string" || !b.pcId) return reply.code(400).send({ error: "pcId required" });
      try {
        return agents.register(b.pcId, (b.name || b.pcId).toString(), b.mac || undefined);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    a.delete<{ Params: { pcId: string } }>("/api/admin/agents/:pcId", async (req, reply) => {
      if (!agents.unregister(req.params.pcId)) return reply.code(404).send({ error: "agent-not-found" });
      return { ok: true };
    });

    a.get("/api/admin/entities", async () => ha.states());

    a.get<{ Querystring: { format?: string } }>("/api/admin/config", async (req, reply) => {
      if (req.query.format === "yaml") {
        const doc = YAML.parseDocument(config.text || "");
        if (doc.hasIn(["assistant", "apiKey"])) doc.setIn(["assistant", "apiKey"], "***");
        for (const k of Object.keys(config.config.fully_kiosk)) {
          if (doc.hasIn(["fully_kiosk", k, "password"])) doc.setIn(["fully_kiosk", k, "password"], "***");
        }
        return reply.type("text/yaml; charset=utf-8").send(config.text ? doc.toString() : "");
      }
      return redactConfig(config.config);
    });
    a.put<{ Body: unknown }>("/api/admin/config", async (req, reply) => {
      const body = req.body;
      const text =
        typeof body === "string" ? body : body && typeof body === "object" && typeof (body as any).yaml === "string" ? (body as any).yaml : null;
      if (text === null) return reply.code(400).send({ ok: false, errors: ["send config.yaml as a text/yaml body"] });
      const r = config.put(text);
      if (!r.ok) return reply.code(400).send(r);
      return { ok: true };
    });

    /** Fire a doorbell takeover without pressing the button (admin "Test" button). */
    a.post<{ Params: { name: string } }>("/api/admin/doorbells/:name/test", async (req, reply) => {
      takeover.clearDebounce(req.params.name);
      const t = takeover.ring(req.params.name);
      if (!t) return reply.code(404).send({ error: "doorbell-not-found" });
      return { ok: true, takeover: t };
    });

    a.post<{ Body: { messages?: ChatMessage[] } }>("/api/admin/assistant", async (req, reply) => {
      const msgs = Array.isArray(req.body?.messages) ? req.body!.messages! : [];
      const clean = msgs
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
      const r = await assistant.step(bearer(req) ?? "", clean);
      if ("error" in r && !("messages" in r)) return reply.send(r);
      return r;
    });
    a.post<{ Body: { callId?: string; approve?: boolean } }>("/api/admin/assistant/approve", async (req) => {
      return assistant.decide(bearer(req) ?? "", String(req.body?.callId ?? ""), req.body?.approve !== false);
    });
    a.post<{ Body: { callId?: string } }>("/api/admin/assistant/reject", async (req) => {
      return assistant.decide(bearer(req) ?? "", String(req.body?.callId ?? ""), false);
    });
  });

  /* ---------------- camera proxy ---------------- */
  const cameraRoute = (kind: "snapshot" | "stream") => async (req: FastifyRequest<{ Params: { entity: string } }>, reply: FastifyReply) => {
    const entity = req.params.entity;
    if (!/^(camera|image)\.[a-z0-9_]+$/.test(entity)) return reply.code(400).send({ error: "bad-entity" });
    const ac = new AbortController();
    req.raw.on("close", () => ac.abort());
    try {
      const r = await ha.camera(entity, kind, ac.signal);
      reply.raw.on("close", () => {
        r.close?.();
        ac.abort();
      });
      reply
        .code(r.status)
        .header("content-type", r.contentType)
        .header("cache-control", "no-store, no-cache, must-revalidate")
        .header("x-accel-buffering", "no");
      return reply.send(r.body);
    } catch (e) {
      if (ac.signal.aborted) return reply;
      log.warn({ entity, err: (e as Error).message }, "camera proxy failed");
      return reply.code(502).send({ error: "camera-unavailable" });
    }
  };
  app.get<{ Params: { entity: string } }>("/api/camera/:entity/snapshot", { preHandler: requireDeviceOrAdmin }, cameraRoute("snapshot"));
  app.get<{ Params: { entity: string } }>("/api/camera/:entity/stream", { preHandler: requireDeviceOrAdmin }, cameraRoute("stream"));

  /* ---------------- media ---------------- */
  // LAN screens may load media without a token (e.g. a plain <img>); remote requests need one.
  const mediaAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (remoteOf(req)) return requireDeviceOrAdmin(req, reply);
  };
  app.get("/api/media", { preHandler: mediaAuth }, async () => listMedia(mediaDir));
  await app.register(async (m) => {
    m.addHook("onRequest", mediaAuth);
    await m.register(fastifyStatic, {
      root: mediaDir,
      prefix: "/media/",
      decorateReply: false,
      index: false,
      dotfiles: "deny",
      maxAge: "1h",
    });
  });

  /* ---------------- demo ---------------- */
  if (env.demo) {
    app.post<{ Body: { doorbell?: string } }>("/api/demo/ring", async (req) => {
      const which = req.body?.doorbell === "side" ? "side" : "front";
      takeover.clearDebounce(which);
      (ha as FakeHa).ring(which);
      return { ok: true, doorbell: which };
    });
  }

  /* ---------------- WebSocket ---------------- */
  app.get("/ws", { websocket: true }, (socket, req) => {
    new KioskSession(socket, remoteOf(req), { hub, devices, profiles, agents, ha, log }, sessions);
  });

  /* ---------------- kiosk SPA ---------------- */
  const kioskIndex = path.join(env.kioskDist, "index.html");
  if (fs.existsSync(kioskIndex)) {
    await app.register(fastifyStatic, {
      root: env.kioskDist,
      prefix: "/",
      wildcard: false,
      index: false,
      setHeaders(res, file) {
        if (/[\\/]assets[\\/]/.test(file)) res.setHeader("cache-control", "public, max-age=31536000, immutable");
        else res.setHeader("cache-control", "no-cache");
      },
    });
  } else {
    log.warn({ kioskDist: env.kioskDist }, "kiosk build not found — serving placeholder page");
  }
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split("?")[0]!;
    const isApi = url.startsWith("/api/") || url === "/api" || url.startsWith("/media/") || url === "/ws";
    if (req.method !== "GET" && req.method !== "HEAD") return reply.code(404).send({ error: "not-found" });
    if (isApi) return reply.code(404).send({ error: "not-found" });
    // a missing file with an extension (e.g. /favicon.png) is a real 404, not an SPA route
    if (/\.[a-z0-9]{2,5}$/i.test(url) && !url.endsWith(".html")) return reply.code(404).send({ error: "not-found" });
    reply.header("cache-control", "no-cache");
    if (fs.existsSync(kioskIndex)) return reply.type("text/html; charset=utf-8").send(fs.createReadStream(kioskIndex));
    return reply.type("text/html; charset=utf-8").send(NOT_BUILT_HTML);
  });

  /* ---------------- lifecycle ---------------- */
  app.addHook("onReady", async () => {
    profiles.watch();
    if (opts.connect !== false || env.demo) {
      ha.start();
      demoAgents?.start();
    }
  });
  app.addHook("onClose", async () => {
    profiles.close();
    takeover.stop();
    ha.stop();
    agents.stop();
    for (const s of [...sessions]) s.close();
  });

  return { app, hub, devices, profiles, agents, ha, takeover, config, sessions, adminPassword };
}
