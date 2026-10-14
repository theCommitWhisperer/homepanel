/**
 * System operations the "Host on this PC" / "Join this PC" flows need, behind one interface so the
 * flows are unit-testable on Linux with `FakeOps`. `windowsOps` drives PowerShell / winget /
 * icacls / sc; `linuxOps` uses apt-get / systemd / chmod.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../sys.js";
import {
  findLhmPs,
  findMosquittoPs,
  firewallExistsPs,
  firewallRulePs,
  icaclsArgs,
  interactiveUserPs,
  isElevatedPs,
  networkCategoryPs,
  powershellArgs,
  processRunningPs,
  registerTaskPs,
  relaunchElevatedPs,
  disableServicePs,
  removeFirewallRulePs,
  unregisterTaskPs,
  restartServicePs,
  serviceEnvPs,
  serviceInfoPs,
  setNetworkPrivatePs,
  startTaskPs,
  stopProcessPs,
  stopTaskPs,
  taskInfoPs,
  type FirewallRule,
  type TaskSpec,
} from "./ps.js";

export type { FirewallRule, TaskSpec } from "./ps.js";

export interface RunOpts {
  env?: Record<string, string>;
  timeoutMs?: number;
  inherit?: boolean;
  cwd?: string;
}

export interface TaskInfo {
  exists: boolean;
  state?: string;
  file?: string;
  args?: string;
}

export interface ServiceInfo {
  exists: boolean;
  running: boolean;
  env: string[];
}

export interface WinOps {
  readonly platform: NodeJS.Platform;
  isElevated(): Promise<boolean>;
  /** Run `file args` elevated (UAC prompt), wait, return its exit code. */
  relaunchElevated(file: string, args: string[]): Promise<number>;
  /** Run a program (no shell). */
  run(file: string, args: string[], o?: RunOpts): Promise<ExecResult>;
  /** winget list --id <id> -e (Linux: dpkg -s) */
  packageInstalled(id: string): Promise<boolean>;
  /** winget install --id <id> -e … (Linux: apt-get install -y) */
  installPackage(id: string, o?: { scope?: "machine" | "user"; silent?: boolean }): Promise<ExecResult>;
  /** the exact command installPackage runs (for the "this will run" text) */
  installPackageCommand(id: string, o?: { scope?: "machine" | "user"; silent?: boolean }): string[];
  /** winget uninstall --id <id> -e … (Linux: apt-get remove -y) */
  uninstallPackage(id: string): Promise<ExecResult>;
  uninstallPackageCommand(id: string): string[];
  findLhmExe(): Promise<string | undefined>;
  findMosquittoDir(): Promise<string | undefined>;
  processRunning(name: string): Promise<boolean>;
  stopProcess(o: { name?: string; path?: string; commandLike?: string }): Promise<void>;
  serviceInfo(name: string): Promise<ServiceInfo>;
  setServiceEnv(name: string, env: Record<string, string>): Promise<ExecResult>;
  restartService(name: string): Promise<ExecResult>;
  /** Stop a service and set it to Manual start (Linux: systemctl disable --now). */
  disableService(name: string): Promise<ExecResult>;
  firewallRuleExists(name: string): Promise<boolean>;
  addFirewallRule(r: FirewallRule): Promise<ExecResult>;
  removeFirewallRule(name: string): Promise<ExecResult>;
  networkCategory(): Promise<string>;
  setNetworkPrivate(): Promise<ExecResult>;
  taskInfo(name: string): Promise<TaskInfo>;
  registerTask(t: TaskSpec): Promise<ExecResult>;
  startTask(name: string): Promise<ExecResult>;
  stopTask(name: string): Promise<ExecResult>;
  /** Stop and delete a scheduled task (Linux: disable + remove the systemd unit). */
  unregisterTask(name: string): Promise<ExecResult>;
  /** Only SYSTEM + Administrators (+ optional user) can read `path`. */
  restrictAcl(path: string, o: { dir: boolean; user?: string }): Promise<ExecResult>;
  interactiveUser(): Promise<string>;
  openUrl(url: string): Promise<void>;
}

/** spawn without a shell; optional extra env (secrets go here, never on the command line). */
export function spawnRun(file: string, args: string[], o: RunOpts = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(file, args, {
        cwd: o.cwd,
        env: o.env ? { ...process.env, ...o.env } : process.env,
        stdio: o.inherit ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String(e) });
      return;
    }
    const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 120_000);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: e.code === "ENOENT" ? 127 : 1, stdout, stderr: stderr + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

/* ------------------------------------------------------------------ */
/* Windows                                                              */
/* ------------------------------------------------------------------ */

export function windowsOps(): WinOps {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const ps = (script: string, timeoutMs = 120_000) => spawnRun(powershell, powershellArgs(script), { timeoutMs });
  const psOut = async (script: string) => (await ps(script)).stdout.trim();
  const wingetArgs = (id: string, o: { scope?: "machine" | "user"; silent?: boolean } = {}) => [
    "install",
    "--id",
    id,
    "-e",
    "--accept-source-agreements",
    "--accept-package-agreements",
    "--disable-interactivity",
    ...(o.scope ? ["--scope", o.scope] : []),
    ...(o.silent ? ["--silent"] : []),
  ];
  const wingetUninstallArgs = (id: string) => ["uninstall", "--id", id, "-e", "--silent", "--accept-source-agreements", "--disable-interactivity"];
  return {
    platform: "win32",
    async isElevated() {
      return /true/i.test(await psOut(isElevatedPs));
    },
    async relaunchElevated(file, args) {
      return (await spawnRun(powershell, powershellArgs(relaunchElevatedPs(file, args)), { timeoutMs: 24 * 3600_000 })).code;
    },
    run: spawnRun,
    async packageInstalled(id) {
      const r = await spawnRun("winget", ["list", "--id", id, "-e", "--accept-source-agreements", "--disable-interactivity"], { timeoutMs: 120_000 });
      return r.code === 0 && r.stdout.toLowerCase().includes(id.toLowerCase());
    },
    installPackage(id, o) {
      return spawnRun("winget", wingetArgs(id, o), { timeoutMs: 20 * 60_000, inherit: true });
    },
    installPackageCommand: (id, o) => ["winget", ...wingetArgs(id, o)],
    uninstallPackage(id) {
      return spawnRun("winget", wingetUninstallArgs(id), { timeoutMs: 10 * 60_000, inherit: true });
    },
    uninstallPackageCommand: (id) => ["winget", ...wingetUninstallArgs(id)],
    async findLhmExe() {
      return (await psOut(findLhmPs)) || undefined;
    },
    async findMosquittoDir() {
      return (await psOut(findMosquittoPs)) || undefined;
    },
    async processRunning(name) {
      return (await psOut(processRunningPs(name))) === "yes";
    },
    async stopProcess(o) {
      await ps(stopProcessPs({ ...o, exceptPid: process.pid }));
    },
    async serviceInfo(name) {
      const lines = (await psOut(serviceInfoPs(name))).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length || lines[0] === "missing") return { exists: false, running: false, env: [] };
      return { exists: true, running: /^running$/i.test(lines[0]!), env: lines.slice(1) };
    },
    setServiceEnv: (name, env) => ps(serviceEnvPs(name, env)),
    restartService: (name) => ps(restartServicePs(name), 60_000),
    disableService: (name) => ps(disableServicePs(name), 60_000),
    async firewallRuleExists(name) {
      return (await psOut(firewallExistsPs(name))) === "yes";
    },
    addFirewallRule: (r) => ps(firewallRulePs(r)),
    removeFirewallRule: (name) => ps(removeFirewallRulePs(name)),
    networkCategory: () => psOut(networkCategoryPs),
    setNetworkPrivate: () => ps(setNetworkPrivatePs),
    async taskInfo(name) {
      const line = await psOut(taskInfoPs(name));
      if (!line) return { exists: false };
      const [state, file, ...rest] = line.split("|");
      return { exists: true, state, file, args: rest.join("|") };
    },
    registerTask: (t) => ps(registerTaskPs(t)),
    startTask: (name) => ps(startTaskPs(name)),
    stopTask: (name) => ps(stopTaskPs(name)),
    unregisterTask: (name) => ps(unregisterTaskPs(name)),
    restrictAcl: (path, o) => spawnRun("icacls", icaclsArgs(path, o)),
    async interactiveUser() {
      return (await psOut(interactiveUserPs)) || `${process.env.USERDOMAIN ?? "."}\\${process.env.USERNAME ?? userInfo().username}`;
    },
    async openUrl(url) {
      // explorer.exe hands the URL to the signed-in user's default browser (not elevated)
      await spawnRun(join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"), [url], { timeoutMs: 15_000 });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Linux                                                                */
/* ------------------------------------------------------------------ */

const APT_NAMES: Record<string, string[]> = {
  "EclipseFoundation.Mosquitto": ["mosquitto", "mosquitto-clients"],
};

export function systemdUnit(t: TaskSpec, user?: string): string {
  const q = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return [
    "[Unit]",
    `Description=${t.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${[t.file, ...t.args].map(q).join(" ")}`,
    ...(t.workingDir ? [`WorkingDirectory=${t.workingDir}`] : []),
    ...Object.entries(t.env ?? {}).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`),
    ...(user ? [`User=${user}`] : []),
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export const unitName = (task: string) => task.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".service";

export function linuxOps(unitDir = "/etc/systemd/system"): WinOps {
  const sh = (file: string, args: string[], o?: RunOpts) => spawnRun(file, args, o);
  const aptArgs = (id: string) => ["install", "-y", ...(APT_NAMES[id] ?? [id])];
  return {
    platform: "linux",
    async isElevated() {
      return process.getuid?.() === 0;
    },
    async relaunchElevated(file, args) {
      return (await spawnRun("sudo", [file, ...args], { inherit: true, timeoutMs: 24 * 3600_000 })).code;
    },
    run: spawnRun,
    async packageInstalled(id) {
      const pkgs = APT_NAMES[id] ?? [id];
      const r = await sh("dpkg", ["-s", pkgs[0]!]);
      return r.code === 0 && /Status: install ok installed/.test(r.stdout);
    },
    installPackage: (id) => sh("apt-get", aptArgs(id), { inherit: true, timeoutMs: 20 * 60_000, env: { DEBIAN_FRONTEND: "noninteractive" } }),
    installPackageCommand: (id) => ["apt-get", ...aptArgs(id)],
    uninstallPackage: (id) => sh("apt-get", ["remove", "-y", ...(APT_NAMES[id] ?? [id])], { inherit: true, timeoutMs: 10 * 60_000, env: { DEBIAN_FRONTEND: "noninteractive" } }),
    uninstallPackageCommand: (id) => ["apt-get", "remove", "-y", ...(APT_NAMES[id] ?? [id])],
    findLhmExe: async () => undefined,
    findMosquittoDir: async () => (existsSync("/usr/sbin/mosquitto") ? "/usr/sbin" : undefined),
    async processRunning(name) {
      return (await sh("pgrep", ["-x", name])).code === 0;
    },
    async stopProcess(o) {
      if (o.name) await sh("pkill", ["-x", o.name]);
    },
    async serviceInfo(name) {
      const r = await sh("systemctl", ["is-active", name]);
      const exists = (await sh("systemctl", ["cat", name])).code === 0;
      return { exists, running: r.stdout.trim() === "active", env: [] };
    },
    setServiceEnv: async () => ok(),
    async restartService(name) {
      await sh("systemctl", ["enable", name]);
      return sh("systemctl", ["restart", name]);
    },
    disableService: (name) => sh("systemctl", ["disable", "--now", name]),
    firewallRuleExists: async () => true,
    addFirewallRule: async () => ok(),
    removeFirewallRule: async () => ok(),
    networkCategory: async () => "Private",
    setNetworkPrivate: async () => ok(),
    async taskInfo(name) {
      const unit = unitName(name);
      if (!existsSync(join(unitDir, unit))) return { exists: false };
      const r = await sh("systemctl", ["is-active", unit]);
      return { exists: true, state: r.stdout.trim() === "active" ? "Running" : "Ready" };
    },
    async registerTask(t) {
      const user = t.trigger === "logon" ? t.user?.split("\\").pop() : undefined;
      writeFileSync(join(unitDir, unitName(t.name)), systemdUnit(t, user));
      await sh("systemctl", ["daemon-reload"]);
      return sh("systemctl", ["enable", unitName(t.name)]);
    },
    startTask: (name) => sh("systemctl", ["restart", unitName(name)]),
    stopTask: (name) => sh("systemctl", ["stop", unitName(name)]),
    async unregisterTask(name) {
      const unit = unitName(name);
      await sh("systemctl", ["disable", "--now", unit]);
      rmSync(join(unitDir, unit), { force: true });
      return sh("systemctl", ["daemon-reload"]);
    },
    restrictAcl: (path, o) => sh("chmod", [o.dir ? "700" : "600", path]),
    async interactiveUser() {
      return process.env.SUDO_USER || process.env.USER || userInfo().username;
    },
    async openUrl(url) {
      const user = process.env.SUDO_USER;
      if (user && process.getuid?.() === 0) await sh("sudo", ["-u", user, "xdg-open", url], { timeoutMs: 10_000 });
      else await sh("xdg-open", [url], { timeoutMs: 10_000 });
    },
  };
}

export function defaultOps(): WinOps {
  return process.platform === "win32" ? windowsOps() : linuxOps();
}
