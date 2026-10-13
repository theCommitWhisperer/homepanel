/**
 * End-to-end: in-process MQTT broker (aedes) on a random port + the real agent CLI
 * (`homepanel-agent run --mock`, via tsx, or the built bundle when HP_AGENT_E2E_BUNDLE=1) in a
 * child process. Checks every topic of the contract and the command path.
 */
import { Aedes } from "aedes";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mqtt, { type MqttClient } from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  topics,
  type AgentActionsPayload,
  type AgentCommandResult,
  type AgentDrivesPayload,
  type AgentSensorsPayload,
} from "@homepanel/protocol";
import { sign } from "../src/security.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PC = "e2e-pc";
const KEY = "e2e-test-key-0123456789abcdef";

let broker: Aedes;
let server: Server;
let port: number;
let dir: string;
let agent: ChildProcess;
let agentLog = "";
let client: MqttClient;
const seen = new Map<string, { payload: string; retain: boolean }[]>();

function waitFor<T>(what: string, fn: () => T | undefined, ms = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting for ${what}\n--- agent log ---\n${agentLog}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}
const last = (topic: string) => seen.get(topic)?.at(-1);
const json = <T>(topic: string) => {
  const m = last(topic);
  return m ? (JSON.parse(m.payload) as T) : undefined;
};

function command(action: string, over: { ts?: number; key?: string; id?: string } = {}) {
  const c = { id: over.id ?? randomUUID(), action, ts: over.ts ?? Date.now() };
  return { ...c, sig: sign(over.key ?? KEY, c) };
}
async function send(cmd: { id: string } & Record<string, unknown>): Promise<AgentCommandResult> {
  client.publish(topics.cmd(PC), JSON.stringify(cmd), { qos: 1 });
  return waitFor(`result for ${cmd.id}`, () =>
    (seen.get(topics.cmdResult(PC)) ?? []).map((m) => JSON.parse(m.payload) as AgentCommandResult).find((r) => r.id === cmd.id),
  );
}
const noResultFor = async (id: string, ms = 600) => {
  await new Promise((r) => setTimeout(r, ms));
  return !(seen.get(topics.cmdResult(PC)) ?? []).some((m) => (JSON.parse(m.payload) as AgentCommandResult).id === id);
};

// Spawns the agent under tsx; covered on Linux CI, and on Windows by the exe smoke test.
const skipE2E = process.platform === "win32";

beforeAll(async () => {
  if (skipE2E) return;
  broker = await Aedes.createBroker();
  server = createServer(broker.handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;

  dir = mkdtempSync(join(tmpdir(), "hp-agent-e2e-"));
  const cfg = join(dir, "agent.yaml");
  writeFileSync(
    cfg,
    `pcId: ${PC}
name: E2E PC
mqtt: { url: "mqtt://127.0.0.1:${port}" }
key: ${KEY}
publishIntervalMs: 500
actions:
  open-drive-c: { type: open, path: 'C:\\' }
  media-playpause: { type: keys, keys: media_play_pause }
  lock: { type: system, command: lock }
  shutdown: { type: system, command: shutdown, guard: confirm+home-only }
`,
  );

  client = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: "e2e-observer" });
  await new Promise<void>((r) => client.once("connect", () => r()));
  client.on("message", (topic, payload, packet) => {
    const list = seen.get(topic) ?? [];
    list.push({ payload: payload.toString(), retain: packet.retain });
    seen.set(topic, list);
  });
  await client.subscribeAsync(["homepanel/agent/#", "homeassistant/#"], { qos: 1 });

  const bundle = join(root, "dist", "homepanel-agent.mjs");
  const useBundle = process.env.HP_AGENT_E2E_BUNDLE === "1" && existsSync(bundle);
  const args = useBundle
    ? [bundle, "run", "--mock", "--config", cfg]
    : ["--import", "tsx", join(root, "src", "cli.ts"), "run", "--mock", "--config", cfg];
  agent = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  agent.stdout!.on("data", (d) => (agentLog += d));
  agent.stderr!.on("data", (d) => (agentLog += d));
}, 30_000);

afterAll(async () => {
  if (skipE2E) return;
  if (agent && agent.exitCode === null) {
    agent.kill("SIGTERM");
    await new Promise((r) => agent.once("exit", r));
  }
  await client?.endAsync();
  await new Promise<void>((r) => broker?.close(() => r()));
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(skipE2E)("agent end-to-end over MQTT (--mock)", () => {
  it("publishes status online (retained)", async () => {
    const m = await waitFor("status", () => last(topics.status(PC)));
    expect(m.payload).toBe("online");
  }, 20_000);

  it("publishes sensors every interval (not retained)", async () => {
    await waitFor("2 sensor messages", () => ((seen.get(topics.sensors(PC))?.length ?? 0) >= 2 ? true : undefined));
    const p = json<AgentSensorsPayload>(topics.sensors(PC))!;
    expect(p.pc).toBe(PC);
    expect(typeof p.hostname).toBe("string");
    expect(Math.abs(Date.now() - p.ts)).toBeLessThan(10_000);
    const ids = p.sensors.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["cpu_package", "gpu_core", "gpu_hotspot", "cpu_load_total", "ram_load", "nvme0_temp", "fan2"]));
    for (const s of p.sensors) {
      expect(typeof s.value).toBe("number");
      expect(s).not.toHaveProperty("hiddenByDefault");
    }
    expect(seen.get(topics.sensors(PC))!.every((m) => !m.retain)).toBe(true);
  });

  it("publishes drives and actions (retained)", async () => {
    const d = await waitFor("drives", () => json<AgentDrivesPayload>(topics.drives(PC)));
    expect(d.pc).toBe(PC);
    expect(d.drives.map((x) => x.letter)).toEqual(["C:", "D:"]);
    const a = await waitFor("actions", () => json<AgentActionsPayload>(topics.actions(PC)));
    expect(a.actions.map((x) => x.id)).toEqual(["open-drive-c", "media-playpause", "lock", "shutdown"]);
    expect(a.actions.find((x) => x.id === "shutdown")).toMatchObject({ type: "system", guard: "confirm+home-only" });

    // retained: a late subscriber gets them immediately
    const late = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: "e2e-late" });
    const got = new Map<string, boolean>();
    late.on("message", (t, _p, packet) => got.set(t, packet.retain));
    await late.subscribeAsync([topics.status(PC), topics.drives(PC), topics.actions(PC)]);
    await waitFor("retained replay", () => (got.size === 3 ? true : undefined), 5000);
    expect([...got.values()].every(Boolean)).toBe(true);
    await late.endAsync();
  });

  it("publishes Home Assistant discovery configs (retained)", async () => {
    const t = topics.haDiscovery(PC, "cpu_package");
    const m = await waitFor("discovery", () => last(t));
    const cfg = JSON.parse(m.payload);
    expect(cfg).toMatchObject({
      unique_id: `homepanel_${PC}_cpu_package`,
      state_topic: topics.sensors(PC),
      availability_topic: topics.status(PC),
      device_class: "temperature",
      unit_of_measurement: "°C",
      state_class: "measurement",
      device: { identifiers: [`homepanel_${PC}`], name: "E2E PC", manufacturer: "HomePanel" },
    });
    expect(cfg.value_template).toContain("s.id == 'cpu_package'");
    expect(last(topics.haDiscovery(PC, "fan2"))).toBeDefined();
    expect(last(topics.haDiscovery(PC, "cpu_clock_core1"))).toBeUndefined(); // clocks stay out of HA
  });

  it("a correctly signed command runs (dry-run in --mock) and returns ok:true", async () => {
    const r = await send(command("lock"));
    expect(r).toMatchObject({ ok: true });
    expect(r).not.toHaveProperty("error");
    await waitFor("dry-run log", () => (agentLog.includes("[dry-run] would run: rundll32.exe user32.dll,LockWorkStation") ? true : undefined), 3000);
    expect((await send(command("open-drive-c"))).ok).toBe(true);
    expect(agentLog).toContain("[dry-run] would run: explorer.exe C:\\");
  });

  it("rejects a bad signature, a stale timestamp and a replay", async () => {
    const forged = command("shutdown", { key: "not-the-right-key-at-all" });
    expect(await send(forged)).toMatchObject({ ok: false, error: "bad signature" });
    const stale = command("lock", { ts: Date.now() - 60_000 });
    expect(await send(stale)).toMatchObject({ ok: false, error: expect.stringContaining("stale") });
    const once = command("lock");
    expect((await send(once)).ok).toBe(true);
    client.publish(topics.cmd(PC), JSON.stringify(once), { qos: 1 });
    await waitFor("replay rejection", () =>
      (seen.get(topics.cmdResult(PC)) ?? []).map((m) => JSON.parse(m.payload) as AgentCommandResult).find((r) => r.id === once.id && !r.ok),
    );
    expect(agentLog).not.toContain("would run: shutdown.exe");
  });

  it("unknown action → unknown-action; garbage is ignored", async () => {
    expect(await send(command("format-c"))).toEqual({ id: expect.any(String), ok: false, error: "unknown-action" });
    client.publish(topics.cmd(PC), "not json at all");
    const id = randomUUID();
    client.publish(topics.cmd(PC), JSON.stringify({ id, action: "lock" }));
    expect(await noResultFor("never")).toBe(true);
    expect((await send({ id, action: "lock", ts: Date.now(), sig: "nope" })).ok).toBe(false);
  });

  it("goes offline (retained) on shutdown", async () => {
    agent.kill("SIGTERM");
    await new Promise((r) => agent.once("exit", r));
    await waitFor("offline", () => (last(topics.status(PC))?.payload === "offline" ? true : undefined), 5000);
  });
});
