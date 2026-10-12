// End-to-end smoke test: in-process MQTT broker (aedes) + the *bundled* agent in --mock mode.
//
//   pnpm --filter @homepanel/agent bundle && pnpm --filter @homepanel/agent smoke
//
// Checks: status online (retained), sensors, drives (retained), actions (retained), HA discovery,
// a correctly signed `echo` command → ok, bad signature / stale / replay / unknown action →
// rejected, and the LWT/graceful "offline" on shutdown.
import { Aedes } from "aedes";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";

const here = dirname(fileURLToPath(import.meta.url));
const agentJs = join(here, "..", "dist", "agent.cjs");
if (!existsSync(agentJs)) {
  console.error("dist/agent.cjs missing — run `pnpm bundle` first");
  process.exit(1);
}
const PC = "smoke-pc";
const KEY = "smoke-test-key-0123456789abcdef";
const T = (name) => `homepanel/agent/${PC}/${name}`;
const OVERALL_TIMEOUT = 30_000;

const failures = [];
const ok = (cond, what) => {
  console.log(`${cond ? "  ✔" : "  ✘"} ${what}`);
  if (!cond) failures.push(what);
};

const watchdog = setTimeout(() => {
  console.error(`smoke test timed out after ${OVERALL_TIMEOUT / 1000} s`);
  cleanup(1);
}, OVERALL_TIMEOUT);

// --- broker ---------------------------------------------------------------------------------
const broker = await Aedes.createBroker();
const server = createServer(broker.handle);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log(`aedes broker on 127.0.0.1:${port}`);

// --- config ---------------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "hp-smoke-"));
const cfgPath = join(dir, "agent.yaml");
writeFileSync(
  cfgPath,
  `pcId: ${PC}
name: Smoke PC
mqtt: { url: "mqtt://127.0.0.1:${port}" }
key: ${KEY}
publishIntervalMs: 500
actions:
  probe: { type: echo, label: Probe }
  lock: { type: system, op: lock }
  shutdown: { type: system, op: shutdown, guard: confirm+home-only }
`,
);

// --- observer -------------------------------------------------------------------------------
const seen = new Map(); // topic -> [{payload, retain}]
const observer = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: "smoke-observer" });
await new Promise((r) => observer.once("connect", r));
await observer.subscribeAsync(["homepanel/agent/#", "homeassistant/#"], { qos: 1 });
const waiters = [];
observer.on("message", (topic, payload, packet) => {
  const list = seen.get(topic) ?? [];
  list.push({ payload: payload.toString(), retain: packet.retain });
  seen.set(topic, list);
  for (const w of [...waiters]) if (w.match(topic, payload.toString())) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(payload.toString());
  }
});
const waitFor = (match, ms = 8000, label = "message", { freshOnly = false } = {}) =>
  new Promise((resolve, reject) => {
    if (!freshOnly) for (const [topic, list] of seen) for (const m of list) if (match(topic, m.payload)) return resolve(m.payload);
    const w = { match, resolve };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) {
        waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, ms);
  });

// --- agent ----------------------------------------------------------------------------------
const agent = spawn(process.execPath, [agentJs, "run", "--mock", "--config", cfgPath], { stdio: ["ignore", "pipe", "pipe"] });
let agentLog = "";
agent.stdout.on("data", (d) => (agentLog += d));
agent.stderr.on("data", (d) => (agentLog += d));

function cleanup(code) {
  clearTimeout(watchdog);
  try { agent.kill("SIGKILL"); } catch {}
  observer.end(true);
  broker.close(() => server.close());
  rmSync(dir, { recursive: true, force: true });
  if (code !== 0) console.error("\n--- agent log ---\n" + agentLog);
  setTimeout(() => process.exit(code), 200);
}

try {
  console.log("waiting for the agent...");
  const status = await waitFor((t, p) => t === T("status") && p === "online", 10_000, "status online");
  ok(status === "online", "status: online");

  const sensorsRaw = await waitFor((t) => t === T("sensors"), 5000, "sensors");
  const sensors = JSON.parse(sensorsRaw);
  ok(sensors.pc === PC && typeof sensors.ts === "number" && typeof sensors.hostname === "string", "sensors: envelope {ts, pc, hostname}");
  ok(sensors.sensors.some((s) => s.id === "cpu_package" && s.unit === "°C" && typeof s.value === "number"), "sensors: cpu_package °C");
  ok(sensors.sensors.every((s) => s.id && s.name && s.kind && s.unit !== undefined), "sensors: all have id/name/kind/unit");

  const drives = JSON.parse(await waitFor((t) => t === T("drives"), 5000, "drives"));
  ok(drives.pc === PC && drives.drives.length > 0 && drives.drives[0].letter === "C:", "drives: C: present");

  const actions = JSON.parse(await waitFor((t) => t === T("actions"), 5000, "actions"));
  const ids = actions.actions.map((a) => a.id);
  ok(ids.includes("probe") && ids.includes("lock") && ids.includes("shutdown"), `actions: ${ids.join(", ")}`);
  ok(actions.actions.find((a) => a.id === "shutdown")?.guard === "confirm+home-only", "actions: shutdown guarded");

  const disc = JSON.parse(
    await waitFor((t) => t === `homeassistant/sensor/homepanel_${PC}/cpu_package/config`, 5000, "HA discovery"),
  );
  ok(disc.unique_id === `homepanel_${PC}_cpu_package` && disc.state_topic === T("sensors") && disc.availability_topic === T("status"), "discovery: cpu_package config");
  ok(disc.device?.identifiers?.[0] === `homepanel_${PC}` && disc.device_class === "temperature", "discovery: device + device_class");
  await new Promise((r) => setTimeout(r, 300)); // let the rest of the discovery burst arrive
  const discTopics = [...seen.keys()].filter((t) => t.startsWith("homeassistant/"));
  ok(discTopics.length >= 5 && !discTopics.some((t) => t.includes("fan_2")), `discovery: ${discTopics.length} entities, fans excluded by default`);

  // late subscriber sees retained status/drives/actions/discovery
  const late = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: "smoke-late" });
  await new Promise((r) => late.once("connect", r));
  const retained = new Set();
  late.on("message", (t, _p, pkt) => pkt.retain && retained.add(t));
  await late.subscribeAsync(["homepanel/agent/#", "homeassistant/#"]);
  await new Promise((r) => setTimeout(r, 400));
  late.end(true);
  ok(retained.has(T("status")) && retained.has(T("drives")) && retained.has(T("actions")), "retained: status, drives, actions");
  ok(!retained.has(T("sensors")), "sensors are not retained");
  ok(retained.has(`homeassistant/sensor/homepanel_${PC}/cpu_package/config`), "retained: discovery config");

  // --- commands ---
  const signed = (action, over = {}) => {
    const c = { id: randomUUID(), action, ts: Date.now(), ...over };
    c.sig = createHmac("sha256", over.key ?? KEY).update(`${c.id}.${c.action}.${c.ts}`).digest("hex");
    delete c.key;
    return c;
  };
  const send = async (cmd) => {
    const res = waitFor((t, p) => t === T("cmd_result") && JSON.parse(p).id === cmd.id, 5000, `result for ${cmd.action}`, { freshOnly: true });
    await observer.publishAsync(T("cmd"), JSON.stringify(cmd), { qos: 1 });
    return JSON.parse(await res);
  };

  const good = signed("probe");
  const r1 = await send(good);
  ok(r1.ok === true, "signed echo command → ok");

  const r2 = await send(good);
  ok(r2.ok === false && /replay/.test(r2.error), `replayed command → rejected (${r2.error})`);

  const bad = { ...signed("probe"), sig: "0".repeat(64) };
  const r3 = await send(bad);
  ok(r3.ok === false && /signature/.test(r3.error), `bad signature → rejected (${r3.error})`);

  const wrongKey = signed("probe", { key: "some-other-key-0123456789" });
  const r4 = await send(wrongKey);
  ok(r4.ok === false && /signature/.test(r4.error), "wrong key → rejected");

  const stale = signed("probe", { ts: Date.now() - 60_000 });
  const r5 = await send(stale);
  ok(r5.ok === false && /stale/.test(r5.error), `stale ts → rejected (${r5.error})`);

  const unknown = signed("format-c");
  const r6 = await send(unknown);
  ok(r6.ok === false && /unknown action/.test(r6.error), `unknown action → rejected (${r6.error})`);

  const mockLock = await send(signed("lock"));
  ok(mockLock.ok === true && /\[mock\] would run action lock/.test(agentLog), "real action in --mock is only logged");

  // --- graceful shutdown → offline ---
  const offline = waitFor((t, p) => t === T("status") && p === "offline", 5000, "status offline");
  agent.kill("SIGTERM");
  ok((await offline) === "offline", "SIGTERM → status offline");

  // --- crash → LWT offline ---
  const agent2 = spawn(process.execPath, [agentJs, "run", "--mock", "--config", cfgPath], { stdio: "ignore" });
  await waitFor((t, p) => t === T("status") && p === "online" && seen.get(T("status")).filter((m) => m.payload === "online").length >= 2, 8000, "second online");
  const lwt = waitFor((t, p) => t === T("status") && p === "offline" && seen.get(T("status")).filter((m) => m.payload === "offline").length >= 2, 8000, "LWT offline");
  agent2.kill("SIGKILL");
  ok((await lwt) === "offline", "killed agent → LWT offline");
} catch (e) {
  ok(false, e.message);
}

console.log(failures.length ? `\nSMOKE FAILED (${failures.length})` : "\nSMOKE OK");
cleanup(failures.length ? 1 : 0);
