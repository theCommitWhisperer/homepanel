import fs from "node:fs";
import path from "node:path";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { HaEntityState } from "@homepanel/protocol";
import { AssistantService } from "./assistant/service.js";
import { DATA_EXAMPLE_DIR, type EnvConfig } from "./config.js";
import { DemoAgentTransport } from "./demo/fakeAgents.js";
import { prepareDemoDataDir, seedDemo } from "./demo/seed.js";
import { AdminSessions, DeviceStore } from "./devices.js";
import { HaClient } from "./ha/client.js";
import { FakeHa } from "./ha/demo.js";
import { NullHa } from "./ha/null.js";
import type { HaSource } from "./ha/types.js";
import { AgentManager } from "./mqtt/agents.js";
import { MqttTransport, NullTransport } from "./mqtt/transport.js";
import { ProfileStore } from "./profiles.js";
import { adminRoutes } from "./routes/admin.js";
import { cameraRoutes } from "./routes/camera.js";
import { authHelpers, type RouteContext } from "./routes/context.js";
import { demoRoutes } from "./routes/demo.js";
import { healthRoutes } from "./routes/health.js";
import { kioskRoutes } from "./routes/kiosk.js";
import { agentDownloadRoutes } from "./routes/agentDownload.js";
import { mediaRoutes } from "./routes/media.js";
import { pairingRoutes } from "./routes/pairing.js";
import { wsRoutes } from "./routes/ws.js";
import { ServerConfigStore } from "./serverConfig.js";
import { copyDirMissing, randomToken, writeFileAtomic } from "./store.js";
import { TakeoverManager } from "./takeover.js";
import { sendWol } from "./wol.js";
import { StateHub } from "./ws/hub.js";
import type { KioskSession } from "./ws/session.js";

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
    // Only trust X-Forwarded-For when it was added by a proxy on this machine or the LAN. `true` would
    // take the left-most (client-supplied) entry, letting a remote client claim a LAN address.
    trustProxy: env.trustProxy ? "loopback,linklocal,uniquelocal" : false,
    bodyLimit: 2 * 1024 * 1024,
  });
  const log = app.log;

  /* ---------------- data dir ---------------- */
  if (env.demo) prepareDemoDataDir(env.dataDir);
  else {
    fs.mkdirSync(env.dataDir, { recursive: true });
    const empty = fs.readdirSync(env.dataDir).filter((f) => !f.startsWith(".")).length === 0;
    // first start (no config.yaml yet): copy the examples without overwriting anything
    if (empty || !fs.existsSync(path.join(env.dataDir, "config.yaml"))) {
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

  /* ---------------- routes ---------------- */
  const ctx: RouteContext = {
    env, log, hub, devices, profiles, agents, ha, takeover, config, sessions, admin, adminPassword, assistant, mediaDir,
    ...authHelpers(devices, admin),
  };
  await healthRoutes(app, ctx);
  await pairingRoutes(app, ctx);
  await adminRoutes(app, ctx);
  await cameraRoutes(app, ctx);
  await mediaRoutes(app, ctx);
  if (env.demo) await demoRoutes(app, ctx);
  await wsRoutes(app, ctx);
  await agentDownloadRoutes(app, ctx);
  await kioskRoutes(app, ctx);

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
