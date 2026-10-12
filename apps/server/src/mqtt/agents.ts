import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  signingString,
  topics,
  type AgentActionInfo,
  type AgentActionsPayload,
  type AgentCommand,
  type AgentCommandResult,
  type AgentDrivesPayload,
  type AgentSensorsPayload,
  type AgentSummary,
} from "@homepanel/protocol";
import type { StateHub } from "../ws/hub.js";
import { parseMac } from "../wol.js";
import { randomToken, readJson, writeJson } from "../store.js";

export interface AgentRecord {
  name: string;
  key: string;
  mac?: string;
}
export type AgentRegistry = Record<string, AgentRecord>;

/** how long to wait for an agent's cmd_result */
export const CMD_TIMEOUT_MS = 10_000;

export function signCommand(key: string, c: Pick<AgentCommand, "id" | "action" | "ts">): string {
  return createHmac("sha256", key).update(signingString(c)).digest("hex");
}

export function buildCommand(key: string, action: string, now = Date.now(), id: string = randomUUID()): AgentCommand {
  const base = { id, action, ts: now };
  return { ...base, sig: signCommand(key, base) };
}

/** How the manager talks to agents: real MQTT or the demo simulator. */
export interface AgentTransport {
  readonly status: "connected" | "disconnected" | "demo" | "disabled";
  publish(topic: string, payload: string): void;
  stop(): void;
}

interface LiveState {
  status?: "online" | "offline";
  lastSeen?: number;
  hostname?: string;
  sensors?: AgentSensorsPayload;
  drives?: AgentDrivesPayload;
  actions?: AgentActionsPayload;
}

export interface ActionContext {
  remote: boolean;
  confirmed: boolean;
}
export interface ActionOutcome {
  ok: boolean;
  error?: string;
}

const TOPIC_RE = /^homepanel\/agent\/([^/]+)\/([^/]+)$/;

/**
 * PC agents: registry (DATA_DIR/agents.json), latest MQTT payloads, signed commands, Wake-on-LAN.
 */
export class AgentManager extends EventEmitter {
  private file: string;
  private registry: AgentRegistry;
  private live = new Map<string, LiveState>();
  private waiters = new Map<string, { resolve: (r: AgentCommandResult) => void; timer: NodeJS.Timeout; pc: string }>();
  transport: AgentTransport | null = null;

  constructor(
    dataDir: string,
    private hub: StateHub,
    private wol: (mac: string) => Promise<void>,
    private now: () => number = Date.now,
  ) {
    super();
    this.file = path.join(dataDir, "agents.json");
    this.registry = readJson<AgentRegistry>(this.file, {});
    for (const pc of Object.keys(this.registry)) this.publishPc(pc);
    this.publishSummary();
  }

  private save() {
    writeJson(this.file, this.registry, 0o600);
  }

  /* ---------------- registry ---------------- */

  getRecord(pc: string): AgentRecord | undefined {
    // own keys only: "constructor", "__proto__" etc. must not resolve to Object.prototype members
    return Object.prototype.hasOwnProperty.call(this.registry, pc) ? this.registry[pc] : undefined;
  }

  register(pcId: string, name: string, mac?: string, key = randomToken(32)): { pcId: string; key: string } {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(pcId)) throw new Error("pcId must be letters, digits, - or _");
    if (mac && !parseMac(mac)) throw new Error("invalid MAC address");
    const existing = this.registry[pcId];
    this.registry[pcId] = { name, key: existing?.key ?? key, ...(mac ? { mac } : existing?.mac ? { mac: existing.mac } : {}) };
    this.save();
    this.publishPc(pcId);
    this.publishSummary();
    return { pcId, key: this.registry[pcId]!.key };
  }

  unregister(pcId: string): boolean {
    if (!this.getRecord(pcId)) return false;
    delete this.registry[pcId];
    this.save();
    this.publishSummary();
    return true;
  }

  summaries(): AgentSummary[] {
    const ids = new Set([...Object.keys(this.registry), ...this.live.keys()]);
    return [...ids].sort().map((pcId) => {
      const r = this.registry[pcId];
      const l = this.live.get(pcId);
      return {
        pcId,
        name: r?.name ?? l?.hostname ?? pcId,
        status: l?.status ?? (l?.lastSeen ? "online" : "never-seen"),
        ...(l?.lastSeen ? { lastSeen: l.lastSeen } : {}),
        ...(l?.hostname ? { hostname: l.hostname } : {}),
        hasMac: !!r?.mac,
      };
    });
  }

  actionsOf(pc: string): AgentActionInfo[] | undefined {
    return this.live.get(pc)?.actions?.actions;
  }

  /* ---------------- incoming ---------------- */

  handleMessage(topic: string, payload: Buffer | string) {
    const m = TOPIC_RE.exec(topic);
    if (!m) return;
    const pc = m[1]!;
    const kind = m[2]!;
    const text = payload.toString();
    if (kind === "cmd") return; // our own commands
    const l = this.live.get(pc) ?? {};
    this.live.set(pc, l);
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    switch (kind) {
      case "status": {
        if (!text) return; // retained message cleared
        const s = String(json).toLowerCase() === "online" ? "online" : "offline";
        const changed = l.status !== s;
        l.status = s;
        if (s === "online") l.lastSeen = this.now();
        this.hub.set(`agent:${pc}:status`, s);
        if (changed) this.publishSummary();
        return;
      }
      case "sensors":
        if (!json || !Array.isArray(json.sensors)) return;
        l.sensors = json;
        l.hostname = json.hostname ?? l.hostname;
        this.seen(pc, l);
        this.hub.set(`agent:${pc}:sensors`, json);
        return;
      case "drives":
        if (!json || !Array.isArray(json.drives)) return;
        l.drives = json;
        this.seen(pc, l);
        this.hub.set(`agent:${pc}:drives`, json);
        return;
      case "actions":
        if (!json || !Array.isArray(json.actions)) return;
        l.actions = json;
        this.hub.set(`agent:${pc}:actions`, json);
        return;
      case "cmd_result": {
        if (!json || typeof json.id !== "string") return;
        const w = this.waiters.get(json.id);
        if (!w || w.pc !== pc) return;
        clearTimeout(w.timer);
        this.waiters.delete(json.id);
        w.resolve({ id: json.id, ok: !!json.ok, ...(json.error ? { error: String(json.error) } : {}) });
        return;
      }
    }
  }

  private seen(pc: string, l: LiveState) {
    const wasNew = !l.lastSeen;
    l.lastSeen = this.now();
    if (!l.status) {
      l.status = "online";
      this.hub.set(`agent:${pc}:status`, "online");
    }
    if (wasNew) this.publishSummary();
  }

  private publishPc(pc: string) {
    const l = this.live.get(pc);
    if (!l?.status) this.hub.set(`agent:${pc}:status`, "offline");
  }

  publishSummary() {
    this.hub.set("agents", this.summaries());
  }

  /* ---------------- outgoing ---------------- */

  async runAction(pc: string, action: string, ctx: ActionContext): Promise<ActionOutcome> {
    const rec = this.getRecord(pc);
    if (!rec) return { ok: false, error: "unknown-pc" };
    // Guards (confirm / home-only) come from the PC's advertised action list. Without that list we
    // can't know them, so refuse rather than run e.g. a guarded shutdown unchecked.
    const known = this.actionsOf(pc);
    if (!known) return { ok: false, error: "actions-unknown" };
    const info = known.find((a) => a.id === action);
    if (!info) return { ok: false, error: "unknown-action" };
    const guard = info.guard ?? "";
    if (guard.includes("home-only") && ctx.remote) return { ok: false, error: "home-only" };
    if (guard.includes("confirm") && !ctx.confirmed) return { ok: false, error: "confirm-required" };
    if (!this.transport || this.transport.status === "disconnected" || this.transport.status === "disabled") {
      return { ok: false, error: "mqtt-disconnected" };
    }
    if (this.live.get(pc)?.status === "offline") return { ok: false, error: "pc-offline" };
    const cmd = buildCommand(rec.key, action, this.now());
    const result = new Promise<AgentCommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(cmd.id);
        resolve({ id: cmd.id, ok: false, error: "timeout" });
      }, CMD_TIMEOUT_MS);
      this.waiters.set(cmd.id, { resolve, timer, pc });
    });
    this.transport.publish(topics.cmd(pc), JSON.stringify(cmd));
    const r = await result;
    return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
  }

  async wake(pc: string): Promise<ActionOutcome> {
    const rec = this.getRecord(pc);
    if (!rec) return { ok: false, error: "unknown-pc" };
    if (!rec.mac) return { ok: false, error: "no-mac" };
    try {
      await this.wol(rec.mac);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `wol-failed: ${(e as Error).message}` };
    }
  }

  stop() {
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.resolve({ id: "", ok: false, error: "shutting-down" });
    }
    this.waiters.clear();
    this.transport?.stop();
  }
}
