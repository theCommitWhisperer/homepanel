/**
 * Single-instance handoff (UI-CONTRACT.md): a running window/tray writes
 *   <dir>/ui.json    = { port, pid, secretHash, kind }
 *   <dir>/ui.secret  = a handoff token (0600 / ACL: admins + the signed-in user)
 * A second HomePanel.exe reads both and POSTs /api/ui/show with the token instead of starting
 * another server. The token only authorizes /api/ui/show, never the rest of the API.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UiInfo {
  port: number;
  pid: number;
  /** sha256 hex of the handoff token in ui.secret */
  secretHash: string;
  kind: "tray" | "window";
  version?: string;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** %ProgramData%\HomePanel on Windows, ~/.homepanel elsewhere (HOMEPANEL_UI_DIR overrides). */
export function uiDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.HOMEPANEL_UI_DIR) return env.HOMEPANEL_UI_DIR;
  if (platform === "win32") return join(env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData", "HomePanel");
  return join(env.HOMEPANEL_HOME || join(homedir(), ".homepanel"));
}

function writeAtomic(p: string, data: string, mode?: number) {
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, data, mode ? { mode } : undefined);
  renameSync(tmp, p);
  if (mode)
    try {
      chmodSync(p, mode);
    } catch {
      /* windows */
    }
}

export function writeUiInfo(dir: string, info: UiInfo, token: string): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "ui.secret"), token + "\n", 0o600);
  writeAtomic(join(dir, "ui.json"), JSON.stringify(info, null, 2) + "\n");
}

export function readUiInfo(dir: string): { info: UiInfo; token?: string } | undefined {
  try {
    const info = JSON.parse(readFileSync(join(dir, "ui.json"), "utf8")) as UiInfo;
    if (!info || typeof info.port !== "number" || typeof info.pid !== "number") return undefined;
    let token: string | undefined;
    try {
      token = readFileSync(join(dir, "ui.secret"), "utf8").trim();
      if (sha256(token) !== info.secretHash) token = undefined;
    } catch {
      token = undefined;
    }
    return { info, ...(token ? { token } : {}) };
  } catch {
    return undefined;
  }
}

/** Remove ui.json / ui.secret if they still belong to `pid`. */
export function clearUiInfo(dir: string, pid = process.pid): void {
  const cur = readUiInfo(dir);
  if (cur && cur.info.pid !== pid) return;
  for (const f of ["ui.json", "ui.secret"]) rmSync(join(dir, f), { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else (elevated)
  }
}

/**
 * Ask a running instance to show its window. true = it answered (this process can exit).
 * `view` lets the second launch ask for a screen (e.g. "setup").
 */
export async function handoff(dir: string, o: { view?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<boolean> {
  const cur = readUiInfo(dir);
  if (!cur?.token || !pidAlive(cur.info.pid)) return false;
  const f = o.fetchImpl ?? globalThis.fetch;
  try {
    const r = await f(`http://127.0.0.1:${cur.info.port}/api/ui/show`, {
      method: "POST",
      headers: { "x-hp-handoff": cur.token, "content-type": "application/json" },
      body: JSON.stringify(o.view ? { view: o.view } : {}),
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export const uiInfoExists = (dir: string) => existsSync(join(dir, "ui.json"));
