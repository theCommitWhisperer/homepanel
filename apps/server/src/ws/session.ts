import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import {
  ActionRequestSchema,
  type DataKey,
  type KioskToServer,
  type Profile,
  type ServerToKiosk,
} from "@homepanel/protocol";
import type { AgentManager } from "../mqtt/agents.js";
import { publicDevice, type DeviceStore, type StoredDevice } from "../devices.js";
import type { HaSource } from "../ha/types.js";
import type { KeyValue, StateHub } from "./hub.js";
import type { ProfileStore } from "../profiles.js";
import type { TakeoverTarget } from "../takeover.js";

const HELLO_TIMEOUT_MS = 10_000;
const MAX_KEYS = 500;
/** Agent sensor pushes are throttled per socket: normal screens 1/s, lite profiles 1 per 10 s. */
export const SENSOR_THROTTLE_MS = 1_000;
export const LITE_SENSOR_THROTTLE_MS = 10_000;

export const isThrottledKey = (key: DataKey) => key.startsWith("agent:") && key.endsWith(":sensors");

export interface WsDeps {
  hub: StateHub;
  devices: DeviceStore;
  profiles: ProfileStore;
  agents: AgentManager;
  ha: HaSource;
  log: FastifyBaseLogger;
}

/** One connected screen. */
export class KioskSession implements TakeoverTarget {
  device: StoredDevice | null = null;
  private keys = new Set<DataKey>();
  private helloTimer: NodeJS.Timeout | null;
  /** throttled keys: last send time and a trailing timer that sends the newest value */
  private lastSent = new Map<DataKey, number>();
  private trailing = new Map<DataKey, NodeJS.Timeout>();
  /** `ha:<domain>.*` subscriptions, stored as prefixes ("ha:light.") */
  private prefixes: string[] = [];
  private wants(key: DataKey) {
    return this.keys.has(key) || this.prefixes.some((p) => key.startsWith(p));
  }
  private onChange = (key: DataKey, kv: KeyValue) => {
    if (this.wants(key)) this.push(key, kv);
  };

  constructor(
    private ws: WebSocket,
    readonly remote: boolean,
    private deps: WsDeps,
    private sessions: Set<KioskSession>,
  ) {
    this.helloTimer = setTimeout(() => this.reject("hello-timeout"), HELLO_TIMEOUT_MS);
    ws.on("message", (raw) => void this.onMessage(raw.toString()));
    ws.on("close", () => this.dispose());
    ws.on("error", () => this.dispose());
  }

  get deviceId() {
    return this.device?.id ?? "";
  }
  get profileId() {
    return this.device?.profileId ?? "";
  }

  private throttleMs(): number {
    return this.deps.profiles.get(this.profileId)?.lite ? LITE_SENSOR_THROTTLE_MS : SENSOR_THROTTLE_MS;
  }

  /** Send a state update, rate-limited for agent sensor keys (latest value always wins). */
  private push(key: DataKey, kv: KeyValue, immediate = false) {
    if (!isThrottledKey(key)) return this.send({ type: "state", key, value: kv.value, ts: kv.ts });
    const now = Date.now();
    const wait = (this.lastSent.get(key) ?? -Infinity) + this.throttleMs() - now;
    if (immediate || wait <= 0) {
      clearTimeout(this.trailing.get(key));
      this.trailing.delete(key);
      this.lastSent.set(key, now);
      return this.send({ type: "state", key, value: kv.value, ts: kv.ts });
    }
    if (this.trailing.has(key)) return; // a trailing send is queued; it reads the newest value then
    const t = setTimeout(() => {
      this.trailing.delete(key);
      const cur = this.deps.hub.get(key);
      if (cur && this.wants(key)) this.push(key, cur, true);
    }, wait);
    t.unref?.();
    this.trailing.set(key, t);
  }

  send(msg: ServerToKiosk) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private reject(reason: string) {
    this.send({ type: "unauthorized", reason });
    this.ws.close(4001, reason);
  }

  private dispose() {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.deps.hub.off("change", this.onChange);
    for (const t of this.trailing.values()) clearTimeout(t);
    this.trailing.clear();
    this.sessions.delete(this);
  }

  private async onMessage(text: string) {
    let msg: KioskToServer;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ping") return this.send({ type: "pong" });
    if (msg.type === "hello") return this.hello(msg.deviceToken);
    if (!this.device) return this.reject("hello-required");
    // device may have been revoked meanwhile
    if (!this.deps.devices.get(this.device.id)) return this.reject("revoked");
    if (msg.type === "subscribe") return this.subscribe(msg.keys);
    if (msg.type === "action") return this.action(msg);
  }

  private hello(token: unknown) {
    const d = this.deps.devices.byToken(typeof token === "string" ? token : "");
    if (!d) return this.reject("unknown-token");
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    const first = !this.device;
    this.device = d;
    this.deps.devices.touch(d.id);
    this.sessions.add(this);
    if (first) this.deps.hub.on("change", this.onChange);
    this.send({
      type: "welcome",
      device: { ...publicDevice(d), remote: this.remote },
      profile: this.deps.profiles.getOrFallback(d.profileId),
    });
    this.deps.log.info({ device: d.name, remote: this.remote }, "screen connected");
  }

  private subscribe(keys: unknown) {
    if (!Array.isArray(keys)) return;
    const next = new Set(keys.filter((k): k is string => typeof k === "string").slice(0, MAX_KEYS));
    const added = [...next].filter((k) => !this.keys.has(k));
    const oldPrefixes = new Set(this.prefixes);
    this.keys = next;
    // wildcard `ha:<domain>.*` → every entity of that domain, each as its own ha:<entity_id> message
    this.prefixes = [...next].filter((k) => /^ha:[a-z0-9_]+\.\*$/.test(k)).map((k) => k.slice(0, -1));
    for (const key of added) {
      if (key.endsWith(".*")) continue;
      const kv = this.deps.hub.get(key);
      if (kv) this.push(key, kv, true);
    }
    for (const p of this.prefixes) {
      if (oldPrefixes.has(p)) continue;
      for (const key of this.deps.hub.keys(p)) {
        const kv = this.deps.hub.get(key);
        if (kv) this.push(key, kv, true);
      }
    }
  }

  private async action(msg: Extract<KioskToServer, { type: "action" }>) {
    const id = typeof msg.id === "string" ? msg.id : "";
    const parsed = ActionRequestSchema.safeParse(msg.action);
    if (!parsed.success) return this.send({ type: "action_result", id, ok: false, error: "invalid-action" });
    const a = parsed.data;
    try {
      if (a.kind === "ha") {
        await this.deps.ha.callService(a.domain, a.service, a.data);
        return this.send({ type: "action_result", id, ok: true });
      }
      if (a.kind === "agent") {
        const r = await this.deps.agents.runAction(a.pc, a.action, { remote: this.remote, confirmed: msg.confirmed === true });
        if (!r.ok) this.deps.log.info({ device: this.device?.name, pc: a.pc, action: a.action, error: r.error }, "agent action refused/failed");
        return this.send({ type: "action_result", id, ...r });
      }
      const r = await this.deps.agents.wake(a.pc);
      return this.send({ type: "action_result", id, ...r });
    } catch (e) {
      return this.send({ type: "action_result", id, ok: false, error: (e as Error).message || "error" });
    }
  }

  /** Called when the device record changed (rename / new profile). */
  refreshDevice(d: StoredDevice) {
    const profileChanged = d.profileId !== this.device?.profileId;
    this.device = d;
    if (profileChanged) this.pushProfile(this.deps.profiles.getOrFallback(d.profileId));
  }

  pushProfile(profile: Profile) {
    this.send({ type: "profile", profile });
  }

  revoke() {
    this.reject("revoked");
  }

  /** Server shutdown: plain close so the screen reconnects (not a revoke). */
  close() {
    this.ws.close(1001, "server-restart");
  }
}
