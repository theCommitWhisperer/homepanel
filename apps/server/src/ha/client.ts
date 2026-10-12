import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import WebSocket from "ws";
import type { HaEntityState } from "@homepanel/protocol";
import type { CameraFetchResult, HaSource, HaStatus } from "./types.js";

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** HA WebSocket URL for a base URL. The Supervisor proxy uses /core/websocket, HA itself /api/websocket. */
export function haWsUrl(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  const p = u.pathname.replace(/\/+$/, "");
  u.pathname = u.hostname === "supervisor" && p === "/core" ? "/core/websocket" : `${p}/api/websocket`;
  return u.toString();
}

/** Minimal hand-written Home Assistant WebSocket client (auth, get_states, state_changed, call_service). */
export class HaClient extends EventEmitter implements HaSource {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private entities = new Map<string, HaEntityState>();
  private _status: HaStatus = "disconnected";
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private stateSubId = -1;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly log: FastifyBaseLogger,
  ) {
    super();
  }

  get status() {
    return this._status;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.removeAllListeners();
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setStatus("disconnected");
  }

  states() {
    return [...this.entities.values()];
  }

  getState(id: string) {
    return this.entities.get(id);
  }

  private setStatus(s: HaStatus) {
    if (s === this._status) return;
    this._status = s;
    this.emit("status", s);
  }

  private connect() {
    if (this.stopped) return;
    const url = haWsUrl(this.baseUrl);
    this.log.info({ url }, "ha: connecting");
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (Array.isArray(msg)) msg.forEach((m) => this.onMessage(m));
      else this.onMessage(msg);
    });
    ws.on("close", () => this.onClose());
    ws.on("error", (err) => this.log.warn({ err: err.message }, "ha: socket error"));
  }

  private onClose() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("ha-disconnected"));
    }
    this.pending.clear();
    this.ws = null;
    this.setStatus("disconnected");
    if (this.stopped) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt++, 6)) + Math.floor(Math.random() * 500);
    this.log.info({ delayMs: delay }, "ha: reconnecting");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private send(obj: unknown) {
    this.ws?.send(JSON.stringify(obj));
  }

  private request<T = unknown>(payload: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("ha-disconnected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ha-timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, ...payload });
    });
  }

  private onMessage(msg: any) {
    switch (msg.type) {
      case "auth_required":
        this.send({ type: "auth", access_token: this.token });
        return;
      case "auth_invalid":
        this.log.error({ message: msg.message }, "ha: authentication failed — check HA_TOKEN");
        this.ws?.close();
        return;
      case "auth_ok":
        this.attempt = 0;
        void this.onAuthed();
        return;
      case "result":
      case "pong": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.type === "pong" || msg.success) p.resolve(msg.result);
        else p.reject(new Error(msg.error?.message || msg.error?.code || "ha-error"));
        return;
      }
      case "event": {
        if (msg.id !== this.stateSubId) return;
        const d = msg.event?.data;
        if (!d?.entity_id) return;
        const newState: HaEntityState | null = d.new_state ?? null;
        const oldState: HaEntityState | null = d.old_state ?? null;
        if (newState) this.entities.set(d.entity_id, newState);
        else this.entities.delete(d.entity_id);
        this.emit("state", d.entity_id, newState, oldState);
        return;
      }
    }
  }

  private async onAuthed() {
    try {
      // subscribe first so no change is lost between snapshot and stream
      const subId = this.nextId;
      this.stateSubId = subId;
      await this.request({ type: "subscribe_events", event_type: "state_changed" });
      const states = await this.request<HaEntityState[]>({ type: "get_states" }, 30_000);
      const seen = new Set<string>();
      for (const s of states) {
        seen.add(s.entity_id);
        const old = this.entities.get(s.entity_id) ?? null;
        this.entities.set(s.entity_id, s);
        this.emit("state", s.entity_id, s, old, { initial: true });
      }
      for (const id of [...this.entities.keys()]) if (!seen.has(id)) this.entities.delete(id);
      this.setStatus("connected");
      this.log.info({ entities: states.length }, "ha: connected");
      this.pingTimer = setInterval(() => {
        this.request({ type: "ping" }, 10_000).catch(() => {
          this.log.warn("ha: ping failed, reconnecting");
          this.ws?.terminate();
        });
      }, 30_000);
    } catch (err) {
      this.log.error({ err: (err as Error).message }, "ha: setup failed");
      this.ws?.terminate();
    }
  }

  async callService(domain: string, service: string, data?: Record<string, unknown>) {
    await this.request({ type: "call_service", domain, service, service_data: data ?? {} });
  }

  async camera(entityId: string, kind: "snapshot" | "stream", signal: AbortSignal): Promise<CameraFetchResult> {
    const base = this.baseUrl.replace(/\/+$/, "");
    const api = entityId.startsWith("image.")
      ? `image_proxy/${entityId}`
      : kind === "stream"
        ? `camera_proxy_stream/${entityId}`
        : `camera_proxy/${entityId}`;
    const res = await fetch(`${base}/api/${api}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    });
    const contentType = res.headers.get("content-type") || (kind === "stream" ? "multipart/x-mixed-replace" : "image/jpeg");
    if (!res.body) return { status: res.status, contentType, body: Buffer.alloc(0) };
    return {
      status: res.status,
      contentType,
      body: Readable.fromWeb(res.body as any),
    };
  }
}
