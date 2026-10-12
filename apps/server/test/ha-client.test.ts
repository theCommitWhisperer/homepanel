import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { HaClient, haWsUrl } from "../src/ha/client.js";

const silent = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return silent; }, level: "silent" } as any;

/** Minimal fake of Home Assistant's WebSocket API. */
function fakeHa(token: string) {
  const wss = new WebSocketServer({ port: 0, path: "/api/websocket" });
  const calls: any[] = [];
  let stateSub: number | null = null;
  let client: WebSocket | null = null;
  wss.on("connection", (ws) => {
    client = ws;
    ws.send(JSON.stringify({ type: "auth_required", ha_version: "2026.10.0" }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "auth") {
        ws.send(JSON.stringify(m.access_token === token ? { type: "auth_ok" } : { type: "auth_invalid", message: "bad token" }));
        return;
      }
      if (m.type === "subscribe_events") {
        stateSub = m.id;
        ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
      } else if (m.type === "get_states") {
        ws.send(
          JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: [{ entity_id: "light.kitchen", state: "off", attributes: {}, last_changed: "t0", last_updated: "t0" }],
          }),
        );
      } else if (m.type === "call_service") {
        calls.push(m);
        ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: { context: {} } }));
        if (m.domain === "light" && m.service === "turn_on") {
          ws.send(
            JSON.stringify({
              id: stateSub,
              type: "event",
              event: {
                event_type: "state_changed",
                data: {
                  entity_id: "light.kitchen",
                  old_state: { entity_id: "light.kitchen", state: "off", attributes: {}, last_changed: "t0", last_updated: "t0" },
                  new_state: { entity_id: "light.kitchen", state: "on", attributes: { brightness: 200 }, last_changed: "t1", last_updated: "t1" },
                },
              },
            }),
          );
        }
      } else if (m.type === "ping") {
        ws.send(JSON.stringify({ id: m.id, type: "pong" }));
      }
    });
  });
  const ready = new Promise<number>((r) => wss.on("listening", () => r((wss.address() as AddressInfo).port)));
  return { wss, calls, ready, kill: () => client?.terminate() };
}

describe("HA WebSocket client", () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    cleanup.forEach((f) => f());
    cleanup = [];
  });

  it("builds the websocket URL (plain HA and Supervisor proxy)", () => {
    expect(haWsUrl("http://homeassistant.local:8123")).toBe("ws://homeassistant.local:8123/api/websocket");
    expect(haWsUrl("https://ha.example.com/")).toBe("wss://ha.example.com/api/websocket");
    expect(haWsUrl("http://supervisor/core")).toBe("ws://supervisor/core/websocket");
  });

  it("auths, loads states, streams state_changed, calls services, reconnects", async () => {
    const ha = fakeHa("good-token");
    const port = await ha.ready;
    const client = new HaClient(`http://127.0.0.1:${port}`, "good-token", silent);
    cleanup.push(() => client.stop(), () => ha.wss.close());
    const events: any[] = [];
    client.on("state", (id, next, prev, meta) => events.push({ id, next, prev, meta }));
    const connected = new Promise<void>((r) => client.on("status", (s) => s === "connected" && r()));
    client.start();
    await connected;
    expect(client.status).toBe("connected");
    expect(client.getState("light.kitchen")?.state).toBe("off");
    expect(events[0]).toMatchObject({ id: "light.kitchen", meta: { initial: true } });

    await client.callService("light", "turn_on", { entity_id: "light.kitchen", brightness: 200 });
    expect(ha.calls[0]).toMatchObject({ type: "call_service", domain: "light", service: "turn_on", service_data: { entity_id: "light.kitchen", brightness: 200 } });
    await new Promise((r) => setTimeout(r, 50));
    const change = events.find((e) => e.next?.state === "on");
    expect(change).toMatchObject({ id: "light.kitchen", prev: { state: "off" } });
    expect(client.getState("light.kitchen")?.attributes.brightness).toBe(200);

    // connection drop → disconnected → reconnects with backoff
    const down = new Promise<void>((r) => client.on("status", (s) => s === "disconnected" && r()));
    ha.kill();
    await down;
    await expect(client.callService("light", "turn_off", {})).rejects.toThrow(/ha-disconnected/);
    const again = new Promise<void>((r) => client.on("status", (s) => s === "connected" && r()));
    await again;
    expect(client.status).toBe("connected");
  });

  it("stays disconnected on a bad token", async () => {
    const ha = fakeHa("good-token");
    const port = await ha.ready;
    const client = new HaClient(`http://127.0.0.1:${port}`, "wrong", silent);
    cleanup.push(() => client.stop(), () => ha.wss.close());
    client.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(client.status).toBe("disconnected");
  });
});
