import type {
  ActionRequest,
  DataKey,
  DeviceInfo,
  KioskToServer,
  Profile,
  ServerToKiosk,
  Takeover,
} from "@homepanel/protocol";
import { DataStore } from "./store";
import { local, TOKEN_KEY } from "./storage";
import { wsUrl } from "./url";

export type ConnStatus = "no-token" | "connecting" | "open" | "reconnecting";

export interface ConnSnapshot {
  status: ConnStatus;
  token: string | null;
  device: DeviceInfo | null;
  profile: Profile | null;
  takeover: Takeover | null;
  /** last unauthorized reason, shown on the pairing screen */
  lastError: string | null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const ACTION_TIMEOUT_MS = 15_000;

/** One WebSocket to the server: hello → welcome, subscriptions, actions, takeovers. */
export class Connection {
  readonly store = new DataStore();
  private ws: WebSocket | null = null;
  private snap: ConnSnapshot;
  private listeners = new Set<() => void>();
  private keys: DataKey[] = [];
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private pending = new Map<string, { resolve: (r: ActionResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private stopped = true;

  constructor() {
    const token = local.get(TOKEN_KEY);
    this.snap = { status: token ? "connecting" : "no-token", token, device: null, profile: null, takeover: null, lastError: null };
  }

  /* ---- external store ---- */
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getSnapshot = () => this.snap;
  private patch(p: Partial<ConnSnapshot>) {
    this.snap = { ...this.snap, ...p };
    this.listeners.forEach((l) => l());
  }

  /* ---- lifecycle ---- */
  start() {
    this.stopped = false;
    if (!this.snap.token) {
      const t = local.get(TOKEN_KEY);
      if (t) this.patch({ token: t, status: "connecting" });
    }
    if (!this.snap.token) {
      this.patch({ status: "no-token" });
      return;
    }
    this.open();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisible);
      window.addEventListener("online", this.onVisible);
    }
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  setToken(token: string | null) {
    if (token) local.set(TOKEN_KEY, token);
    else local.remove(TOKEN_KEY);
    this.stop();
    this.store.clear();
    this.patch({ token, device: null, profile: null, takeover: null, status: token ? "connecting" : "no-token" });
    if (token) this.start();
  }

  private onVisible = () => {
    if (document.visibilityState === "visible" && !this.stopped && (!this.ws || this.ws.readyState > 1)) {
      this.attempt = 0;
      this.scheduleReconnect(0);
    }
  };

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  private open() {
    this.clearTimers();
    const token = this.snap.token;
    if (!token) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl("/ws"));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.lastMessageAt = Date.now();
      this.raw({ type: "hello", deviceToken: token });
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastMessageAt > 45_000) {
          // dead socket (common after a tablet sleeps); force a reconnect
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        this.raw({ type: "ping" });
      }, 20_000);
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let msg: ServerToKiosk;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.failPending("disconnected");
      if (!this.stopped && this.snap.token) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(delay?: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const d = delay ?? Math.min(30_000, 1000 * Math.pow(1.7, this.attempt)) * (0.75 + Math.random() * 0.5);
    this.attempt++;
    this.patch({ status: "reconnecting" });
    this.reconnectTimer = setTimeout(() => this.open(), d);
  }

  private handle(msg: ServerToKiosk) {
    switch (msg.type) {
      case "welcome":
        this.attempt = 0;
        this.patch({ status: "open", device: msg.device, profile: msg.profile, lastError: null });
        if (this.keys.length) this.raw({ type: "subscribe", keys: this.keys });
        break;
      case "unauthorized":
        this.stop();
        local.remove(TOKEN_KEY);
        this.store.clear();
        this.patch({ status: "no-token", token: null, device: null, profile: null, takeover: null, lastError: msg.reason || "This screen was removed." });
        break;
      case "profile":
        this.patch({ profile: msg.profile });
        break;
      case "state":
        this.store.set(msg.key, msg.value, msg.ts);
        break;
      case "action_result": {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve({ ok: msg.ok, error: msg.error });
        }
        break;
      }
      case "takeover":
        this.patch({ takeover: msg.takeover });
        break;
      case "takeover_end":
        if (this.snap.takeover && this.snap.takeover.id === msg.id) this.patch({ takeover: null });
        break;
      case "pong":
        break;
    }
  }

  private raw(m: KioskToServer): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  }

  private failPending(error: string) {
    this.pending.forEach((p) => {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error });
    });
    this.pending.clear();
  }

  /* ---- public API ---- */
  /** Replace the subscription set (sent again after every reconnect). */
  setKeys(keys: DataKey[]) {
    const uniq = Array.from(new Set(keys)).sort();
    if (uniq.join("\n") === this.keys.join("\n")) return;
    this.keys = uniq;
    this.raw({ type: "subscribe", keys: uniq });
  }

  get subscribedKeys() {
    return this.keys;
  }

  action(action: ActionRequest, confirmed?: boolean): Promise<ActionResult> {
    const id = "a" + Date.now().toString(36) + "-" + ++this.seq;
    return new Promise((resolve) => {
      const msg: KioskToServer = { type: "action", id, action };
      if (confirmed) msg.confirmed = true;
      if (!this.raw(msg)) {
        resolve({ ok: false, error: "Not connected" });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "No answer from server" });
      }, ACTION_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
    });
  }

  dismissTakeover() {
    this.patch({ takeover: null });
  }

  /** Dev/test hook: inject a server message. */
  inject(msg: ServerToKiosk) {
    this.handle(msg);
  }
}

export const connection = new Connection();
