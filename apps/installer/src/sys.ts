import { spawn } from "node:child_process";
import { networkInterfaces, platform, arch, cpus, totalmem, hostname, release } from "node:os";
import { existsSync, readFileSync } from "node:fs";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; inherit?: boolean }) => Promise<ExecResult>;

/** Spawn without a shell (no quoting surprises). `inherit` streams output to the terminal. */
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: opts.inherit ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String(e) });
      return;
    }
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
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

/** Printable form of a command for "this is what will run" messages. */
export function showCmd(cmd: string, args: string[]): string {
  return [cmd, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(" ");
}

export interface SystemInfo {
  platform: NodeJS.Platform;
  arch: string;
  os: string;
  hostname: string;
  cpus: string;
  cores: number;
  memoryGB: number;
  lanIps: string[];
  isWsl: boolean;
  node: string;
}

export function systemInfo(): SystemInfo {
  const p = platform();
  let os = `${p} ${release()}`;
  if (p === "linux" && existsSync("/etc/os-release")) {
    const m = /PRETTY_NAME="?([^"\n]+)"?/.exec(readFileSync("/etc/os-release", "utf8"));
    if (m) os = m[1]!;
  }
  const isWsl = p === "linux" && /microsoft/i.test(release());
  const c = cpus();
  return {
    platform: p,
    arch: arch(),
    os,
    hostname: hostname(),
    cpus: c[0]?.model?.trim() ?? "unknown",
    cores: c.length,
    memoryGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    lanIps: lanIps(),
    isWsl,
    node: process.version,
  };
}

export function lanIps(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(a.address);
    }
  }
  return out;
}

/** Random password from an unambiguous alphabet. */
export function randomPassword(len = 24): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
