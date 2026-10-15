import { afterEach, describe, expect, it } from "vitest";
import { CHECKS, runPrechecks } from "../src/precheck/checks.js";
import { fakePrecheckEnv, SCENARIOS, type FakeScenario } from "../src/precheck/fake.js";
import { countLhmSensors, haDetails, scanLan, windowsName } from "../src/precheck/real.js";
import { nextHaStep, recommend } from "../src/precheck/recommend.js";
import type { Check, Facts } from "../src/precheck/types.js";
import { startFakeHa, type FakeHa } from "./fake-ha.js";

async function run(s: FakeScenario) {
  const seen: Check[] = [];
  const r = await runPrechecks(fakePrecheckEnv(s), (c) => seen.push(c));
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  return { ...r, seen, by };
}

describe("system check: Kevin's PC today", () => {
  it("recommends a fixed IP for Home Assistant first, then the rest of the HA wizard, then Move", async () => {
    const { recommendation: rec, by, facts } = await run(SCENARIOS.kevin!);
    expect(rec.mode).toBe("ha");
    expect(rec.fromStep).toBe("staticip");
    expect(rec.title).toContain("Fixed IP");
    expect(rec.why).toContain("fixed IP");
    expect(rec.why).toContain("http://192.168.1.81");
    expect(rec.why).toMatch(/Mosquitto app isn't installed/);
    expect(rec.why).toMatch(/HomePanel app isn't installed/);
    expect(rec.then).toMatch(/move the server/i);

    expect(facts.ha).toMatchObject({ url: "http://192.168.1.81", status: "onboarded", token: "valid", haOs: true, mosquitto: "missing", homepanelApp: "missing" });
    expect(by["ha.found"]).toMatchObject({ state: "ok" });
    expect(by["ha.found"]!.detail).toContain("port 80");
    expect(by["ha.token"]).toMatchObject({ state: "ok" });
    expect(by["ha.mosquitto"]).toMatchObject({ state: "warn", fix: { mode: "ha", fromStep: "mqtt" } });
    expect(by["ha.ip"]).toMatchObject({ state: "warn", fix: { mode: "ha", fromStep: "staticip" } });
    expect(by["hp.app"]).toMatchObject({ state: "warn", fix: { mode: "ha", fromStep: "server" } });
    expect(by["hp.local"]).toMatchObject({ state: "ok" });
    expect(by["hp.agent"]).toMatchObject({ state: "ok" });
    expect(by["sensors.lhm"]!.detail).toContain("142 sensors");
    expect(by["ha.zbt1"]).toMatchObject({ state: "warn", fix: { fromStep: "zigbee" } });
    expect(by["ha.proxmox"]!.detail).toContain("192.168.1.251");
  });

  it("streams: every check first as running, then each result once", async () => {
    const { seen, checks } = await run({ ...SCENARIOS.kevin!, delayMs: 2 });
    const running = seen.filter((c) => c.state === "running");
    expect(running.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
    expect(seen.indexOf(running.at(-1)!)).toBe(CHECKS.length - 1);
    const finals = seen.filter((c) => c.state !== "running");
    expect(new Set(finals.map((c) => c.id)).size).toBe(finals.length);
    expect(checks.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
    expect(checks.every((c) => c.state !== "running" && c.group && c.detail)).toBe(true);
  });
});

describe("system check: other situations", () => {
  it("fresh PC, nothing on the network → Host on this PC", async () => {
    const { recommendation, by } = await run(SCENARIOS.fresh!);
    expect(recommendation.mode).toBe("host");
    expect(by["ha.found"]).toMatchObject({ state: "warn", fix: { mode: "ha" } });
    expect(by["pc.setup"]!.detail).toMatch(/Nothing set up/);
    expect(by["sensors.lhm"]!.state).toBe("info");
  });

  it("HA not found but Proxmox answers → set up Home Assistant (VM)", async () => {
    const { recommendation } = await run(SCENARIOS.proxmox!);
    expect(recommendation).toMatchObject({ mode: "ha" });
    expect(recommendation.why).toContain("192.168.1.251");
  });

  it("HA preparing → HA wizard at onboarding (it waits), with the progress", async () => {
    const { recommendation, by } = await run(SCENARIOS.preparing!);
    expect(recommendation).toMatchObject({ mode: "ha", fromStep: "onboard" });
    expect(recommendation.why).toMatch(/still preparing/);
    expect(by["ha.onboarded"]!.detail).toContain("40%");
  });

  it("token expired → HA wizard at the token step", async () => {
    const { recommendation, by } = await run(SCENARIOS["token-expired"]!);
    expect(recommendation).toMatchObject({ mode: "ha", fromStep: "token" });
    expect(by["ha.token"]).toMatchObject({ state: "fail", fix: { fromStep: "token" } });
    expect(by["ha.mosquitto"]!.state).toBe("info");
  });

  it("HA saved but down, host PC fine → HA wizard at detect", async () => {
    const { recommendation, by } = await run(SCENARIOS["ha-down"]!);
    expect(recommendation).toMatchObject({ mode: "ha", fromStep: "detect" });
    expect(by["ha.found"]!.state).toBe("fail");
  });

  it("both apps running on HA while this PC still hosts → Move", async () => {
    const { recommendation } = await run(SCENARIOS["ready-to-move"]!);
    expect(recommendation.mode).toBe("move");
  });

  it("everything done (moved, agent online) → control", async () => {
    const { recommendation, by } = await run(SCENARIOS.done!);
    expect(recommendation.mode).toBe("control");
    expect(by["hp.local"]!.detail).toMatch(/Retired/);
    expect(by["hp.app"]!.state).toBe("ok");
    expect(by["ha.zbt1"]!.state).toBe("ok");
    expect(by["ha.mosquitto"]!.state).toBe("ok");
  });

  it("second PC with HomePanel on HA → Join", async () => {
    const { recommendation, by } = await run(SCENARIOS["second-pc"]!);
    expect(recommendation.mode).toBe("join");
    expect(recommendation.why).toContain("http://192.168.1.81:8080");
    expect(by["hp.lan"]!.detail).toContain("192.168.1.50");
  });

  it("host with agent offline, LHM down, Public network → repair Host, one-click fixes", async () => {
    const { recommendation, by } = await run(SCENARIOS["host-broken"]!);
    expect(recommendation.mode).toBe("host");
    expect(recommendation.why).toMatch(/agent is offline/);
    expect(by["pc.firewall"]).toMatchObject({ state: "warn", fix: { action: "network/private" } });
    expect(by["hp.agent"]).toMatchObject({ state: "fail", fix: { action: "agent/restart" } });
    expect(by["sensors.lhm"]).toMatchObject({ state: "fail", fix: { action: "sensors/start" } });
  });

  it("another PC hosts HomePanel (no HA) → Join it", async () => {
    const { recommendation } = await run({ net: { ip: "192.168.1.60", hostname: "X" }, lan: { proxmox: [], homepanel: ["http://192.168.1.50:8080"] } });
    expect(recommendation).toMatchObject({ mode: "join" });
  });

  it("a probe that hangs times out instead of blocking the check", async () => {
    const env = fakePrecheckEnv(SCENARIOS.fresh!);
    env.internet = () => new Promise(() => undefined);
    const t0 = Date.now();
    const r = await runPrechecks(env);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.checks.find((c) => c.id === "pc.internet")!.state).toBe("warn");
  }, 10_000);
});

describe("recommend (pure)", () => {
  const base: Facts = {
    platform: "win32",
    local: {},
    tasks: { server: "missing", agent: "missing", sensors: "missing", tray: "missing" },
    mosquittoService: "missing",
    agent: "none",
    lan: { proxmox: [], homepanel: [] },
  };
  const ha = (p: Partial<NonNullable<Facts["ha"]>>): NonNullable<Facts["ha"]> => ({
    url: "http://192.168.1.81",
    status: "onboarded",
    token: "valid",
    haOs: true,
    mosquitto: "running",
    homepanelApp: "running",
    homepanelHealth: true,
    homepanelUrl: "http://192.168.1.81:8080",
    zha: "loaded",
    ...p,
  });
  it("nextHaStep follows the wizard order", () => {
    expect(nextHaStep(ha({ status: "onboarding" }))).toBe("onboard");
    expect(nextHaStep(ha({ token: "none" }))).toBe("token");
    expect(nextHaStep(ha({ mosquitto: "stopped" }))).toBe("mqtt");
    expect(nextHaStep(ha({ haOs: false, mosquitto: "unknown", homepanelApp: "unknown", homepanelHealth: false }))).toBe("server");
    expect(nextHaStep(ha({}))).toBeUndefined();
  });
  it("HA Container (no apps) with HomePanel answering → join", () => {
    expect(recommend([], { ...base, ha: ha({ haOs: false, mosquitto: "unknown", homepanelApp: "unknown" }) }).mode).toBe("join");
  });
});

describe("real probe helpers", () => {
  let fake: FakeHa | undefined;
  afterEach(async () => fake?.close());

  it("counts LibreHardwareMonitor sensors and names Windows builds", () => {
    const tree = { Text: "Sensor", Children: [{ Text: "PC", Children: [{ Text: "CPU", Children: [{ Text: "Package", Value: "55,0 °C" }, { Text: "Core", Value: "50 °C" }, { Text: "Empty", Value: "" }] }] }] };
    expect(countLhmSensors(tree)).toBe(2);
    expect(windowsName("10.0.26100")).toEqual({ name: "Windows 11", build: 26100 });
    expect(windowsName("10.0.19045")).toEqual({ name: "Windows 10", build: 19045 });
  });

  it("LAN scan: probes the /24 on 8006 and 8080, verifies Proxmox and HomePanel, skips this PC", async () => {
    const probed = new Set<string>();
    const r = await scanLan("192.168.1.50", {
      probe: async (h, port) => (probed.add(h), (h === "192.168.1.251" && port === 8006) || (h === "192.168.1.81" && port === 8080) || (h === "192.168.1.9" && port === 8006)),
      isProxmox: async (h) => h === "192.168.1.251",
      health: async (u) => u === "http://192.168.1.81:8080",
    });
    expect(r).toEqual({ proxmox: ["192.168.1.251"], homepanel: ["http://192.168.1.81:8080"] });
    expect(probed.size).toBe(253);
    expect(probed.has("192.168.1.50")).toBe(false);
  });

  it("haDetails reads version, HA OS, installed apps and ZHA over the WebSocket", async () => {
    fake = await startFakeHa({ onboarded: true, haOs: true, tokens: ["tok.x.y"], addons: { core_mosquitto: "started" }, entries: [{ domain: "zha", title: "ZBT-1", state: "loaded" }] });
    const d = await haDetails(fake.url, "tok.x.y");
    expect(d).toMatchObject({ version: "2026.10.0", haOs: true, zha: "loaded" });
    expect(d.addons).toEqual([{ slug: "core_mosquitto", state: "started", version: "1.0" }]);
  });
});

import { HaClient, normalizeHaUrl as norm } from "../src/ha/client.js";
import { setHaAddress } from "../src/ha/address.js";

describe("Home Assistant on port 80 stays on port 80 (regression)", () => {
  it("saving a resolved http://ip URL keeps it portless instead of turning it back into :8123", () => {
    expect(norm("http://192.168.1.81")).toBe("http://192.168.1.81");
    expect(norm("192.168.1.81")).toBe("http://192.168.1.81:8123");
    const state: Record<string, unknown> = {};
    const store = { state, update: (p: Record<string, unknown>) => Object.assign(state, p) } as never;
    setHaAddress(store, "http://192.168.1.81");
    expect(state.haUrl).toBe("http://192.168.1.81");
  });

  it("a client with a stale :8123 address follows HA to port 80 and reports the move", async () => {
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.port === "8123") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      if (u.pathname === "/auth/providers") return new Response('[{"type":"homeassistant"}]', { status: 200 });
      if (u.pathname === "/api/") return new Response('{"message":"API running."}', { status: 200 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const moved: string[] = [];
    const c = new HaClient("http://192.168.1.81:8123", { fetchImpl: f, token: "t", onMoved: (u) => moved.push(u) });
    expect(await c.apiOk()).toBe(true);
    expect(c.url).toBe("http://192.168.1.81");
    expect(moved).toEqual(["http://192.168.1.81"]);
  });
});
