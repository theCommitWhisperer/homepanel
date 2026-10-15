/**
 * Control API behind the HomePanel window (UI-CONTRACT.md "Control API"): status of the pieces on
 * this PC, start/stop/restart (scheduled tasks, the mosquitto service), logs, agent.yaml editing
 * (validated with the agent's own schema), dry-run of buttons, opening things, update check.
 */
import { existsSync, openSync, readSync, closeSync, statSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { ActionDispatcher } from "../../../agent/src/actions/dispatcher.js";
import { planAction } from "../../../agent/src/actions/plan.js";
import { ConfigError, defaultLabel, parseConfig } from "../../../agent/src/config.js";
import { describeCommand, DryRunSpawner, NodeSpawner, type Spawner } from "../../../agent/src/exec.js";
import { parseLhm } from "../../../agent/src/sensors/lhm.js";
import { HaClient } from "../../../installer/src/ha/client.js";
import { ServerApi } from "../../../installer/src/local/api.js";
import { LHM_URL, stopTaskTree, TASK_AGENT, TASK_SENSORS, TASK_SERVER, TASK_TRAY, type LocalPaths } from "../../../installer/src/local/flow.js";
import { makeLocalCtx } from "../../../installer/src/local/modes.js";
import type { WinOps } from "../../../installer/src/local/ops.js";
import type { StateStore } from "../../../installer/src/state.js";
import { memoryOut, type Prompter } from "../../../installer/src/ui.js";

export const ITEMS = ["server", "agent", "sensors", "mosquitto", "tray", "ha"] as const;
export type ItemId = (typeof ITEMS)[number];
export type ItemState = "running" | "stopped" | "missing" | "error" | "unknown";
export type Op = "start" | "stop" | "restart";

export interface StatusItem {
  id: ItemId;
  label: string;
  state: ItemState;
  detail?: string;
  canStart?: boolean;
  canStop?: boolean;
  canRestart?: boolean;
}

export interface Status {
  version: string;
  role: "host" | "agent" | "ha-client" | "none";
  pcId?: string;
  serverUrl?: string;
  dashboardUrl?: string;
  adminUrl?: string;
  items: StatusItem[];
  sensors?: { ok: boolean; count: number; top: { name: string; value: number; unit: string }[] };
  agentOnline?: boolean;
}

export interface ControlDeps {
  version: string;
  ops: WinOps;
  paths: LocalPaths;
  localStore(): StateStore;
  haStore(): StateStore;
  fetchImpl: typeof fetch;
  /** open a URL or a folder for the signed-in user */
  open(target: string): Promise<void>;
  /** runs "Test → really"; DryRunSpawner in the fake world */
  spawner?: Spawner;
  sleep?(ms: number): Promise<void>;
  releasesApi?: string;
}

const noPrompt: Prompter = {
  input: async () => Promise.reject(new Error("no prompts here")),
  password: async () => Promise.reject(new Error("no prompts here")),
  confirm: async () => false,
  select: async () => Promise.reject(new Error("no prompts here")),
};

const TASK_OF: Partial<Record<ItemId, string>> = { server: TASK_SERVER, agent: TASK_AGENT, sensors: TASK_SENSORS, tray: TASK_TRAY };

function taskState(t: { exists: boolean; state?: string }): ItemState {
  if (!t.exists) return "missing";
  return /running/i.test(t.state ?? "") ? "running" : "stopped";
}

/** Last `n` lines of a text file, reading at most `maxBytes` from its end. */
export function tailFile(path: string, n: number, maxBytes = 512 * 1024): string[] {
  const size = statSync(path).size;
  const len = Math.min(size, maxBytes);
  const start = size - len;
  // read one byte more when cutting, to tell whether the first line is complete
  const from = start > 0 ? start - 1 : 0;
  const buf = Buffer.alloc(size - from);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, from);
  } finally {
    closeSync(fd);
  }
  let text = buf.toString("utf8");
  if (start > 0) text = text[0] === "\n" ? text.slice(1) : text.slice(text.indexOf("\n") + 1);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}

/** Pick a few headline temperatures (CPU package, GPU core, …) from LibreHardwareMonitor's tree. */
export function topSensors(root: unknown): { count: number; top: { name: string; value: number; unit: string }[] } {
  const all = parseLhm(root as never);
  const rank = (id: string) =>
    /^cpu\d*_(package|tctl|tdie|temp)/.test(id) ? 0 : /^gpu\d*_(core|temp|hotspot)/.test(id) ? 1 : /^cpu\d*_load|^cpu\d*_total/.test(id) ? 2 : /^nvme\d*_/.test(id) ? 3 : 9;
  const temps = all.filter((s) => !s.hiddenByDefault && (s.kind === "temperature" || /^cpu\d*_(load|total)/.test(s.id)));
  temps.sort((a, b) => rank(a.id) - rank(b.id));
  const seen = new Set<number>();
  const top = temps
    .filter((s) => {
      const r = rank(s.id);
      if (r < 9 && seen.has(r)) return false;
      seen.add(r);
      return true;
    })
    .slice(0, 4)
    .map((s) => ({ name: s.name, value: s.value, unit: s.unit }));
  return { count: all.length, top };
}

export class Control {
  constructor(private readonly d: ControlDeps) {}

  private localCtx() {
    return makeLocalCtx({ out: memoryOut(), prompt: noPrompt, yes: true, ops: this.d.ops, paths: this.d.paths, store: this.d.localStore(), fetchImpl: this.d.fetchImpl });
  }

  private sleep(ms: number) {
    return this.d.sleep ? this.d.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  /* ---------------- status ---------------- */

  async status(): Promise<Status> {
    const { ops } = this.d;
    const store = this.d.localStore();
    const ha = this.d.haStore();
    const l = store.state.local ?? {};
    const hosting = l.mode === "host" && !l.movedFrom;
    const role: Status["role"] = hosting ? "host" : l.mode === "join" ? "agent" : ha.state.haUrl ? "ha-client" : "none";
    const serverUrl = hosting ? "http://localhost:8080" : (l.serverUrl ?? ha.state.serverUrl);
    const token = store.secrets.deviceToken;
    const tokenForThis = token && (hosting ? !l.browserServer || /127\.0\.0\.1|localhost/.test(l.browserServer) : l.browserServer === l.serverUrl);
    const dashboardUrl = serverUrl ? `${serverUrl}${tokenForThis ? `/?token=${encodeURIComponent(token!)}` : ""}` : undefined;

    const [tServer, tAgent, tSensors, tTray, mq, lhm, health, agentStatus, haState] = await Promise.all([
      ops.taskInfo(TASK_SERVER).catch(() => ({ exists: false })),
      ops.taskInfo(TASK_AGENT).catch(() => ({ exists: false })),
      ops.taskInfo(TASK_SENSORS).catch(() => ({ exists: false })),
      ops.taskInfo(TASK_TRAY).catch(() => ({ exists: false })),
      ops.serviceInfo("mosquitto").catch(() => ({ exists: false, running: false, env: [] })),
      this.lhm(),
      hosting ? new ServerApi("http://127.0.0.1:8080", this.d.fetchImpl).health(2500) : Promise.resolve(undefined),
      this.agentStatus(),
      ha.state.haUrl ? new HaClient(ha.state.haUrl, { fetchImpl: this.d.fetchImpl }).onboardingStatus().catch(() => undefined) : Promise.resolve(undefined),
    ]);

    const items: StatusItem[] = [];
    if (hosting || tServer.exists) {
      let st = taskState(tServer);
      let detail = `Task "${TASK_SERVER}": ${tServer.exists ? ((tServer as { state?: string }).state ?? "?") : "missing"}`;
      if (health?.ok) {
        st = "running";
        detail = `Answers on port 8080 (v${health.version ?? "?"}, MQTT ${health.mqtt ?? "?"}, Home Assistant ${health.ha ?? "?"})`;
      } else if (st === "running") {
        st = "error";
        detail = "Task running, but the server does not answer on port 8080";
      }
      items.push({ id: "server", label: "HomePanel server", state: st, detail, canStart: st !== "running" && tServer.exists, canStop: st === "running" || st === "error", canRestart: tServer.exists });
    }
    {
      const st = taskState(tAgent);
      const detail = !tAgent.exists
        ? "Not installed (Host or Join this PC installs it)"
        : `${l.pcId ? `"${l.pcId}" ` : ""}${agentStatus === "online" ? "online" : agentStatus === "unknown" ? "status unknown" : agentStatus} on ${l.serverUrl ?? "?"}`;
      items.push({ id: "agent", label: "PC agent", state: st === "running" && agentStatus === "offline" ? "error" : st, detail, canStart: st === "stopped", canStop: st === "running", canRestart: tAgent.exists });
    }
    {
      const st: ItemState = lhm.ok ? "running" : tSensors.exists ? "stopped" : ops.platform === "win32" ? "missing" : "unknown";
      items.push({
        id: "sensors",
        label: "LibreHardwareMonitor",
        state: st,
        detail: lhm.ok ? `${lhm.count} sensors on port 8085` : tSensors.exists ? "Web server on port 8085 does not answer" : "Not installed",
        canStart: !lhm.ok && tSensors.exists,
        canStop: lhm.ok,
        canRestart: tSensors.exists,
      });
    }
    if (mq.exists || hosting)
      items.push({
        id: "mosquitto",
        label: "Mosquitto (MQTT)",
        state: !mq.exists ? "missing" : mq.running ? "running" : "stopped",
        detail: !mq.exists ? "Service not installed" : mq.running ? "Service running on port 1883" : hosting ? "Service stopped" : "Service stopped (not needed after moving to Home Assistant)",
        canStart: mq.exists && !mq.running,
        canStop: mq.exists && mq.running,
        canRestart: mq.exists,
      });
    {
      const st = taskState(tTray);
      items.push({ id: "tray", label: "Tray icon", state: st, detail: tTray.exists ? `Task "${TASK_TRAY}": ${(tTray as { state?: string }).state ?? "?"}` : "Not registered", canStart: st === "stopped", canStop: false, canRestart: false });
    }
    if (ha.state.haUrl)
      items.push({
        id: "ha",
        label: "Home Assistant",
        state: !haState || haState.state === "unreachable" ? "error" : haState.state === "onboarded" ? "running" : "stopped",
        detail: `${ha.state.haUrl}${haState ? ` — ${haState.state === "onboarded" ? "set up" : haState.state}` : ""}`,
      });

    return {
      version: this.d.version,
      role,
      ...(l.pcId ? { pcId: l.pcId } : {}),
      ...(serverUrl ? { serverUrl, adminUrl: `${serverUrl}/admin` } : {}),
      ...(dashboardUrl ? { dashboardUrl } : {}),
      items,
      sensors: { ok: lhm.ok, count: lhm.count, top: lhm.top },
      ...(agentStatus !== "unknown" && agentStatus !== "none" ? { agentOnline: agentStatus === "online" } : {}),
    };
  }

  async lhm(): Promise<{ ok: boolean; count: number; top: { name: string; value: number; unit: string }[] }> {
    try {
      const r = await this.d.fetchImpl(LHM_URL, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) return { ok: false, count: 0, top: [] };
      return { ok: true, ...topSensors(await r.json()) };
    } catch {
      return { ok: false, count: 0, top: [] };
    }
  }

  private async agentStatus(): Promise<"online" | "offline" | "never-seen" | "unregistered" | "unknown" | "none"> {
    const store = this.d.localStore();
    const l = store.state.local ?? {};
    if (!l.pcId || !l.serverUrl) return "none";
    const pw = store.secrets.adminPassword;
    if (!pw) return "unknown";
    try {
      const a = new ServerApi(l.serverUrl, this.d.fetchImpl);
      await a.login(pw);
      const me = (await a.agents()).find((x) => x.pcId === l.pcId);
      return me ? me.status : "unregistered";
    } catch {
      return "unknown";
    }
  }

  /* ---------------- actions ---------------- */

  async act(item: string, op: string): Promise<{ ok: boolean; error?: string }> {
    const { ops } = this.d;
    try {
      if (item === "network" && op === "private") {
        const r = await ops.setNetworkPrivate();
        return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}` };
      }
      if (!(ITEMS as readonly string[]).includes(item) || !["start", "stop", "restart"].includes(op)) return { ok: false, error: `Unknown action ${item}/${op}` };
      const it = item as ItemId;
      const o = op as Op;
      if (it === "ha") return { ok: false, error: "Home Assistant is controlled from Home Assistant itself." };
      if (it === "mosquitto") return this.mosquitto(o);
      const task = TASK_OF[it]!;
      if (!(await ops.taskInfo(task)).exists) return { ok: false, error: `The scheduled task "${task}" does not exist. Run setup to install it.` };
      if (o === "stop" || o === "restart") await this.stop(it, task);
      if (o === "start" || o === "restart") {
        if (o === "restart") await this.sleep(1000);
        const r = await ops.startTask(task);
        if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async stop(it: ItemId, task: string) {
    const { ops } = this.d;
    if (it === "server" || it === "agent") return stopTaskTree(this.localCtx(), task, it);
    await ops.stopTask(task);
    if (it === "sensors") await ops.stopProcess({ name: "LibreHardwareMonitor" });
    if (it === "tray") await ops.stopProcess({ commandLike: "* tray*" });
  }

  private async mosquitto(op: Op): Promise<{ ok: boolean; error?: string }> {
    const { ops } = this.d;
    if (!(await ops.serviceInfo("mosquitto")).exists) return { ok: false, error: "The mosquitto service is not installed." };
    const r =
      op === "stop"
        ? ops.platform === "win32"
          ? await ops.run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "sc.exe"), ["stop", "mosquitto"])
          : await ops.run("systemctl", ["stop", "mosquitto"])
        : await ops.restartService("mosquitto"); // Restart-Service also starts a stopped service
    // sc stop: 1062 = not started (fine)
    if (r.code !== 0 && !(op === "stop" && /1062/.test(r.stdout + r.stderr))) return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}` };
    return { ok: true };
  }

  /* ---------------- logs ---------------- */

  logFile(item: string): string | undefined {
    const { paths } = this.d;
    switch (item) {
      case "server":
        return join(paths.logsDir, "server.log");
      case "agent":
        return join(paths.logsDir, "agent.log");
      case "tray":
        return join(paths.logsDir, "tray.log");
      case "ui":
        return join(paths.logsDir, "ui.log");
      case "mosquitto":
        return join(paths.mosquittoDir, "mosquitto.log");
      default:
        return undefined;
    }
  }

  async logs(item: string, lines = 200): Promise<{ lines: string[]; file?: string }> {
    const n = Math.max(1, Math.min(5000, Math.floor(lines) || 200));
    if (item === "sensors") return { lines: ["LibreHardwareMonitor keeps no log file. Open it from the tray (^ next to the clock) to see its sensors."] };
    if (item === "ha") return { lines: ["Home Assistant's logs: Settings → System → Logs in Home Assistant."] };
    const file = this.logFile(item);
    if (!file) return { lines: [`No log for "${item}".`] };
    if (existsSync(file)) return { lines: tailFile(file, n), file };
    if (this.d.ops.platform === "linux" && (item === "server" || item === "agent" || item === "mosquitto")) {
      const unit = item === "mosquitto" ? "mosquitto" : `homepanel-${item}`;
      const r = await this.d.ops.run("journalctl", ["-u", unit, "-n", String(n), "--no-pager"], { timeoutMs: 10_000 });
      if (r.code === 0) return { lines: r.stdout.split("\n").filter(Boolean).slice(-n) };
    }
    return { lines: [`No log yet (${file}).`], file };
  }

  /* ---------------- agent.yaml ---------------- */

  getAgentConfig(): { path: string; yaml: string; actions: Record<string, unknown>[]; error?: string } {
    const path = this.d.paths.agentYaml;
    const yaml = existsSync(path) ? readFileSync(path, "utf8") : "";
    let raw: { actions?: Record<string, Record<string, unknown>> } | undefined;
    let error: string | undefined;
    try {
      raw = YAML.parse(yaml) ?? {};
      parseConfig(yaml, path);
    } catch (e) {
      error = e instanceof ConfigError ? e.message : (e as Error).message;
    }
    const actions = Object.entries(raw?.actions ?? {}).map(([id, def]) => ({ id, ...(def ?? {}), label: (def?.label as string | undefined) ?? defaultLabel(id) }));
    return { path, yaml, actions, ...(yaml ? {} : { error: `${path} does not exist yet (Host or Join this PC creates it).` }), ...(error && yaml ? { error } : {}) };
  }

  async putAgentConfig(yaml: string): Promise<{ ok: true; restarted: boolean; warning?: string } | { ok: false; errors: string[] }> {
    const path = this.d.paths.agentYaml;
    try {
      parseConfig(yaml, "agent.yaml");
    } catch (e) {
      return { ok: false, errors: e instanceof ConfigError && e.issues.length ? e.issues : [(e as Error).message] };
    }
    if (existsSync(path)) copyFileSync(path, `${path}.bak`);
    writeFileSync(path, yaml); // in place: keeps the file's ACL
    if (!(await this.d.ops.taskInfo(TASK_AGENT)).exists) return { ok: true, restarted: false, warning: `Saved. The "${TASK_AGENT}" task is not installed, so nothing was restarted.` };
    const r = await this.act("agent", "restart");
    return r.ok ? { ok: true, restarted: true } : { ok: true, restarted: false, warning: `Saved, but restarting the agent failed: ${r.error}` };
  }

  async testAction(id: string, really = false): Promise<{ ok: boolean; describe?: string; commands?: string[]; ran?: boolean; output?: string; error?: string }> {
    const path = this.d.paths.agentYaml;
    let cfg;
    try {
      cfg = parseConfig(readFileSync(path, "utf8"), path);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const def = Object.prototype.hasOwnProperty.call(cfg.actions, id) ? cfg.actions[id] : undefined;
    if (!def) return { ok: false, error: `No button "${id}" in agent.yaml (save your changes first).` };
    const ctx = { platform: this.d.ops.platform, env: process.env, configDir: dirname(path) };
    let plan;
    try {
      plan = planAction(def, ctx);
    } catch (e) {
      return { ok: false, error: `Cannot run: ${(e as Error).message}` };
    }
    const base = { describe: plan.describe, commands: plan.steps.map((s) => describeCommand(s)) };
    if (!really) return { ok: true, ...base, ran: false };
    const spawner = this.d.spawner ?? (this.d.ops.platform === "win32" ? new NodeSpawner() : new DryRunSpawner(() => undefined));
    const r = await new ActionDispatcher(cfg.actions, spawner, ctx).run(id);
    return { ...base, ok: r.ok, ran: true, ...(r.output ? { output: r.output } : {}), ...(r.error ? { error: r.error } : {}) };
  }

  /* ---------------- open / update ---------------- */

  async open(target: string): Promise<{ ok: boolean; error?: string; url?: string }> {
    const st = await this.status();
    const ha = this.d.haStore().state.haUrl;
    const url =
      target === "dashboard" ? st.dashboardUrl : target === "admin" ? st.adminUrl : target === "ha" ? ha : target === "logs-folder" ? this.d.paths.logsDir : undefined;
    if (!url) return { ok: false, error: target === "ha" ? "No Home Assistant address saved." : `Nothing to open for "${target}".` };
    await this.d.open(url);
    return { ok: true, url };
  }

  async updateCheck(): Promise<{ current: string; latest?: string; url?: string; newer?: boolean; error?: string }> {
    const current = this.d.version;
    try {
      const r = await this.d.fetchImpl(this.d.releasesApi ?? "https://api.github.com/repos/theCommitWhisperer/homepanel/releases/latest", {
        headers: { accept: "application/vnd.github+json", "user-agent": `HomePanel/${current}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return { current, error: `GitHub answered HTTP ${r.status}` };
      const j = (await r.json()) as { tag_name?: string; html_url?: string };
      const latest = (j.tag_name ?? "").replace(/^v/, "");
      return { current, ...(latest ? { latest, newer: newerVersion(latest, current) } : {}), ...(j.html_url ? { url: j.html_url } : {}) };
    } catch (e) {
      return { current, error: (e as Error).message };
    }
  }
}

/** a > b for x.y.z versions (pre-release suffixes ignored). */
export function newerVersion(a: string, b: string): boolean {
  const p = (v: string) => v.replace(/-.*$/, "").split(".").map((x) => Number(x) || 0);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
