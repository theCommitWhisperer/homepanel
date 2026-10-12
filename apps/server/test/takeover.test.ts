import { describe, expect, it } from "vitest";
import { ServerConfigFileSchema } from "@homepanel/protocol";
import { isRing, TakeoverManager } from "../src/takeover.js";

const st = (entity_id: string, state: string) => ({ entity_id, state, attributes: {}, last_changed: "", last_updated: "" });

describe("ring detection", () => {
  it("binary_sensor rising edge and event changes", () => {
    expect(isRing("binary_sensor.d", st("binary_sensor.d", "on"), st("binary_sensor.d", "off"))).toBe(true);
    expect(isRing("binary_sensor.d", st("binary_sensor.d", "on"), st("binary_sensor.d", "on"))).toBe(false);
    expect(isRing("binary_sensor.d", st("binary_sensor.d", "off"), st("binary_sensor.d", "on"))).toBe(false);
    expect(isRing("event.d", st("event.d", "2026-01-01T00:00:01Z"), st("event.d", "2026-01-01T00:00:00Z"))).toBe(true);
    expect(isRing("event.d", st("event.d", "unavailable"), st("event.d", "x"))).toBe(false);
    expect(isRing("event.d", st("event.d", "2026"), st("event.d", "unavailable"))).toBe(true);
  });

  it("filters by show_on, wakes Fully Kiosk screens, debounces", async () => {
    let now = 0;
    const cfg = ServerConfigFileSchema.parse({
      doorbells: { front: { provider: "reolink", ring: "binary_sensor.v", camera: "camera.f" } },
      on_ring: { show_on: ["kitchen"], close_after: "30s" },
      fully_kiosk: { dev1: { url: "http://10.0.0.5:2323/", password: "p w" } },
    });
    const sent: Record<string, any[]> = { a: [], b: [] };
    const urls: string[] = [];
    const tm = new TakeoverManager({
      getConfig: () => cfg,
      targets: () => [
        { deviceId: "a", profileId: "kitchen", send: (m) => sent.a!.push(m) },
        { deviceId: "b", profileId: "desk", send: (m) => sent.b!.push(m) },
      ],
      deviceProfile: () => "kitchen",
      log: { info() {}, debug() {}, warn() {} } as any,
      fetchImpl: (async (u: string) => {
        urls.push(u);
        return new Response("{}");
      }) as any,
      now: () => now,
    });
    const t = tm.onStateChange("binary_sensor.v", st("binary_sensor.v", "on"), st("binary_sensor.v", "off"));
    expect(t?.closeAfterMs).toBe(30_000);
    expect(sent.a).toHaveLength(1);
    expect(sent.b).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(urls[0]).toBe("http://10.0.0.5:2323/?cmd=screenOn&type=json&password=p%20w");
    now += 5_000;
    expect(tm.onStateChange("binary_sensor.v", st("binary_sensor.v", "on"), st("binary_sensor.v", "off"))).toBeUndefined();
    now += 6_000;
    expect(tm.onStateChange("binary_sensor.v", st("binary_sensor.v", "on"), st("binary_sensor.v", "off"))).toBeDefined();
    tm.stop();
  });
});

describe("review fixes: doorbell name lookup", () => {
  it("ignores prototype property names", async () => {
    const { TakeoverManager } = await import("../src/takeover.js");
    const { ServerConfigFileSchema } = await import("@homepanel/protocol");
    const cfg = ServerConfigFileSchema.parse({});
    const log = { info() {}, debug() {}, warn() {} } as any;
    const t = new TakeoverManager({ getConfig: () => cfg, targets: () => new Set(), deviceProfile: () => undefined, log });
    expect(t.ring("constructor")).toBeUndefined();
    expect(t.ring("toString")).toBeUndefined();
  });
});
