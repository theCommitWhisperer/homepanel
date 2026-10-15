import { hostname } from "node:os";
import { dirname } from "node:path";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import {
  topics,
  type AgentActionsPayload,
  type AgentCommandResult,
  type AgentDrivesPayload,
  type AgentSensor,
  type AgentSensorsPayload,
} from "@homepanel/protocol";
import { ActionDispatcher } from "./actions/dispatcher.js";
import type { AgentConfig } from "./config.js";
import { discoveryMessages } from "./discovery.js";
import { mockDrives, readDrives } from "./drives.js";
import { DryRunSpawner, NodeSpawner, type Spawner } from "./exec.js";
import { CommandVerifier } from "./security.js";
import { createSensorSource, filterSensors, haSensors, type SensorSource } from "./sensors/index.js";
import { AGENT_VERSION, log, throttled } from "./util.js";

export interface AgentOptions {
  config: AgentConfig;
  configPath: string;
  /** fixture sensors + fake drives + dry-run actions (end-to-end tests, demos on Linux) */
  mock?: boolean;
  /** log actions instead of running them (default: config.dryRun, or true on non-Windows) */
  dryRun?: boolean;
  spawner?: Spawner;
  sensorSource?: SensorSource;
  connect?: (url: string, opts: IClientOptions) => MqttClient;
  now?: () => number;
}

export class Agent {
  private client?: MqttClient;
  private timers: NodeJS.Timeout[] = [];
  private readonly cfg: AgentConfig;
  private readonly source: SensorSource;
  private readonly dispatcher: ActionDispatcher;
  private readonly verifier: CommandVerifier;
  private readonly spawner: Spawner;
  readonly dryRun: boolean;
  private readonly host = hostname();
  /** ids we've already published discovery configs for (re-announced when new sensors appear) */
  private discovered = new Set<string>();
  private sensorWarn = throttled(60_000);
  private driveWarn = throttled(300_000);
  private stopped = false;
  private busy = new Set<string>();

  constructor(private opts: AgentOptions) {
    this.cfg = opts.config;
    this.dryRun = !!opts.mock || (opts.dryRun ?? this.cfg.dryRun ?? process.platform !== "win32");
    this.spawner = opts.spawner ?? (this.dryRun ? new DryRunSpawner((l) => log.info(l)) : new NodeSpawner());
    this.source = opts.sensorSource ?? createSensorSource(this.cfg, { mock: opts.mock });
    this.dispatcher = new ActionDispatcher(this.cfg.actions, this.spawner, {
      // in mock mode plan as Windows, so the logged commands are the ones the real PC would run
      platform: opts.mock ? "win32" : process.platform,
      env: process.env,
      configDir: dirname(opts.configPath),
    });
    this.verifier = new CommandVerifier(this.cfg.key, opts.now ?? Date.now);
  }

  get pc() {
    return this.cfg.pcId;
  }

  start(): Promise<void> {
    const { mqtt: m, pcId } = this.cfg;
    const connect = this.opts.connect ?? mqtt.connect;
    const servers: { host: string; port: number; protocol?: any }[] = [];
    try {
      const u = new URL(m.url);
      const primaryPort = Number(u.port) || (u.protocol.startsWith("mqtts") ? 8883 : 1883);
      const primaryProtocol = u.protocol.replace(/:$/, "") as any;
      servers.push({ host: u.hostname, port: primaryPort, protocol: primaryProtocol });
      for (const fb of m.fallbackHosts ?? []) {
        if (fb && fb !== u.hostname && !servers.some((s) => s.host === fb)) {
          servers.push({ host: fb, port: primaryPort, protocol: primaryProtocol });
        }
      }
    } catch {
      /* ignore */
    }
    const fbInfo = servers.length > 1 ? ` (fallbacks: ${servers.slice(1).map((s) => s.host).join(", ")})` : "";
    log.info(
      `HomePanel agent ${AGENT_VERSION} starting: pc=${pcId} broker=${m.url}${fbInfo} sensors=${this.source.name}` +
        `${this.opts.mock ? " (MOCK)" : ""}${this.dryRun ? " actions=dry-run" : ""}`,
    );
    const client = connect(m.url, {
      clientId: m.clientId ?? `homepanel-agent-${pcId}`,
      username: m.username,
      password: m.password,
      rejectUnauthorized: m.rejectUnauthorized,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 15_000,
      ...(servers.length > 1 ? { servers } : {}),
      will: { topic: topics.status(pcId), payload: Buffer.from("offline"), qos: 1, retain: true },
    });
    this.client = client;

    client.on("connect", () => {
      log.info(`connected to MQTT broker`);
      // a fresh session: re-announce everything retained
      this.discovered.clear();
      client.publish(topics.status(pcId), "online", { qos: 1, retain: true });
      client.subscribe(topics.cmd(pcId), { qos: 1 }, (err) => {
        if (err) log.error("could not subscribe to command topic", err);
      });
      this.publishActions();
      void this.publishDrives();
      void this.publishSensors();
    });
    client.on("reconnect", () => log.debug("reconnecting to MQTT..."));
    client.on("offline", () => log.warn("MQTT offline"));
    client.on("error", (e) => {
      const msg = /not authorized|bad user/i.test(e.message)
        ? `${e.message} — check mqtt.username / mqtt.password in agent.yaml`
        : e.message;
      log.error(`MQTT error: ${msg}`);
    });
    client.on("message", (topic, payload) => {
      if (topic === topics.cmd(pcId)) void this.onCommand(payload);
    });

    this.timers.push(setInterval(() => void this.publishSensors(), this.cfg.publishIntervalMs));
    this.timers.push(setInterval(() => void this.publishDrives(), this.cfg.drivesIntervalMs));
    return new Promise((resolve) => {
      if (client.connected) resolve();
      else client.once("connect", () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    const c = this.client;
    if (!c) return;
    await new Promise<void>((resolve) => {
      if (!c.connected) return resolve();
      // graceful: say offline ourselves (LWT only fires on unexpected disconnects)
      c.publish(topics.status(this.cfg.pcId), "offline", { qos: 1, retain: true }, () => resolve());
      setTimeout(resolve, 1500);
    });
    await c.endAsync().catch(() => undefined);
  }

  private publish(topic: string, payload: unknown, retain: boolean, qos: 0 | 1 = 0) {
    if (!this.client?.connected) return;
    this.client.publish(topic, typeof payload === "string" ? payload : JSON.stringify(payload), { retain, qos });
  }

  publishActions() {
    const payload: AgentActionsPayload = { pc: this.cfg.pcId, actions: this.dispatcher.list() };
    this.publish(topics.actions(this.cfg.pcId), payload, true, 1);
  }

  async readSensors(): Promise<AgentSensor[]> {
    const all = await this.source.read();
    return filterSensors(all, this.cfg.sensors);
  }

  async publishSensors() {
    if (!this.client?.connected) return;
    let sensors: AgentSensor[];
    try {
      sensors = await this.readSensors();
    } catch (e) {
      this.sensorWarn(() => log.warn(`sensor read failed: ${(e as Error).message}`));
      return;
    }
    const primaryErr = (this.source as { lastPrimaryError?: Error }).lastPrimaryError;
    if (primaryErr) this.sensorWarn(() => log.warn(`${primaryErr.message} — publishing built-in CPU/RAM load only.`));
    const payload: AgentSensorsPayload = { ts: Date.now(), pc: this.cfg.pcId, hostname: this.host, sensors };
    this.publishDiscovery(sensors);
    this.publish(topics.sensors(this.cfg.pcId), payload, false, 0);
  }

  private publishDiscovery(sensors: AgentSensor[]) {
    if (!this.cfg.haDiscovery) return;
    const wanted = haSensors(sensors, this.cfg.haSensors).filter((s) => !this.discovered.has(s.id));
    if (wanted.length === 0) return;
    for (const msg of discoveryMessages(this.cfg.pcId, this.cfg.name, wanted, this.cfg)) {
      this.publish(msg.topic, msg.payload, true, 1);
      this.discovered.add(String(msg.payload.unique_id).slice(`homepanel_${this.cfg.pcId}_`.length));
    }
    log.info(`published Home Assistant discovery for ${wanted.length} sensor(s)`);
  }

  async publishDrives() {
    if (!this.client?.connected) return;
    try {
      const drives = this.opts.mock ? mockDrives() : await readDrives(this.spawner);
      const payload: AgentDrivesPayload = { ts: Date.now(), pc: this.cfg.pcId, drives };
      this.publish(topics.drives(this.cfg.pcId), payload, true, 1);
    } catch (e) {
      this.driveWarn(() => log.warn(`drive listing failed: ${(e as Error).message}`));
    }
  }

  private async onCommand(payload: Buffer) {
    const v = this.verifier.verify(payload);
    if (!v.ok) {
      log.warn(`rejected command${v.id ? ` ${v.id}` : ""}: ${v.error}`);
      if (v.id) this.reply({ id: v.id, ok: false, error: v.error });
      return;
    }
    const { cmd } = v;
    if (!this.dispatcher.has(cmd.action)) {
      // never interpreted: only ids from agent.yaml can run
      log.warn(`command ${cmd.id}: unknown action ${JSON.stringify(cmd.action.slice(0, 64))} (not in agent.yaml)`);
      this.reply({ id: cmd.id, ok: false, error: "unknown-action" });
      return;
    }
    if (this.busy.has(cmd.action)) {
      this.reply({ id: cmd.id, ok: false, error: "busy" });
      return;
    }
    this.busy.add(cmd.action);
    try {
      const r = await this.dispatcher.run(cmd.action);
      if (!r.ok) log.warn(`action ${cmd.action} failed: ${r.error}`);
      this.reply({ id: cmd.id, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    } finally {
      this.busy.delete(cmd.action);
    }
  }

  private reply(r: AgentCommandResult) {
    this.publish(topics.cmdResult(this.cfg.pcId), r, false, 1);
  }
}
