/**
 * Local setup flows: "Host on this PC" (server + Mosquitto + LibreHardwareMonitor + this PC's agent)
 * and "Join this PC" (LibreHardwareMonitor + agent, talking to a server elsewhere).
 *
 * Every step is idempotent: detect() looks at the real system, and only when something is missing
 * does the step show the exact actions, ask (unless --yes), and run. Progress and secrets live in
 * the state store, so a second run reuses passwords and skips finished work.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { MQTT_PORT, SERVER_PORT } from "../constants.js";
import type { StateStore } from "../state.js";
import { randomPassword, showCmd } from "../sys.js";
import type { Out, Prompter } from "../ui.js";
import { color } from "../ui.js";
import { selfCommand } from "../runtime.js";
import { ServerApi } from "./api.js";
import {
  agentConnMatches,
  dotEnv,
  lhmConfigXml,
  lhmConfigured,
  mosquittoConf,
  patchAgentYaml,
  sanitizePcId,
  type AgentConn,
} from "./files.js";
import type { TaskSpec, WinOps } from "./ops.js";
import { firewallRulePs, icaclsArgs, loopingCmd, registerTaskPs, serviceEnvPs, winCmdLine } from "./ps.js";
import { beforeFromStep, hooks } from "../bridge/hooks.js";

export const LHM_ID = "LibreHardwareMonitor.LibreHardwareMonitor";
export const PAWNIO_ID = "namazso.PawnIO";
export const MOSQUITTO_ID = "EclipseFoundation.Mosquitto";
export const TASK_SERVER = "HomePanel Server";
export const TASK_AGENT = "HomePanel Agent";
export const TASK_SENSORS = "HomePanel Sensors";
export const TASK_TRAY = "HomePanel Tray";
export const MQTT_USER = "homepanel";
export const LHM_URL = "http://localhost:8085/data.json";

/* ------------------------------------------------------------------ */
/* context                                                              */
/* ------------------------------------------------------------------ */

export interface LocalPaths {
  /** %ProgramFiles%\HomePanel (null on Linux / when running from a checkout) */
  installDir: string | null;
  /** %ProgramFiles%\HomePanel\HomePanel.exe */
  exe: string | null;
  /** %ProgramData%\HomePanel  (Linux: /var/lib/homepanel) */
  dataRoot: string;
  /** server DATA_DIR */
  serverDir: string;
  agentYaml: string;
  logsDir: string;
  /** folder with mosquitto.conf (Windows: %ProgramData%\HomePanel\mosquitto) */
  mosquittoDir: string;
  mosquittoConf: string;
  mosquittoPasswd: string;
  /** setup-state.json + secrets.json for the local flows */
  setupDir: string;
}

export function defaultPaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): LocalPaths {
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pd = env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData";
    const root = join(pd, "HomePanel");
    const mq = join(root, "mosquitto");
    return {
      installDir: join(pf, "HomePanel"),
      exe: join(pf, "HomePanel", "HomePanel.exe"),
      dataRoot: root,
      serverDir: join(root, "server"),
      agentYaml: join(root, "agent.yaml"),
      logsDir: join(root, "logs"),
      mosquittoDir: mq,
      mosquittoConf: join(mq, "mosquitto.conf"),
      mosquittoPasswd: join(mq, "passwd"),
      setupDir: join(root, "setup"),
    };
  }
  const root = env.HOMEPANEL_DATA_ROOT || "/var/lib/homepanel";
  return {
    installDir: null,
    exe: null,
    dataRoot: root,
    serverDir: join(root, "server"),
    agentYaml: join(root, "agent.yaml"),
    logsDir: join(root, "logs"),
    mosquittoDir: "/etc/mosquitto/conf.d",
    mosquittoConf: "/etc/mosquitto/conf.d/homepanel.conf",
    mosquittoPasswd: "/etc/mosquitto/homepanel.passwd",
    setupDir: join(root, "setup"),
  };
}

export interface LocalCtx {
  out: Out;
  prompt: Prompter;
  store: StateStore;
  ops: WinOps;
  fetchImpl: typeof fetch;
  /** --yes: unattended, accept every question with its default */
  yes: boolean;
  /** "do all steps" chosen in the menu: no y/N per step, but still ask for names/passwords */
  confirmAll?: boolean;
  paths: LocalPaths;
  /** running as HomePanel.exe */
  sea: boolean;
  /** path of the running HomePanel.exe (SEA) */
  runningExe: string | null;
  repoRoot?: string;
  sleep(ms: number): Promise<void>;
  /** connect + disconnect to an MQTT broker; throws with the reason */
  mqttCheck(url: string, user: string, pass: string): Promise<void>;
  /** this PC's LAN address + MAC of the same adapter */
  net(): { ip?: string; mac?: string; hostname: string };
  /** poll budgets in ms */
  timeouts: { lhm: number; server: number; agent: number; pollMs: number };
  /** set by server-config when the running server must be restarted */
  restartServer?: boolean;
  restartAgent?: boolean;
}

export class FixError extends Error {
  constructor(
    message: string,
    readonly fix: string[] = [],
  ) {
    super(message);
    this.name = "FixError";
  }
}

export type LocalStatus = "done" | "skipped" | "failed" | "manual";

export interface LocalStep {
  id: string;
  title: string;
  /** one line: why this matters */
  why: string;
  detect(ctx: LocalCtx): Promise<{ done: boolean; detail: string }>;
  /** the exact actions, shown before asking */
  actions(ctx: LocalCtx): Promise<string[]>;
  /** throws FixError on failure; may return "manual" when something needs a click */
  run(ctx: LocalCtx): Promise<void | "manual">;
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

const isWin = (ctx: LocalCtx) => ctx.ops.platform === "win32";

function readText(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

function writeText(p: string, text: string, secret = false) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, secret ? { mode: 0o600 } : undefined);
}

async function poll(ctx: LocalCtx, budgetMs: number, test: () => Promise<boolean>, onTick?: (s: number) => void): Promise<boolean> {
  const n = Math.max(1, Math.ceil(budgetMs / ctx.timeouts.pollMs));
  const h = hooks();
  for (let i = 0; i < n; i++) {
    if (await test()) return true;
    if (onTick && i > 0 && i % 5 === 0) onTick(Math.round((i * ctx.timeouts.pollMs) / 1000));
    h.progress?.({ label: `Waiting… ${Math.round((i * ctx.timeouts.pollMs) / 1000)} s of ${Math.round(budgetMs / 1000)} s`, pct: Math.round((i / n) * 100) });
    await ctx.sleep(ctx.timeouts.pollMs);
  }
  return test();
}

async function httpOk(ctx: LocalCtx, url: string): Promise<boolean> {
  try {
    const r = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

function sha256(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** Stop the task and whatever its wrapper started (Stop-ScheduledTask ends cmd.exe, not always its child). */
export async function stopTaskTree(ctx: LocalCtx, task: string, sub: "server" | "agent") {
  await ctx.ops.stopTask(task);
  if (!isWin(ctx)) return;
  await ctx.ops.stopProcess({ name: "cmd.exe", commandLike: `*run-${sub}.cmd*` });
  const exe = installedExe(ctx);
  if (exe) await ctx.ops.stopProcess({ path: exe, commandLike: sub === "agent" ? "* agent run *" : "* server*" });
  else await ctx.ops.stopProcess({ name: "node.exe", commandLike: sub === "agent" ? "*homepanel-agent.mjs* run *" : "*server*dist*index.js*" });
}

/** The HomePanel.exe scheduled tasks should run (installed copy, else the running exe). */
export function installedExe(ctx: LocalCtx): string | null {
  if (!ctx.sea) return null;
  if (ctx.paths.exe && existsSync(ctx.paths.exe)) return ctx.paths.exe;
  return ctx.runningExe;
}

function self(ctx: LocalCtx, sub: "server" | "agent", args: string[]) {
  return selfCommand(installedExe(ctx), sub, args, { sea: ctx.sea, repoRoot: ctx.repoRoot });
}

function serverUrl(ctx: LocalCtx): string {
  return ctx.store.state.local?.serverUrl ?? `http://127.0.0.1:${SERVER_PORT}`;
}

async function api(ctx: LocalCtx): Promise<ServerApi> {
  const a = new ServerApi(serverUrl(ctx), ctx.fetchImpl);
  const pw = ctx.store.secrets.adminPassword;
  if (!pw) throw new FixError("The HomePanel admin password is not known yet.", ["Run the server step first (or, when joining, enter the admin password)."]);
  try {
    await a.login(pw);
  } catch (e) {
    throw new FixError(`Could not log in to HomePanel at ${a.url}: ${(e as Error).message}`, [
      `Check that the server is running: open ${a.url}/api/health in a browser.`,
      "If the admin password was changed, run setup again and type the current one.",
    ]);
  }
  return a;
}

/** Pick the adapter that most likely connects to the router (skips virtual / VPN adapters). */
export function primaryInterface(ifaces = networkInterfaces()): { ip?: string; mac?: string } {
  const virtual = /(vEthernet|Hyper-V|VirtualBox|VMware|WSL|Loopback|Tailscale|ZeroTier|docker|br-|veth|virbr|tun|tap|utun|Bluetooth)/i;
  const preferred = /^(Ethernet|eth|en|eno|enp|Wi-?Fi|WLAN|wl)/i;
  const list: { name: string; ip: string; mac: string }[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (virtual.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      list.push({ name, ip: a.address, mac: a.mac });
    }
  }
  list.sort((a, b) => Number(preferred.test(b.name)) - Number(preferred.test(a.name)));
  const p = list[0];
  if (!p) return {};
  const mac = p.mac && p.mac !== "00:00:00:00:00:00" ? p.mac.toUpperCase().replace(/-/g, ":") : undefined;
  return { ip: p.ip, ...(mac ? { mac } : {}) };
}

export async function realMqttCheck(url: string, username: string, password: string): Promise<void> {
  const mqtt = await import("mqtt");
  const client = await mqtt.connectAsync(url, { username, password, connectTimeout: 5000, reconnectPeriod: 0 });
  await client.endAsync();
}

/* ------------------------------------------------------------------ */
/* steps: program + LibreHardwareMonitor                                */
/* ------------------------------------------------------------------ */

export const installExeStep: LocalStep = {
  id: "program",
  title: "Install HomePanel.exe",
  why: "Scheduled tasks run a fixed copy in Program Files, not the file in Downloads.",
  async detect(ctx) {
    if (!ctx.sea || !ctx.paths.exe)
      return { done: true, detail: `Running from a source checkout; tasks will run node + ${ctx.repoRoot ?? "this checkout"}.` };
    const target = ctx.paths.exe;
    if (ctx.runningExe && ctx.runningExe.toLowerCase() === target.toLowerCase()) return { done: true, detail: `Running the installed copy (${target}).` };
    if (existsSync(target) && ctx.runningExe && statSync(target).size === statSync(ctx.runningExe).size && sha256(target) === sha256(ctx.runningExe))
      return { done: true, detail: `${target} is up to date.` };
    return { done: false, detail: existsSync(target) ? `${target} is a different version.` : `${target} is not there yet.` };
  },
  async actions(ctx) {
    return [`Stop the "${TASK_SERVER}" and "${TASK_AGENT}" tasks if they are running`, `Copy ${ctx.runningExe} → ${ctx.paths.exe}`];
  },
  async run(ctx) {
    const target = ctx.paths.exe!;
    await stopTaskTree(ctx, TASK_SERVER, "server");
    await stopTaskTree(ctx, TASK_AGENT, "agent");
    if (existsSync(target)) await ctx.ops.stopProcess({ path: target });
    mkdirSync(dirname(target), { recursive: true });
    try {
      copyFileSync(ctx.runningExe!, target);
    } catch (e) {
      throw new FixError(`Could not copy to ${target}: ${(e as Error).message}`, [
        "Another HomePanel window may still be running from Program Files. Close it (or end HomePanel.exe in Task Manager) and retry.",
      ]);
    }
  },
};

export const lhmInstallStep: LocalStep = {
  id: "lhm",
  title: "LibreHardwareMonitor",
  why: "Reads CPU/GPU temperatures, fans and power for the dashboard.",
  async detect(ctx) {
    const exe = await ctx.ops.findLhmExe();
    if (exe) {
      ctx.store.updateLocal({ lhmExe: exe });
      return { done: true, detail: `Found ${exe}` };
    }
    return { done: false, detail: "LibreHardwareMonitor is not installed." };
  },
  async actions(ctx) {
    return [showCmd(ctx.ops.installPackageCommand(LHM_ID, { scope: "machine" })[0]!, ctx.ops.installPackageCommand(LHM_ID, { scope: "machine" }).slice(1))];
  },
  async run(ctx) {
    let r = await ctx.ops.installPackage(LHM_ID, { scope: "machine" });
    if (r.code === 127) throw wingetMissing("LibreHardwareMonitor", "https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases");
    if (r.code !== 0) {
      ctx.out.info("Machine-wide install did not work; trying the default (per-user) install.");
      r = await ctx.ops.installPackage(LHM_ID);
    }
    const exe = await ctx.ops.findLhmExe();
    if (!exe)
      throw new FixError(`winget finished (exit ${r.code}) but LibreHardwareMonitor.exe was not found.`, [
        "Download LibreHardwareMonitor.zip from https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases",
        "Unzip it to C:\\Program Files\\LibreHardwareMonitor, then choose Retry.",
      ]);
    ctx.store.updateLocal({ lhmExe: exe });
  },
};

function wingetMissing(what: string, url: string): FixError {
  return new FixError("winget (Windows Package Manager) was not found.", [
    "Open Microsoft Store → search 'App Installer' → Update/Install, then choose Retry.",
    `Or install ${what} yourself from ${url} and choose Retry.`,
  ]);
}

export const pawnioStep: LocalStep = {
  id: "pawnio",
  title: "PawnIO driver",
  why: "The signed driver LibreHardwareMonitor uses to read CPU temperatures and fans.",
  async detect(ctx) {
    if ((await ctx.ops.serviceInfo("PawnIO")).exists || (await ctx.ops.packageInstalled(PAWNIO_ID)))
      return { done: true, detail: "PawnIO is installed." };
    return { done: false, detail: "PawnIO is not installed (LibreHardwareMonitor would ask for it on first start)." };
  },
  async actions(ctx) {
    const c = ctx.ops.installPackageCommand(PAWNIO_ID, { silent: true });
    return [showCmd(c[0]!, c.slice(1))];
  },
  async run(ctx) {
    const r = await ctx.ops.installPackage(PAWNIO_ID, { silent: true });
    if (r.code !== 0) {
      ctx.out.warn("PawnIO could not be installed silently.");
      ctx.out.info("No problem: when LibreHardwareMonitor starts it asks “PawnIO is not installed, do you want to install it?” — click OK.");
      return "manual";
    }
  },
};

function lhmConfigPath(exe: string): string {
  // MainForm.cs: Path.ChangeExtension(Application.ExecutablePath, ".config")
  return exe.replace(/\.exe$/i, "") + ".config";
}

export const lhmConfigStep: LocalStep = {
  id: "lhm-config",
  title: "LibreHardwareMonitor settings",
  why: "Turns on its web server (port 8085) and keeps it quietly in the tray.",
  async detect(ctx) {
    const exe = ctx.store.state.local?.lhmExe;
    if (!exe) return { done: false, detail: "LibreHardwareMonitor location unknown." };
    return lhmConfigured(readText(lhmConfigPath(exe)))
      ? { done: true, detail: "Web server on port 8085, start minimized, minimize to tray: already set." }
      : { done: false, detail: "Web server not enabled yet." };
  },
  async actions(ctx) {
    const exe = ctx.store.state.local?.lhmExe ?? "<LibreHardwareMonitor.exe>";
    return [
      "Close LibreHardwareMonitor if it is running (it rewrites its settings when it exits)",
      `Set in ${lhmConfigPath(exe)}: runWebServerMenuItem=true, listenerPort=8085, startMinMenuItem=true, minTrayMenuItem=true, minCloseMenuItem=true (other settings kept)`,
    ];
  },
  async run(ctx) {
    const exe = ctx.store.state.local?.lhmExe;
    if (!exe) throw new FixError("LibreHardwareMonitor was not found.", ["Run the LibreHardwareMonitor step first."]);
    if (await ctx.ops.processRunning("LibreHardwareMonitor")) await ctx.ops.stopProcess({ name: "LibreHardwareMonitor" });
    const p = lhmConfigPath(exe);
    try {
      writeText(p, lhmConfigXml(readText(p)));
    } catch (e) {
      throw new FixError(`Could not write ${p}: ${(e as Error).message}`, ["Make sure setup runs as administrator, then retry."]);
    }
  },
};

export const sensorsTaskStep: LocalStep = {
  id: "sensors-task",
  title: `Start LibreHardwareMonitor at logon ("${TASK_SENSORS}")`,
  why: "So temperatures are there after every reboot, without clicking anything.",
  async detect(ctx) {
    const exe = ctx.store.state.local?.lhmExe;
    const t = await ctx.ops.taskInfo(TASK_SENSORS);
    const up = await httpOk(ctx, LHM_URL);
    if (t.exists && (!exe || !t.file || t.file.toLowerCase() === exe.toLowerCase()) && up)
      return { done: true, detail: `Task registered and ${LHM_URL} answers.` };
    return { done: false, detail: !t.exists ? "Task not registered yet." : up ? "Task points at another LibreHardwareMonitor.exe." : `${LHM_URL} does not answer.` };
  },
  async actions(ctx) {
    const user = await ctx.ops.interactiveUser();
    return [
      `Register scheduled task "${TASK_SENSORS}": at logon of ${user}, run elevated: ${ctx.store.state.local?.lhmExe ?? "LibreHardwareMonitor.exe"}`,
      "Start it now and wait for http://localhost:8085/data.json (up to 60 s)",
    ];
  },
  async run(ctx) {
    const exe = ctx.store.state.local?.lhmExe;
    if (!exe) throw new FixError("LibreHardwareMonitor was not found.", ["Run the LibreHardwareMonitor step first."]);
    const user = await ctx.ops.interactiveUser();
    const spec: TaskSpec = {
      name: TASK_SENSORS,
      description: "HomePanel: starts LibreHardwareMonitor (minimized, web server on port 8085) so the dashboard gets temperatures.",
      file: exe,
      args: [],
      workingDir: dirname(exe),
      trigger: "logon",
      user,
      delayS: 5,
    };
    const r = await ctx.ops.registerTask(spec);
    if (r.code !== 0) throw new FixError(`Could not register the task: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, ["Run setup as administrator and retry."]);
    if (!(await httpOk(ctx, LHM_URL))) {
      if (await ctx.ops.processRunning("LibreHardwareMonitor")) await ctx.ops.stopProcess({ name: "LibreHardwareMonitor" });
      await ctx.ops.startTask(TASK_SENSORS);
    }
    ctx.out.info("Waiting for LibreHardwareMonitor's web server… (if a “PawnIO is not installed” box appears, click OK)");
    const okUp = await poll(ctx, ctx.timeouts.lhm, () => httpOk(ctx, LHM_URL), (s) => ctx.out.info(`still waiting (${s} s)…`));
    if (!okUp)
      throw new FixError(`${LHM_URL} did not answer within ${Math.round(ctx.timeouts.lhm / 1000)} s.`, [
        "Look for the LibreHardwareMonitor icon in the tray (^ next to the clock). If it is not there, start it from the Start menu.",
        "If it shows a “PawnIO is not installed” or “outdated” box, click OK and wait for the driver install.",
        "In LibreHardwareMonitor: Options → Remote Web Server → Run must be ticked; Port must be 8085.",
        "Another program may use port 8085: in PowerShell run  netstat -ano | findstr :8085",
        "Then choose Retry. (The dashboard still shows CPU load and memory without it.)",
      ]);
  },
};

/* ------------------------------------------------------------------ */
/* steps: Mosquitto + firewall                                          */
/* ------------------------------------------------------------------ */

function mqttPassword(ctx: LocalCtx): string {
  if (!ctx.store.secrets.mqttPassword) ctx.store.setSecret("mqttPassword", randomPassword(24));
  return ctx.store.secrets.mqttPassword!;
}

export const mosquittoInstallStep: LocalStep = {
  id: "mosquitto",
  title: "Mosquitto MQTT broker",
  why: "PC agents send temperatures and receive button presses through it.",
  async detect(ctx) {
    const d = await ctx.ops.findMosquittoDir();
    if (d) {
      ctx.store.updateLocal({ mosquittoDir: d });
      return { done: true, detail: `Found Mosquitto in ${d}` };
    }
    return { done: false, detail: "Mosquitto is not installed." };
  },
  async actions(ctx) {
    const c = ctx.ops.installPackageCommand(MOSQUITTO_ID, { silent: true });
    return [showCmd(c[0]!, c.slice(1))];
  },
  async run(ctx) {
    const r = await ctx.ops.installPackage(MOSQUITTO_ID, { silent: true });
    if (r.code === 127) throw isWin(ctx) ? wingetMissing("Mosquitto", "https://mosquitto.org/download/") : new FixError("apt-get not found.", ["Install mosquitto with your package manager, then retry."]);
    const d = await ctx.ops.findMosquittoDir();
    if (!d)
      throw new FixError(`The install finished (exit ${r.code}) but mosquitto was not found.`, [
        isWin(ctx) ? "Install it from https://mosquitto.org/download/ (64-bit .exe, keep the 'Service' option ticked), then retry." : "sudo apt-get install mosquitto mosquitto-clients, then retry.",
      ]);
    ctx.store.updateLocal({ mosquittoDir: d });
  },
};

function expectedMosquittoConf(ctx: LocalCtx): string {
  return mosquittoConf({
    passwordFile: ctx.paths.mosquittoPasswd,
    ...(isWin(ctx) ? { logFile: join(ctx.paths.mosquittoDir, "mosquitto.log") } : {}),
  });
}

async function mqttWorks(ctx: LocalCtx, host = "127.0.0.1"): Promise<string | undefined> {
  const pass = ctx.store.secrets.mqttPassword;
  if (!pass) return "no password yet";
  try {
    await ctx.mqttCheck(`mqtt://${host}:${MQTT_PORT}`, MQTT_USER, pass);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

export const mosquittoConfigStep: LocalStep = {
  id: "mosquitto-config",
  title: "Mosquitto: login + config",
  why: "Only HomePanel's user may connect; listens on the LAN so other PCs can join.",
  async detect(ctx) {
    if (readText(ctx.paths.mosquittoConf) !== expectedMosquittoConf(ctx) || !existsSync(ctx.paths.mosquittoPasswd))
      return { done: false, detail: `${ctx.paths.mosquittoConf} not written yet.` };
    if (isWin(ctx)) {
      const s = await ctx.ops.serviceInfo("mosquitto");
      if (!s.exists || !s.env.some((e) => e.toLowerCase() === `mosquitto_dir=${ctx.paths.mosquittoDir}`.toLowerCase()))
        return { done: false, detail: "The mosquitto service does not use HomePanel's config yet." };
    }
    const err = await mqttWorks(ctx);
    return err ? { done: false, detail: `MQTT login test failed: ${err}` } : { done: true, detail: "Broker answers and accepts the homepanel login." };
  },
  async actions(ctx) {
    const dir = ctx.store.state.local?.mosquittoDir ?? "<mosquitto folder>";
    const passwd = isWin(ctx) ? join(dir, "mosquitto_passwd.exe") : "mosquitto_passwd";
    const a = [
      `Write ${ctx.paths.mosquittoConf}: listener 1883 0.0.0.0, allow_anonymous false, password_file ${ctx.paths.mosquittoPasswd}`,
      `${showCmd(passwd, ["-c", "-b", ctx.paths.mosquittoPasswd, MQTT_USER, "<generated password>"])}`,
    ];
    if (isWin(ctx)) {
      a.push(`If the service is missing: ${showCmd(join(dir, "mosquitto.exe"), ["install"])}`);
      a.push(`Give the "mosquitto" service its own MOSQUITTO_DIR (it then reads ${ctx.paths.mosquittoConf}):\n${serviceEnvPs("mosquitto", { MOSQUITTO_DIR: ctx.paths.mosquittoDir })}`);
      a.push(`Restrict ${ctx.paths.mosquittoDir} to SYSTEM + Administrators (icacls)`);
    }
    a.push("Restart the mosquitto service and test a login on 127.0.0.1:1883");
    return a;
  },
  async run(ctx) {
    const dir = ctx.store.state.local?.mosquittoDir ?? (await ctx.ops.findMosquittoDir());
    if (!dir) throw new FixError("Mosquitto is not installed.", ["Run the Mosquitto step first."]);
    const pass = mqttPassword(ctx);
    try {
      writeText(ctx.paths.mosquittoConf, expectedMosquittoConf(ctx));
    } catch (e) {
      throw new FixError(`Could not write ${ctx.paths.mosquittoConf}: ${(e as Error).message}`, ["Run setup as administrator, then retry."]);
    }
    const pw = await ctx.ops.run(isWin(ctx) ? join(dir, "mosquitto_passwd.exe") : "mosquitto_passwd", ["-c", "-b", ctx.paths.mosquittoPasswd, MQTT_USER, pass]);
    if (pw.code !== 0) throw new FixError(`mosquitto_passwd failed: ${(pw.stderr || pw.stdout).trim().slice(0, 300)}`, ["Reinstall Mosquitto, then retry."]);
    if (isWin(ctx)) {
      await ctx.ops.restrictAcl(ctx.paths.mosquittoDir, { dir: true });
      if (!(await ctx.ops.serviceInfo("mosquitto")).exists) {
        const i = await ctx.ops.run(join(dir, "mosquitto.exe"), ["install"]);
        if (i.code !== 0) throw new FixError(`"mosquitto install" failed: ${i.stderr.trim().slice(0, 200)}`, ["Run setup as administrator, then retry."]);
      }
      const e = await ctx.ops.setServiceEnv("mosquitto", { MOSQUITTO_DIR: ctx.paths.mosquittoDir });
      if (e.code !== 0) throw new FixError(`Could not configure the mosquitto service: ${e.stderr.trim().slice(0, 300)}`, ["Run setup as administrator, then retry."]);
    } else {
      await ctx.ops.run("chgrp", ["mosquitto", ctx.paths.mosquittoPasswd]);
      await ctx.ops.run("chmod", ["640", ctx.paths.mosquittoPasswd]);
    }
    const rs = await ctx.ops.restartService("mosquitto");
    if (rs.code !== 0) ctx.out.warn(`Restarting mosquitto said: ${(rs.stderr || rs.stdout).trim().slice(0, 200)}`);
    let err: string | undefined;
    const okUp = await poll(ctx, 10_000, async () => !(err = await mqttWorks(ctx)));
    if (!okUp)
      throw new FixError(`Could not log in to Mosquitto on 127.0.0.1:1883: ${err}`, [
        isWin(ctx) ? `Look at ${join(ctx.paths.mosquittoDir, "mosquitto.log")} and at Services → Mosquitto Broker (must be Running).` : "journalctl -u mosquitto -n 50",
        "Another broker may already use port 1883:  netstat -ano | findstr :1883",
        "Then choose Retry.",
      ]);
    ctx.restartServer = true;
  },
};

export const FW_RULES = [
  { name: "HomePanel-Server-TCP-8080", displayName: "HomePanel server (TCP 8080)", port: SERVER_PORT, profile: "Private" as const },
  { name: "HomePanel-MQTT-TCP-1883", displayName: "HomePanel MQTT broker (TCP 1883)", port: MQTT_PORT, profile: "Private" as const },
];

export const firewallStep: LocalStep = {
  id: "firewall",
  title: "Windows Firewall",
  why: "Lets tablets reach the dashboard (8080) and other PCs reach MQTT (1883) — home network only.",
  async detect(ctx) {
    const missing = [];
    for (const r of FW_RULES) if (!(await ctx.ops.firewallRuleExists(r.name))) missing.push(r.port);
    const cat = await ctx.ops.networkCategory();
    if (missing.length) return { done: false, detail: `No firewall rule yet for port ${missing.join(" and ")}.` };
    if (/public/i.test(cat)) return { done: false, detail: "Rules exist, but this network is set to Public, so they don't apply." };
    return { done: true, detail: "Ports 8080 and 1883 are open on the private (home) network." };
  },
  async actions() {
    return FW_RULES.map((r) => firewallRulePs(r).split("\n").slice(1).join("\n"));
  },
  async run(ctx) {
    for (const r of FW_RULES) {
      const x = await ctx.ops.addFirewallRule(r);
      if (x.code !== 0) throw new FixError(`Could not add firewall rule ${r.name}: ${x.stderr.trim().slice(0, 300)}`, ["Run setup as administrator, then retry."]);
    }
    const cat = await ctx.ops.networkCategory();
    if (/public/i.test(cat)) {
      ctx.out.warn("Windows treats this network as Public, so tablets can't reach the dashboard.");
      ctx.out.info("Fix: mark it Private (Settings → Network & internet → your connection → Private network). The command:");
      ctx.out.code("Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' } | Set-NetConnectionProfile -NetworkCategory Private");
      if (ctx.yes || ctx.confirmAll || (await ctx.prompt.confirm({ message: "Mark this (home) network as Private now?", default: false }))) {
        const r = await ctx.ops.setNetworkPrivate();
        if (r.code !== 0) ctx.out.warn(`That did not work: ${r.stderr.trim().slice(0, 200)}`);
      } else return "manual";
    }
  },
};

/* ------------------------------------------------------------------ */
/* steps: server                                                        */
/* ------------------------------------------------------------------ */

function parseEnvFile(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2]!.trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0]!)) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

function serverEnvVars(ctx: LocalCtx): Record<string, string> {
  return {
    MQTT_URL: `mqtt://127.0.0.1:${MQTT_PORT}`,
    MQTT_USER: MQTT_USER,
    MQTT_PASS: ctx.store.secrets.mqttPassword ?? "",
    ADMIN_PASSWORD: ctx.store.secrets.adminPassword ?? "",
  };
}

const serverEnvPath = (ctx: LocalCtx) => join(ctx.paths.serverDir, ".env");
const serverCmdPath = (ctx: LocalCtx) => join(ctx.paths.serverDir, "run-server.cmd");
const agentCmdPath = (ctx: LocalCtx) => join(ctx.paths.dataRoot, "run-agent.cmd");

function serverWrapper(ctx: LocalCtx): string {
  const c = self(ctx, "server", []);
  return loopingCmd({
    title: "HomePanel server",
    env: { DATA_DIR: ctx.paths.serverDir },
    file: c.file,
    args: c.args,
    log: join(ctx.paths.logsDir, "server.log"),
  });
}

function serverTask(ctx: LocalCtx): TaskSpec {
  const c = self(ctx, "server", []);
  if (isWin(ctx))
    return {
      name: TASK_SERVER,
      description: "HomePanel server (dashboard on port 8080). Settings: " + serverEnvPath(ctx),
      file: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
      args: ["/c", serverCmdPath(ctx)],
      workingDir: ctx.paths.serverDir,
      trigger: "startup",
    };
  return { name: TASK_SERVER, description: "HomePanel server", file: c.file, args: c.args, workingDir: ctx.paths.serverDir, trigger: "startup", env: { DATA_DIR: ctx.paths.serverDir } };
}

async function ensureAdminPassword(ctx: LocalCtx) {
  if (ctx.store.secrets.adminPassword) return;
  let how: "gen" | "type" = "gen";
  if (!ctx.yes)
    how = await ctx.prompt.select<"gen" | "type">({
      message: "Password for the HomePanel admin page (pairing screens, editing layouts):",
      choices: [
        { value: "gen", name: "Make one up for me (shown at the end and saved in the setup folder)" },
        { value: "type", name: "I'll type my own" },
      ],
    });
  let pw: string;
  if (how === "type") {
    for (;;) {
      pw = await ctx.prompt.password({
        message: "Admin password (hidden):",
        validate: (v) => (v.length < 6 ? "At least 6 characters" : /["\\\r\n]/.test(v) ? "No quotes or backslashes, please" : true),
      });
      const again = await ctx.prompt.password({ message: "Again:" });
      if (again === pw) break;
      ctx.out.warn("They don't match, try again.");
    }
  } else {
    pw = randomPassword(16);
    ctx.out.ok(`Admin password: ${color.bold(pw)}   (also shown at the end)`);
  }
  ctx.store.setSecret("adminPassword", pw);
}

export const serverConfigStep: LocalStep = {
  id: "server-config",
  title: "HomePanel server settings",
  why: "MQTT login + admin password for the server, readable only by administrators.",
  async detect(ctx) {
    const cur = parseEnvFile(readText(serverEnvPath(ctx)));
    const want = serverEnvVars(ctx);
    if (!ctx.store.secrets.adminPassword || !ctx.store.secrets.mqttPassword) return { done: false, detail: "Server settings not written yet." };
    const same = Object.entries(want).every(([k, v]) => cur[k] === v);
    if (!same) return { done: false, detail: `${serverEnvPath(ctx)} missing or out of date.` };
    if (isWin(ctx) && readText(serverCmdPath(ctx)) !== serverWrapper(ctx)) return { done: false, detail: `${serverCmdPath(ctx)} missing or out of date.` };
    return { done: true, detail: `${serverEnvPath(ctx)} is up to date.` };
  },
  async actions(ctx) {
    const a = [
      `Write ${serverEnvPath(ctx)}: MQTT_URL=mqtt://127.0.0.1:1883, MQTT_USER=homepanel, MQTT_PASS=<hidden>, ADMIN_PASSWORD=<${ctx.store.secrets.adminPassword ? "saved" : "you choose"}> (other lines kept)`,
    ];
    if (isWin(ctx)) {
      a.push(`Write ${serverCmdPath(ctx)} (sets DATA_DIR=${ctx.paths.serverDir}, runs ${winCmdLine([self(ctx, "server", []).file, ...self(ctx, "server", []).args])}, restarts it if it stops, log in ${ctx.paths.logsDir})`);
      a.push(`icacls ${winCmdLine(icaclsArgs(ctx.paths.serverDir, { dir: true }))}`);
    } else a.push(`chmod 700 ${ctx.paths.serverDir}`);
    return a;
  },
  async run(ctx) {
    mqttPassword(ctx);
    await ensureAdminPassword(ctx);
    const existing = parseEnvFile(readText(serverEnvPath(ctx)));
    mkdirSync(ctx.paths.serverDir, { recursive: true });
    mkdirSync(ctx.paths.logsDir, { recursive: true });
    writeText(serverEnvPath(ctx), dotEnv({ ...existing, ...serverEnvVars(ctx) }), true);
    if (isWin(ctx)) writeText(serverCmdPath(ctx), serverWrapper(ctx));
    const acl = await ctx.ops.restrictAcl(ctx.paths.serverDir, { dir: true });
    if (acl.code !== 0) ctx.out.warn(`Could not restrict ${ctx.paths.serverDir}: ${acl.stderr.trim().slice(0, 200)}`);
    ctx.restartServer = true;
  },
};

export const serverTaskStep: LocalStep = {
  id: "server",
  title: `Run the server at startup ("${TASK_SERVER}")`,
  why: "The dashboard runs in the background, even before anyone logs in.",
  async detect(ctx) {
    const t = await ctx.ops.taskInfo(TASK_SERVER);
    if (!t.exists) return { done: false, detail: "Task not registered yet." };
    if (ctx.restartServer) return { done: false, detail: "Settings changed; the server needs a restart." };
    const h = await new ServerApi(serverUrl(ctx), ctx.fetchImpl).health();
    return h?.ok ? { done: true, detail: `Server answers at ${serverUrl(ctx)} (v${h.version ?? "?"}).` } : { done: false, detail: "Task registered but the server does not answer." };
  },
  async actions(ctx) {
    const t = serverTask(ctx);
    return [
      isWin(ctx)
        ? `Register scheduled task "${TASK_SERVER}": at startup, as SYSTEM, no time limit, restart every 1 min on failure:\n${registerTaskPs(t)}`
        : `Write /etc/systemd/system/homepanel-server.service (DATA_DIR=${ctx.paths.serverDir}) and enable it`,
      `Start it and wait for ${serverUrl(ctx)}/api/health (up to ${Math.round(ctx.timeouts.server / 1000)} s)`,
    ];
  },
  async run(ctx) {
    const t = serverTask(ctx);
    const r = await ctx.ops.registerTask(t);
    if (r.code !== 0) throw new FixError(`Could not register "${TASK_SERVER}": ${(r.stderr || r.stdout).trim().slice(0, 300)}`, ["Run setup as administrator, then retry."]);
    const info = await ctx.ops.taskInfo(TASK_SERVER);
    if (info.state && /running/i.test(info.state)) {
      await stopTaskTree(ctx, TASK_SERVER, "server");
      await ctx.sleep(1000);
    }
    await ctx.ops.startTask(TASK_SERVER);
    const s = new ServerApi(serverUrl(ctx), ctx.fetchImpl);
    ctx.out.info(`Waiting for ${s.url}/api/health …`);
    const up = await poll(ctx, ctx.timeouts.server, async () => !!(await s.health())?.ok, (x) => ctx.out.info(`still waiting (${x} s)…`));
    if (!up)
      throw new FixError(`The server did not answer within ${Math.round(ctx.timeouts.server / 1000)} s.`, [
        isWin(ctx) ? `Read the log: ${join(ctx.paths.logsDir, "server.log")}` : "journalctl -u homepanel-server -n 80",
        "Port 8080 may be used by another program:  netstat -ano | findstr :8080",
        isWin(ctx) ? `Try it by hand in a terminal:  set DATA_DIR=${ctx.paths.serverDir}  then  ${winCmdLine([self(ctx, "server", []).file, ...self(ctx, "server", []).args])}` : "",
        "Then choose Retry.",
      ].filter(Boolean));
    ctx.restartServer = false;
  },
};

/* ------------------------------------------------------------------ */
/* steps: this PC's agent                                               */
/* ------------------------------------------------------------------ */

function mqttHost(ctx: LocalCtx): string {
  return ctx.store.state.local?.mqttHost ?? "127.0.0.1";
}

function wantedConn(ctx: LocalCtx): AgentConn | undefined {
  const l = ctx.store.state.local;
  const key = ctx.store.secrets.agentKey;
  const pass = ctx.store.secrets.mqttPassword;
  if (!l?.pcId || !key || !pass) return undefined;
  return {
    pcId: l.pcId,
    name: l.pcName,
    mqttUrl: `mqtt://${mqttHost(ctx)}:${MQTT_PORT}`,
    mqttUser: l.mqttUser ?? MQTT_USER,
    mqttPass: pass,
    key,
  };
}

async function choosePc(ctx: LocalCtx) {
  const l = ctx.store.state.local ?? {};
  if (l.pcId) return;
  const def = l.mode === "host" ? "gaming-pc" : sanitizePcId(ctx.net().hostname);
  let pcId = def;
  let name = def === "gaming-pc" ? "Gaming PC" : ctx.net().hostname;
  if (!ctx.yes) {
    pcId = (
      await ctx.prompt.input({
        message: `Short id for this PC (lowercase; the example dashboard expects "gaming-pc"):`,
        default: def,
        validate: (v) => (/^[a-z0-9][a-z0-9-]{0,47}$/.test(v.trim()) ? true : "lowercase letters, digits and dashes"),
      })
    ).trim();
    name = (await ctx.prompt.input({ message: "Display name:", default: pcId === "gaming-pc" ? "Gaming PC" : name })).trim() || pcId;
  }
  ctx.store.updateLocal({ pcId, pcName: name });
}

export const agentConfigStep: LocalStep = {
  id: "agent-config",
  title: "Register this PC + write agent.yaml",
  why: "Gives this PC its signing key and the suggested buttons (open drives, Steam, media keys…).",
  async detect(ctx) {
    const want = wantedConn(ctx);
    if (!want) return { done: false, detail: "This PC is not registered yet." };
    if (!agentConnMatches(readText(ctx.paths.agentYaml), want)) return { done: false, detail: `${ctx.paths.agentYaml} missing or out of date.` };
    try {
      const a = await api(ctx);
      if (!(await a.agents()).some((x) => x.pcId === want.pcId)) return { done: false, detail: `The server does not know "${want.pcId}" yet.` };
    } catch (e) {
      return { done: false, detail: (e as Error).message };
    }
    return { done: true, detail: `${ctx.paths.agentYaml} is set up for "${want.pcId}".` };
  },
  async actions(ctx) {
    const l = ctx.store.state.local;
    const mac = ctx.net().mac;
    const init = self(ctx, "agent", ["init", "--config", ctx.paths.agentYaml, "--pc-id", l?.pcId ?? "<id>", "--mqtt-url", `mqtt://${mqttHost(ctx)}:1883`, "--mqtt-user", MQTT_USER]);
    return [
      `POST ${serverUrl(ctx)}/api/admin/agents {pcId: "${l?.pcId ?? "<you choose>"}", name${mac ? `, mac: "${mac}" (Wake-on-LAN)` : ""}} → signing key`,
      existsSync(ctx.paths.agentYaml)
        ? `Update the connection lines in ${ctx.paths.agentYaml} (your buttons are kept)`
        : `${showCmd(init.file, init.args)}   (MQTT password + key passed via environment)`,
      isWin(ctx) ? `Restrict ${ctx.paths.agentYaml} to SYSTEM, Administrators and ${await ctx.ops.interactiveUser()}` : `chmod 600 ${ctx.paths.agentYaml}`,
    ];
  },
  async run(ctx) {
    await choosePc(ctx);
    const l = ctx.store.state.local!;
    const a = await api(ctx);
    const mac = ctx.net().mac;
    let key: string;
    try {
      key = (await a.registerAgent({ pcId: l.pcId!, name: l.pcName ?? l.pcId!, ...(mac ? { mac } : {}) })).key;
    } catch (e) {
      throw new FixError(`Registering "${l.pcId}" failed: ${(e as Error).message}`, ["Check the server is running, then retry."]);
    }
    ctx.store.setSecret("agentKey", key);
    const want = wantedConn(ctx)!;
    const existing = readText(ctx.paths.agentYaml);
    if (existing) {
      writeText(ctx.paths.agentYaml, patchAgentYaml(existing, want), true);
    } else {
      const c = self(ctx, "agent", ["init", "--config", ctx.paths.agentYaml, "--pc-id", want.pcId, "--mqtt-url", want.mqttUrl, "--mqtt-user", want.mqttUser]);
      const r = await ctx.ops.run(c.file, c.args, {
        env: { HOMEPANEL_INIT_MQTT_PASS: want.mqttPass, HOMEPANEL_INIT_KEY: want.key, HOMEPANEL_INIT_NAME: want.name ?? want.pcId },
        timeoutMs: 60_000,
      });
      if (r.code !== 0 || !existsSync(ctx.paths.agentYaml))
        throw new FixError(`"agent init" failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, ["Retry; if it keeps failing, report the message above."]);
    }
    const chk = self(ctx, "agent", ["check-config", "--config", ctx.paths.agentYaml]);
    const cc = await ctx.ops.run(chk.file, chk.args, { timeoutMs: 60_000 });
    if (cc.code !== 0) throw new FixError(`agent.yaml check failed: ${(cc.stderr || cc.stdout).trim().slice(0, 400)}`, [`Fix ${ctx.paths.agentYaml} (notepad), then retry.`]);
    const user = isWin(ctx) ? await ctx.ops.interactiveUser() : undefined;
    await ctx.ops.restrictAcl(ctx.paths.agentYaml, { dir: false, ...(user ? { user } : {}) });
    ctx.restartAgent = true;
  },
};

function agentWrapper(ctx: LocalCtx): string {
  const c = self(ctx, "agent", ["run", "--config", ctx.paths.agentYaml]);
  return loopingCmd({ title: "HomePanel PC agent", file: c.file, args: c.args, log: join(ctx.paths.logsDir, "agent.log"), delayS: 10 });
}

async function agentTask(ctx: LocalCtx): Promise<TaskSpec> {
  const user = await ctx.ops.interactiveUser();
  if (isWin(ctx))
    return {
      name: TASK_AGENT,
      description: "HomePanel PC agent: sends temperatures and drive space to your dashboard and runs its buttons.",
      // conhost --headless: no console window (Windows 10 21H2+ / 11)
      file: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe"),
      args: ["--headless", join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), "/c", agentCmdPath(ctx)],
      workingDir: ctx.paths.dataRoot,
      trigger: "logon",
      user,
      delayS: 10,
    };
  const c = self(ctx, "agent", ["run", "--config", ctx.paths.agentYaml]);
  return { name: TASK_AGENT, description: "HomePanel PC agent", file: c.file, args: c.args, trigger: "logon", user };
}

async function agentOnline(ctx: LocalCtx, pcId: string): Promise<boolean> {
  try {
    const a = await api(ctx);
    return (await a.agents()).some((x) => x.pcId === pcId && x.status === "online");
  } catch {
    return false;
  }
}

export const agentTaskStep: LocalStep = {
  id: "agent",
  title: `Run the agent at logon ("${TASK_AGENT}")`,
  why: "Runs as you, in your session, so buttons can open folders and programs on your screen.",
  async detect(ctx) {
    const t = await ctx.ops.taskInfo(TASK_AGENT);
    const pcId = ctx.store.state.local?.pcId;
    if (!t.exists || !pcId) return { done: false, detail: "Task not registered yet." };
    if (ctx.restartAgent) return { done: false, detail: "agent.yaml changed; the agent needs a restart." };
    if (isWin(ctx) && readText(agentCmdPath(ctx)) !== agentWrapper(ctx)) return { done: false, detail: `${agentCmdPath(ctx)} missing or out of date.` };
    return (await agentOnline(ctx, pcId))
      ? { done: true, detail: `"${pcId}" is online in HomePanel.` }
      : { done: false, detail: `Task registered but "${pcId}" is not online.` };
  },
  async actions(ctx) {
    const t = await agentTask(ctx);
    return [
      ...(isWin(ctx) ? [`Write ${agentCmdPath(ctx)} (runs the agent, restarts it if it stops, log in ${ctx.paths.logsDir})`] : []),
      isWin(ctx)
        ? `Register scheduled task "${TASK_AGENT}": at logon of ${t.user}, highest privileges, no window:\n${registerTaskPs(t)}`
        : `Write /etc/systemd/system/homepanel-agent.service (User=${t.user}) and enable it`,
      `Start it and wait until the server shows this PC online (up to ${Math.round(ctx.timeouts.agent / 1000)} s)`,
    ];
  },
  async run(ctx) {
    const pcId = ctx.store.state.local?.pcId;
    if (!pcId || !existsSync(ctx.paths.agentYaml)) throw new FixError("This PC is not registered yet.", ["Run the agent.yaml step first."]);
    const t = await agentTask(ctx);
    if (isWin(ctx)) {
      mkdirSync(ctx.paths.logsDir, { recursive: true });
      writeText(agentCmdPath(ctx), agentWrapper(ctx));
      await ctx.ops.restrictAcl(ctx.paths.logsDir, { dir: true, user: t.user });
    }
    const r = await ctx.ops.registerTask(t);
    if (r.code !== 0) throw new FixError(`Could not register "${TASK_AGENT}": ${(r.stderr || r.stdout).trim().slice(0, 300)}`, ["Run setup as administrator, then retry."]);
    const info = await ctx.ops.taskInfo(TASK_AGENT);
    if (info.state && /running/i.test(info.state)) {
      await stopTaskTree(ctx, TASK_AGENT, "agent");
      await ctx.sleep(1000);
    }
    await ctx.ops.startTask(TASK_AGENT);
    ctx.out.info(`Waiting for "${pcId}" to come online…`);
    const up = await poll(ctx, ctx.timeouts.agent, () => agentOnline(ctx, pcId), (x) => ctx.out.info(`still waiting (${x} s)…`));
    if (!up) {
      const run = self(ctx, "agent", ["run", "--config", ctx.paths.agentYaml]);
      throw new FixError(`"${pcId}" did not come online within ${Math.round(ctx.timeouts.agent / 1000)} s.`, [
        isWin(ctx) ? `Read the log: ${join(ctx.paths.logsDir, "agent.log")}` : "journalctl -u homepanel-agent -n 80",
        `Run it by hand to see errors:  ${showCmd(run.file, run.args)}`,
        "“Not authorized” = wrong MQTT password in agent.yaml; “ECONNREFUSED/timeout” = broker not reachable on port 1883.",
        "Then choose Retry.",
      ]);
    }
    ctx.restartAgent = false;
  },
};

/* ------------------------------------------------------------------ */
/* step: tray icon                                                      */
/* ------------------------------------------------------------------ */

function trayTask(ctx: LocalCtx, exe: string, user: string): TaskSpec {
  const sys = process.env.SystemRoot ?? "C:\\Windows";
  return {
    name: TASK_TRAY,
    description: "HomePanel tray icon: opens the HomePanel window (setup, status, buttons) without asking for administrator rights each time.",
    // conhost --headless: no console window; the tray shows its own icon
    file: join(sys, "System32", "conhost.exe"),
    args: ["--headless", exe, "tray"],
    workingDir: ctx.paths.dataRoot,
    trigger: "logon",
    user,
    delayS: 15,
  };
}

export const trayTaskStep: LocalStep = {
  id: "tray",
  title: `Tray icon at logon ("${TASK_TRAY}")`,
  why: "Opens HomePanel from the tray (^ next to the clock) without a permission prompt every time.",
  async detect(ctx) {
    const exe = installedExe(ctx);
    if (!isWin(ctx) || !exe) return { done: true, detail: "Only for HomePanel.exe on Windows." };
    const t = await ctx.ops.taskInfo(TASK_TRAY);
    if (!t.exists) return { done: false, detail: "Task not registered yet." };
    if (!(t.args ?? "").toLowerCase().includes(exe.toLowerCase())) return { done: false, detail: "Task points at another HomePanel.exe." };
    return { done: true, detail: `Registered (${t.state ?? "?"}).` };
  },
  async actions(ctx) {
    const t = trayTask(ctx, installedExe(ctx) ?? "HomePanel.exe", await ctx.ops.interactiveUser());
    return [`Register scheduled task "${TASK_TRAY}": at logon of ${t.user}, highest privileges, no console window:\n${registerTaskPs(t)}`, "Start it now"];
  },
  async run(ctx) {
    const exe = installedExe(ctx);
    if (!exe) return;
    const t = trayTask(ctx, exe, await ctx.ops.interactiveUser());
    const r = await ctx.ops.registerTask(t);
    if (r.code !== 0) throw new FixError(`Could not register "${TASK_TRAY}": ${(r.stderr || r.stdout).trim().slice(0, 300)}`, ["Run setup as administrator, then retry."]);
    const info = await ctx.ops.taskInfo(TASK_TRAY);
    if (!(info.state && /running/i.test(info.state))) await ctx.ops.startTask(TASK_TRAY);
  },
};

/* ------------------------------------------------------------------ */
/* step: pair this PC's browser                                         */
/* ------------------------------------------------------------------ */

export const pairBrowserStep: LocalStep = {
  id: "browser",
  title: "Open the dashboard on this PC",
  why: "Pairs this PC's browser with the desk-monitor layout, no code to type.",
  async detect(ctx) {
    return ctx.store.state.local?.browserPaired && ctx.store.secrets.deviceToken
      ? { done: true, detail: "This PC's browser is paired." }
      : { done: false, detail: "Not paired yet." };
  },
  async actions(ctx) {
    return [
      `POST ${serverUrl(ctx)}/api/pair/start, approve it as "${ctx.net().hostname} (this PC)" with profile desk-monitor`,
      `Open http://localhost:${SERVER_PORT}/?token=<new device token> in your default browser`,
    ];
  },
  async run(ctx) {
    const a = await api(ctx);
    let profile = "desk-monitor";
    try {
      const ids = await a.profiles();
      if (!ids.includes(profile) && ids[0]) profile = ids[0];
    } catch {
      /* keep the default */
    }
    const { token } = await a.pairDevice(`${ctx.net().hostname} (this PC)`, profile);
    ctx.store.setSecret("deviceToken", token);
    ctx.store.updateLocal({ browserPaired: true });
    await ctx.ops.openUrl(`http://localhost:${SERVER_PORT}/?token=${encodeURIComponent(token)}`);
  },
};

/* ------------------------------------------------------------------ */
/* flows                                                                */
/* ------------------------------------------------------------------ */

export function hostSteps(platform: NodeJS.Platform): LocalStep[] {
  if (platform === "win32")
    return [
      installExeStep,
      lhmInstallStep,
      pawnioStep,
      lhmConfigStep,
      sensorsTaskStep,
      mosquittoInstallStep,
      mosquittoConfigStep,
      firewallStep,
      serverConfigStep,
      serverTaskStep,
      agentConfigStep,
      agentTaskStep,
      trayTaskStep,
      pairBrowserStep,
    ];
  return [mosquittoInstallStep, mosquittoConfigStep, serverConfigStep, serverTaskStep, agentConfigStep, agentTaskStep, pairBrowserStep];
}

export function joinSteps(platform: NodeJS.Platform): LocalStep[] {
  if (platform === "win32") return [installExeStep, lhmInstallStep, pawnioStep, lhmConfigStep, sensorsTaskStep, agentConfigStep, agentTaskStep, trayTaskStep];
  return [agentConfigStep, agentTaskStep];
}

/** Send the plan to the window (before the first question, so its step list is never empty). */
export function announceSteps(steps: LocalStep[], prefix: string): void {
  hooks().steps?.(steps.map((s) => ({ id: `${prefix}.${s.id}`, title: s.title, summary: s.why })));
}

/** One question up front instead of thirteen: ask per step, or do them all. Returns false = quit. */
export async function chooseAskMode(ctx: LocalCtx, titles: string[]): Promise<boolean> {
  ctx.out.line();
  ctx.out.line("  Steps (each one is checked first and skipped when it's already done):");
  ctx.out.steps(titles);
  if (ctx.yes) return true;
  const how = await ctx.prompt.select<"ask" | "all" | "quit">({
    message: "How do you want to go?",
    choices: [
      { value: "ask", name: "Show me each step and ask before doing it (recommended the first time)" },
      { value: "all", name: "Do all of them — I've read the list (exact actions are still printed)" },
      { value: "quit", name: "Not now" },
    ],
  });
  if (how === "quit") return false;
  if (how === "all") ctx.confirmAll = true;
  return true;
}

export interface RunResult {
  code: number;
  results: { id: string; title: string; status: LocalStatus | "quit" }[];
}

/** Run steps in order: detect → (show actions, ask) → run → on failure show the fix, retry/skip/quit. */
export async function runLocalSteps(ctx: LocalCtx, steps: LocalStep[], prefix: string): Promise<RunResult> {
  const { out, prompt, store } = ctx;
  const h = hooks();
  const ids = steps.map((s) => `${prefix}.${s.id}`);
  announceSteps(steps, prefix);
  const results: RunResult["results"] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const key = `${prefix}.${step.id}`;
    if (beforeFromStep(ids, key, h.fromStep)) {
      h.step?.(key, "skipped", "Not part of this run (started at a later step).");
      results.push({ id: step.id, title: step.title, status: store.isDone(key) ? "done" : "skipped" });
      continue;
    }
    h.step?.(key, "checking");
    out.heading(`${i + 1}/${steps.length}  ${step.title}`);
    out.info(step.why);
    let d: { done: boolean; detail: string };
    try {
      d = await step.detect(ctx);
    } catch (e) {
      d = { done: false, detail: (e as Error).message };
    }
    if (d.done) {
      out.ok(d.detail);
      store.mark(key, "done", d.detail);
      results.push({ id: step.id, title: step.title, status: "done" });
      h.step?.(key, "done", d.detail);
      continue;
    }
    out.info(d.detail);
    h.step?.(key, "checking", d.detail);
    out.line("  This will:");
    for (const a of await step.actions(ctx)) out.code(a);
    const go = ctx.yes || ctx.confirmAll || (await prompt.confirm({ message: "Do this now?", default: false }));
    if (!go) {
      out.info("Skipped. Run setup again any time to do it.");
      store.mark(key, "skipped");
      results.push({ id: step.id, title: step.title, status: "skipped" });
      h.step?.(key, "skipped", "Skipped. Run setup again any time to do it.");
      continue;
    }
    let status: LocalStatus | "quit" = "failed";
    for (;;) {
      h.step?.(key, "running");
      try {
        const r = await step.run(ctx);
        status = r === "manual" ? "manual" : "done";
        if (status === "done") out.ok(`${step.title}: done.`);
        break;
      } catch (e) {
        const err = e as Error;
        if (err.name === "ExitPromptError") {
          h.step?.(key, "failed", "Stopped.");
          throw e;
        }
        h.step?.(key, "failed", err.message);
        out.err(err.message);
        if (err instanceof FixError && err.fix.length) {
          out.line("  How to fix:");
          out.steps(err.fix);
        }
        const what = await prompt.select<"retry" | "skip" | "quit">({
          message: "What now?",
          choices: [
            { value: "retry", name: "Try again" },
            { value: "skip", name: "Skip this step" },
            { value: "quit", name: "Stop here (progress is saved)" },
          ],
        });
        if (what === "retry") continue;
        status = what === "skip" ? "failed" : "quit";
        break;
      }
    }
    if (status === "quit") {
      store.mark(key, "failed");
      results.push({ id: step.id, title: step.title, status });
      h.step?.(key, "failed", "Stopped here (progress is saved).");
      h.endSteps?.();
      return { code: 1, results };
    }
    store.mark(key, status);
    results.push({ id: step.id, title: step.title, status });
    h.step?.(key, status === "done" ? "done" : status === "manual" ? "manual" : "failed");
  }
  h.endSteps?.();
  const failed = results.some((r) => r.status === "failed");
  return { code: failed ? 1 : 0, results };
}

export function printSummary(ctx: LocalCtx, res: RunResult, mode: "host" | "join") {
  const { out } = ctx;
  out.heading("Summary");
  const icon = { done: color.green("✔"), skipped: color.yellow("–"), manual: color.yellow("!"), failed: color.red("✖"), quit: color.red("■") };
  for (const r of res.results) out.line(`  ${icon[r.status]} ${r.title}${r.status === "done" ? "" : `  (${r.status})`}`);
  const ip = ctx.net().ip;
  const s = ctx.store.secrets;
  out.line();
  if (mode === "host") {
    out.ok(`Dashboard on this PC : http://localhost:${SERVER_PORT}`);
    out.ok(`Admin page           : http://localhost:${SERVER_PORT}/admin   password: ${color.bold(s.adminPassword ?? "(not set)")}`);
    if (ip) {
      out.ok(`Tablets / phones     : http://${ip}:${SERVER_PORT}   (a 6-digit code appears; approve it on the admin page)`);
      out.ok(`Other PCs            : download http://${ip}:${SERVER_PORT}/download/HomePanel.exe, run it, choose "Join this PC"`);
      out.info(`  They will ask for the admin password above and the MQTT password: ${color.bold(s.mqttPassword ?? "(not set)")}`);
    }
    out.info(`Secrets are saved in ${ctx.store.secretsPath} (administrators only).`);
  } else {
    const u = ctx.store.state.local?.serverUrl;
    if (u) out.ok(`This PC now reports to ${u}  — see ${u}/admin → Computers`);
  }
  if (res.results.some((r) => r.status !== "done")) out.info("Run HomePanel setup again to finish the skipped steps — finished ones are not repeated.");
}

/* ------------------------------------------------------------------ */
/* server discovery (join)                                              */
/* ------------------------------------------------------------------ */

/** mDNS browse for `_homepanel._tcp` (the server does not advertise it yet, so usually empty). */
export async function browseHomePanel(timeoutMs = 2000): Promise<string[]> {
  let factory: any;
  try {
    factory = (await import("multicast-dns")).default;
  } catch {
    return [];
  }
  return new Promise((resolve) => {
    const found = new Set<string>();
    let m: any;
    try {
      m = factory();
    } catch {
      resolve([]);
      return;
    }
    const srv = new Map<string, { target: string; port: number }>();
    const addrs = new Map<string, string>();
    m.on("response", (res: any) => {
      for (const r of [...(res.answers ?? []), ...(res.additionals ?? [])]) {
        if (r.type === "SRV" && /_homepanel\._tcp/.test(r.name)) srv.set(r.name, { target: r.data.target, port: r.data.port });
        if (r.type === "A") addrs.set(r.name, r.data);
      }
      for (const s of srv.values()) found.add(`http://${addrs.get(s.target) ?? s.target.replace(/\.$/, "")}:${s.port}`);
    });
    m.on("error", () => undefined);
    try {
      m.query({ questions: [{ name: "_homepanel._tcp.local", type: "PTR" }] });
    } catch {
      /* no multicast */
    }
    setTimeout(() => {
      try {
        m.destroy();
      } catch {
        /* ignore */
      }
      resolve([...found]);
    }, timeoutMs);
  });
}

/** Probe likely addresses + this /24 for a HomePanel server (GET /api/health). */
export async function findServers(ctx: Pick<LocalCtx, "fetchImpl" | "net">, o: { extra?: string[]; scan?: boolean; mdns?: () => Promise<string[]> } = {}): Promise<string[]> {
  const cands = new Set<string>(o.extra ?? []);
  for (const u of (await (o.mdns ?? browseHomePanel)()) ?? []) cands.add(u);
  cands.add(`http://homeassistant.local:${SERVER_PORT}`);
  cands.add(`http://homepanel.local:${SERVER_PORT}`);
  const ip = ctx.net().ip;
  if (o.scan !== false && ip) {
    const base = ip.split(".").slice(0, 3).join(".");
    for (let i = 1; i < 255; i++) if (`${base}.${i}` !== ip) cands.add(`http://${base}.${i}:${SERVER_PORT}`);
  }
  const list = [...cands];
  const found: string[] = [];
  const batch = 64;
  for (let i = 0; i < list.length; i += batch) {
    const res = await Promise.all(list.slice(i, i + batch).map(async (u) => ((await new ServerApi(u, ctx.fetchImpl).health(900))?.ok !== undefined ? u : undefined)));
    for (const u of res) if (u) found.push(u);
  }
  return found;
}

export function hostnameOf(): string {
  return hostname();
}
