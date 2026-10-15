/**
 * Open the HomePanel window: Microsoft Edge in app mode (its own window, no tabs or address bar,
 * remembers its size via its own profile), else Chrome in app mode, else the default browser.
 * Linux / macOS: xdg-open / open.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

export interface BrowserPick {
  kind: "edge" | "chrome" | "default";
  file: string;
  args: string[];
}

export interface FindDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exists(p: string): boolean;
  /** registry "App Paths" default value for an exe name (Windows), or undefined */
  appPath(exe: string): string | undefined;
}

export const WINDOW_SIZE = "1100,760";

function winCandidates(env: NodeJS.ProcessEnv, sub: string[]): string[] {
  const roots = [env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", env.ProgramFiles || "C:\\Program Files", env.LOCALAPPDATA].filter((x): x is string => !!x);
  return roots.map((r) => win32.join(r, ...sub));
}

/** The browser and command line used to open `url`. */
export function pickBrowser(url: string, d: FindDeps): BrowserPick {
  if (d.platform === "win32") {
    const profile = win32.join(d.env.LOCALAPPDATA || win32.join(d.env.USERPROFILE || "C:\\Users\\Default", "AppData", "Local"), "HomePanel", "ui-profile");
    const appArgs = [
      `--app=${url}`,
      `--window-size=${WINDOW_SIZE}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
    ];
    const edge = [...winCandidates(d.env, ["Microsoft", "Edge", "Application", "msedge.exe"]), d.appPath("msedge.exe")].find((p): p is string => !!p && d.exists(p));
    if (edge) return { kind: "edge", file: edge, args: appArgs };
    const chrome = [...winCandidates(d.env, ["Google", "Chrome", "Application", "chrome.exe"]), d.appPath("chrome.exe")].find((p): p is string => !!p && d.exists(p));
    if (chrome) return { kind: "chrome", file: chrome, args: appArgs.map((a) => (a.startsWith("--user-data-dir=") ? `${a}-chrome` : a)) };
    // rundll32 url.dll hands the URL to the default browser without a console window
    return { kind: "default", file: win32.join(d.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), args: ["url.dll,FileProtocolHandler", url] };
  }
  if (d.platform === "darwin") return { kind: "default", file: "open", args: [url] };
  return { kind: "default", file: "xdg-open", args: [url] };
}

/** Registry App Paths lookup (reg.exe query, synchronous-ish via spawn). */
export async function regAppPath(exe: string): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  for (const hive of ["HKLM", "HKCU"]) {
    const out = await new Promise<string>((resolve) => {
      let s = "";
      try {
        const c = spawn("reg.exe", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"], { windowsHide: true });
        c.stdout.on("data", (d) => (s += d));
        c.on("error", () => resolve(""));
        c.on("close", () => resolve(s));
      } catch {
        resolve("");
      }
    });
    const m = /REG_SZ\s+(.+?)\s*$/m.exec(out);
    if (m) return m[1]!.replace(/^"|"$/g, "");
  }
  return undefined;
}

export async function openWindow(url: string, o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): Promise<BrowserPick> {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const paths = new Map<string, string | undefined>();
  if (platform === "win32") for (const exe of ["msedge.exe", "chrome.exe"]) paths.set(exe, await regAppPath(exe));
  const pick = pickBrowser(url, { env, platform, exists: existsSync, appPath: (e) => paths.get(e) });
  try {
    const child = spawn(pick.file, pick.args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* nothing else to try; the URL is printed by the caller */
  }
  return pick;
}

