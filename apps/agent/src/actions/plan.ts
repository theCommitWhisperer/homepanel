/**
 * Turns a configured action into the concrete process(es) to start on this OS.
 * Pure function of (action, platform, env, fs lookups) so tests can assert exact commands.
 */
import { readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, win32, posix } from "node:path";
import type { ActionDef, SystemCommand } from "../config.js";
import { powershell, type CommandSpec } from "../exec.js";
import { expandEnv } from "../util.js";
import { keyPressScript, parseKeyCombo, xdotoolCombo } from "./keys.js";
import { MONITORS_OFF_PS } from "./windows.js";

export interface PlanContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** directory of agent.yaml; relative script paths resolve against it */
  configDir: string;
  /** wildcard lookup for launch exe paths containing * (injectable for tests) */
  findNewest?: (pattern: string, platform: NodeJS.Platform) => string | undefined;
}

export interface Plan {
  /** commands run in order; a "fallback" chain stops at the first that succeeds */
  steps: CommandSpec[];
  mode: "all" | "first-success";
  describe: string;
}

export class ActionError extends Error {}

const single = (spec: CommandSpec, describe: string): Plan => ({ steps: [spec], mode: "all", describe });

/* ------------------------------------------------------------------ */
/* launch.find: newest file matching a wildcard path                   */
/* ------------------------------------------------------------------ */
function wildcardToRegExp(seg: string): RegExp {
  return new RegExp("^" + seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
}

export function findNewestMatch(pattern: string, platform: NodeJS.Platform): string | undefined {
  const p = platform === "win32" ? win32 : posix;
  const normalized = platform === "win32" ? pattern.replace(/\//g, "\\") : pattern;
  const parsed = p.parse(normalized);
  const root = parsed.root;
  const segs = normalized.slice(root.length).split(p.sep).filter(Boolean);
  let candidates = [root || "."];
  for (const seg of segs) {
    const next: string[] = [];
    const wild = /[*?]/.test(seg);
    for (const dir of candidates) {
      if (!wild) {
        next.push(p.join(dir, seg));
        continue;
      }
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      const re = wildcardToRegExp(seg);
      for (const n of names) if (re.test(n)) next.push(p.join(dir, n));
    }
    candidates = next;
  }
  let best: { path: string; mtime: number } | undefined;
  for (const c of candidates) {
    try {
      const st = statSync(c);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtime) best = { path: c, mtime: st.mtimeMs };
    } catch {
      /* missing */
    }
  }
  return best?.path;
}

/* ------------------------------------------------------------------ */
/* Per-type planners                                                    */
/* ------------------------------------------------------------------ */
function planOpen(path: string, ctx: PlanContext): Plan {
  const target = expandEnv(path, ctx.env, ctx.platform);
  if (ctx.platform === "win32") {
    // explorer.exe returns exit code 1 even on success → detached, don't check the code.
    return single({ cmd: "explorer.exe", args: [target], detached: true, hidden: false }, `open ${target}`);
  }
  if (ctx.platform === "darwin") return single({ cmd: "open", args: [target], detached: true }, `open ${target}`);
  return single({ cmd: "xdg-open", args: [target], detached: true }, `open ${target}`);
}

function planUrl(url: string, ctx: PlanContext): Plan {
  if (ctx.platform === "win32") {
    // rundll32 url.dll,FileProtocolHandler opens the default handler without a shell and
    // without cmd.exe's special-character problems (& in query strings).
    return single(
      { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url], detached: true, hidden: false },
      `open ${url}`,
    );
  }
  if (ctx.platform === "darwin") return single({ cmd: "open", args: [url], detached: true }, `open ${url}`);
  return single({ cmd: "xdg-open", args: [url], detached: true }, `open ${url}`);
}

/** cmd.exe metacharacters; with verbatim args they'd be interpreted, so refuse them. */
const CMD_META = /[&|<>^%!"\r\n]/;

/** "steam://open/main", "roblox-studio:", "ms-settings:sound" — but not "C:\\..." */
const isProtocol = (s: string) => /^[a-z][a-z0-9+.-]+:/i.test(s) && !/^[a-z]:[\\/]/i.test(s);
const isBareName = (s: string, platform: NodeJS.Platform) =>
  platform === "win32" ? !/[\\/]/.test(s) : !s.includes("/");

function planLaunch(a: Extract<ActionDef, { type: "launch" }>, ctx: PlanContext): Plan {
  let exe = expandEnv(a.exe, ctx.env, ctx.platform);
  if (/[*?]/.test(exe) && !isProtocol(exe)) {
    const found = (ctx.findNewest ?? findNewestMatch)(exe, ctx.platform);
    if (!found) throw new ActionError(`nothing matches ${exe}`);
    exe = found;
  }
  const args = a.args.map((x) => expandEnv(x, ctx.env, ctx.platform));
  if (ctx.platform !== "win32") {
    if (isProtocol(exe)) return single({ cmd: ctx.platform === "darwin" ? "open" : "xdg-open", args: [exe], detached: true }, `open ${exe}`);
    return single({ cmd: exe, args, detached: true }, `launch ${exe}`);
  }
  if (isProtocol(exe) || isBareName(exe, ctx.platform)) {
    // `start` resolves protocol handlers (steam://), PATH and the App Paths registry (discord,
    // spotify...) and detaches. We quote ourselves and pass the line verbatim; values come only
    // from agent.yaml and are refused if they contain cmd.exe metacharacters.
    for (const v of [exe, ...args]) {
      if (CMD_META.test(v)) throw new ActionError(`launch: refusing value with cmd.exe special characters: ${v}`);
    }
    const q = (s: string) => `"${s}"`;
    const line = ["/d", "/s", "/c", `"start "" ${[exe, ...args].map(q).join(" ")}"`];
    return single({ cmd: "cmd.exe", args: line, detached: true, verbatim: true, hidden: true }, `start ${exe}`);
  }
  // a full path: spawn it directly (no shell), detached, working dir = its folder
  return single(
    { cmd: exe, args, detached: true, hidden: false, cwd: win32.dirname(exe) },
    `launch ${exe}`,
  );
}

function planKeys(combo: string, ctx: PlanContext): Plan {
  const stroke = parseKeyCombo(combo);
  const describe = `keys ${stroke.names.join("+")}`;
  if (ctx.platform === "win32") return single(powershell(keyPressScript(stroke)), describe);
  const t = { timeoutMs: 5000 };
  const xdo: CommandSpec = { cmd: "xdotool", args: ["key", xdotoolCombo(stroke)], ...t };
  if (stroke.names.length === 1) {
    const pctl = (arg: string): CommandSpec => ({ cmd: "playerctl", args: [arg], ...t });
    const pactl = (...args: string[]): CommandSpec => ({ cmd: "pactl", args, ...t });
    const map: Record<string, CommandSpec[]> = {
      media_play_pause: [pctl("play-pause"), xdo],
      media_next: [pctl("next"), xdo],
      media_prev: [pctl("previous"), xdo],
      volume_up: [pactl("set-sink-volume", "@DEFAULT_SINK@", "+5%"), xdo],
      volume_down: [pactl("set-sink-volume", "@DEFAULT_SINK@", "-5%"), xdo],
      volume_mute: [pactl("set-sink-mute", "@DEFAULT_SINK@", "toggle"), xdo],
    };
    const steps = map[stroke.names[0]!];
    if (steps) return { steps, mode: "first-success", describe };
  }
  return single(xdo, describe);
}

function planSystem(op: SystemCommand, ctx: PlanContext): Plan {
  if (ctx.platform === "win32") {
    const det = (cmd: string, args: string[]): CommandSpec => ({ cmd, args, detached: true });
    switch (op) {
      case "lock":
        return single(det("rundll32.exe", ["user32.dll,LockWorkStation"]), "lock");
      case "sleep":
        // If hibernation is enabled, SetSuspendState(0,...) hibernates; README explains `powercfg /h off`.
        return single(det("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"]), "sleep");
      case "restart":
        return single({ cmd: "shutdown.exe", args: ["/r", "/t", "5"], timeoutMs: 10_000 }, "restart in 5 s");
      case "shutdown":
        return single({ cmd: "shutdown.exe", args: ["/s", "/t", "5"], timeoutMs: 10_000 }, "shut down in 5 s");
      case "monitors-off":
        return single(powershell(MONITORS_OFF_PS), "monitors off");
    }
  }
  if (ctx.platform === "darwin") {
    const m: Partial<Record<SystemCommand, CommandSpec>> = {
      lock: { cmd: "pmset", args: ["displaysleepnow"] },
      sleep: { cmd: "pmset", args: ["sleepnow"] },
      "monitors-off": { cmd: "pmset", args: ["displaysleepnow"] },
    };
    const spec = m[op];
    if (!spec) throw new ActionError(`${op} is not supported on macOS`);
    return single(spec, op);
  }
  const t = { timeoutMs: 10_000 };
  const steps: Record<SystemCommand, CommandSpec[]> = {
    lock: [
      { cmd: "loginctl", args: ["lock-session"], ...t },
      { cmd: "xdg-screensaver", args: ["lock"], ...t },
    ],
    sleep: [{ cmd: "systemctl", args: ["suspend"], ...t }],
    restart: [{ cmd: "systemctl", args: ["reboot"], ...t }],
    shutdown: [{ cmd: "systemctl", args: ["poweroff"], ...t }],
    "monitors-off": [
      { cmd: "xset", args: ["dpms", "force", "off"], ...t },
      { cmd: "busctl", args: ["--user", "call", "org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver", "SetActive", "b", "true"], ...t },
    ],
  };
  return { steps: steps[op], mode: "first-success", describe: op };
}

function planScript(a: Extract<ActionDef, { type: "script" }>, ctx: PlanContext): Plan {
  const pathMod = ctx.platform === "win32" ? win32 : posix;
  let file = expandEnv(a.script, ctx.env, ctx.platform);
  if (!pathMod.isAbsolute(file) && !isAbsolute(file)) file = pathMod.join(ctx.configDir, file);
  const ext = extname(file).toLowerCase();
  const shell =
    (ext === ".ps1" ? "powershell" : ext === ".cmd" || ext === ".bat" ? "cmd" : ctx.platform === "win32" ? "powershell" : "sh");
  const timeoutMs = a.timeoutMs;
  let spec: CommandSpec;
  switch (shell) {
    case "powershell":
      spec = {
        cmd: ctx.platform === "win32" ? "powershell.exe" : "pwsh",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...a.args],
        timeoutMs,
      };
      break;
    case "cmd":
      if (ctx.platform !== "win32") throw new ActionError("cmd scripts only run on Windows");
      if (CMD_META.test(file) || a.args.some((x) => CMD_META.test(x)))
        throw new ActionError("script: path/args contain cmd.exe special characters");
      spec = { cmd: "cmd.exe", args: ["/d", "/c", "call", file, ...a.args], timeoutMs };
      break;
    case "sh":
      spec = { cmd: "/bin/sh", args: [file, ...a.args], timeoutMs };
      break;
  }
  return { steps: [{ ...spec, cwd: pathMod.dirname(file) }], mode: "all", describe: `script ${file}` };
}

export function planAction(def: ActionDef, ctx: PlanContext): Plan {
  switch (def.type) {
    case "open":
      return planOpen(def.path, ctx);
    case "url":
      return planUrl(def.url, ctx);
    case "launch":
      return planLaunch(def, ctx);
    case "keys":
      return planKeys(def.keys, ctx);
    case "system":
      return planSystem(def.command, ctx);
    case "script":
      return planScript(def, ctx);
  }
}

