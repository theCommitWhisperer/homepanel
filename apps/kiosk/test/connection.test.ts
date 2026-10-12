import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KioskToServer, ServerToKiosk } from "@homepanel/protocol";
import { Connection, PING_MS, backoffMs } from "../src/lib/connection";
import type { SocketLike } from "../src/lib/connection";
import { local, TOKEN_KEY } from "../src/lib/storage";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: KioskToServer[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  recv(m: ServerToKiosk) { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

const profile = { id: "p", name: "P", grid: { cols: 2, rows: 2 }, theme: "dark" as const, lite: false, widgets: [] };
const welcome: ServerToKiosk = { type: "welcome", device: { id: "d", name: "D", profileId: "p" }, profile };

describe("Connection", () => {
  let sockets: FakeSocket[];
  let conn: Connection;
  beforeEach(() => {
    vi.useFakeTimers();
    local.set(TOKEN_KEY, "tok");
    sockets = [];
    conn = new Connection({ createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; }, url: () => "ws://x/ws" });
  });
  afterEach(() => { conn.stop(); local.remove(TOKEN_KEY); vi.useRealTimers(); });

  it("says hello, subscribes after welcome, pings every 25 s", () => {
    conn.setKeys(["b", "a", "a"]);
    conn.start();
    sockets[0].open();
    expect(sockets[0].sent[0]).toEqual({ type: "hello", deviceToken: "tok" });
    sockets[0].recv(welcome);
    expect(conn.getSnapshot().status).toBe("open");
    expect(conn.getSnapshot().profile?.id).toBe("p");
    expect(sockets[0].sent[1]).toEqual({ type: "subscribe", keys: ["a", "b"] });
    vi.advanceTimersByTime(PING_MS);
    expect(sockets[0].sent[2]).toEqual({ type: "ping" });
  });

  it("does not resend an identical key set", () => {
    conn.start(); sockets[0].open(); sockets[0].recv(welcome);
    conn.setKeys(["x"]);
    conn.setKeys(["x"]);
    expect(sockets[0].sent.filter((m) => m.type === "subscribe")).toHaveLength(1);
  });

  it("reconnects with backoff and re-subscribes on the new socket", () => {
    conn.setKeys(["agent:pc:sensors"]);
    conn.start(); sockets[0].open(); sockets[0].recv(welcome);
    sockets[0].drop();
    expect(conn.getSnapshot().status).toBe("reconnecting");
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(2);
    sockets[1].drop();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2); // second delay is longer than the first
    vi.advanceTimersByTime(3000);
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    expect(sockets[2].sent[0]).toEqual({ type: "hello", deviceToken: "tok" });
    sockets[2].recv(welcome);
    expect(sockets[2].sent[1]).toEqual({ type: "subscribe", keys: ["agent:pc:sensors"] });
    expect(conn.reconnectAttempt).toBe(0);
    expect(conn.getSnapshot().status).toBe("open");
  });

  it("stores state messages", () => {
    conn.start(); sockets[0].open(); sockets[0].recv(welcome);
    sockets[0].recv({ type: "state", key: "ha:light.a", value: { state: "on" }, ts: 1 });
    expect(conn.store.get("ha:light.a")).toEqual({ state: "on" });
  });

  it("unauthorized clears the token and returns to pairing without reconnecting", () => {
    conn.start(); sockets[0].open();
    sockets[0].recv({ type: "unauthorized", reason: "revoked" });
    expect(conn.getSnapshot().status).toBe("no-token");
    expect(conn.getSnapshot().lastError).toBe("revoked");
    expect(local.get(TOKEN_KEY)).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("resolves actions from action_result and fails pending ones on disconnect", async () => {
    conn.start(); sockets[0].open(); sockets[0].recv(welcome);
    const p1 = conn.action({ kind: "wol", pc: "pc" });
    const sent = sockets[0].sent.find((m) => m.type === "action") as Extract<KioskToServer, { type: "action" }>;
    sockets[0].recv({ type: "action_result", id: sent.id, ok: false, error: "needs-confirm" });
    await expect(p1).resolves.toEqual({ ok: false, error: "needs-confirm" });
    const p2 = conn.action({ kind: "agent", pc: "pc", action: "sleep" }, true);
    const last = sockets[0].sent[sockets[0].sent.length - 1] as Extract<KioskToServer, { type: "action" }>;
    expect(last.confirmed).toBe(true);
    sockets[0].drop();
    await expect(p2).resolves.toEqual({ ok: false, error: "disconnected" });
  });

  it("takeover and takeover_end", () => {
    conn.start(); sockets[0].open(); sockets[0].recv(welcome);
    sockets[0].recv({ type: "takeover", takeover: { id: "t1", kind: "doorbell", title: "Ring", closeAfterMs: 1000 } });
    expect(conn.getSnapshot().takeover?.id).toBe("t1");
    sockets[0].recv({ type: "takeover_end", id: "other" });
    expect(conn.getSnapshot().takeover?.id).toBe("t1");
    sockets[0].recv({ type: "takeover_end", id: "t1" });
    expect(conn.getSnapshot().takeover).toBeNull();
  });
});

describe("backoffMs", () => {
  it("grows and caps at 30 s (±25% jitter)", () => {
    expect(backoffMs(0, 0.5)).toBe(1000);
    expect(backoffMs(1, 0.5)).toBe(1700);
    expect(backoffMs(20, 0.5)).toBe(30000);
    expect(backoffMs(20, 1)).toBe(37500);
    expect(backoffMs(0, 0)).toBe(750);
  });
});
