import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { VERSION as PROTOCOL_VERSION } from "@homepanel/protocol";

declare const __AGENT_VERSION__: string | undefined;
export const AGENT_VERSION: string =
  typeof __AGENT_VERSION__ === "string" ? __AGENT_VERSION__ : PROTOCOL_VERSION;

/** "AMD Ryzen 7 7800X3D" -> "amd_ryzen_7_7800x3d"; "Fan #2" -> "fan2"; "CPU Core #1" -> "cpu_core1" */
export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s*#\s*(\d)/g, "$1")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Parse LibreHardwareMonitor numbers. LHM formats with .NET "F" formats ("{0:F1} °C"), which
 * never group thousands, in the *Windows display locale*: "45.0" (en-US) or "45,0" (de-DE).
 * So a single comma or a single dot is the decimal separator. Grouped numbers from other tools
 * are still handled: "1,234.5" / "1.234,5" (both present: the last one is decimal) and
 * "1,234,567" / "1.234.567" (repeated separator = grouping).
 */
export function parseLocaleNumber(raw: string): number {
  let s = raw.trim().replace(/[\s\u00a0\u202f']/g, "");
  const m = s.match(/^[-+]?[\d.,]+/);
  if (!m) return Number.NaN;
  s = m[0];
  const commas = s.split(",").length - 1;
  const dots = s.split(".").length - 1;
  if (commas && dots) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (commas > 1) s = s.replace(/,/g, "");
  else if (dots > 1) s = s.replace(/\./g, "");
  else if (commas === 1) s = s.replace(",", ".");
  return Number(s);
}

/** Split "45.0 °C" -> {value: 45, unit: "°C"} */
export function parseValueWithUnit(raw: string): { value: number; unit: string } | null {
  const m = raw.trim().match(/^([-+]?[\d.,\s  ]*\d)\s*(.*)$/);
  if (!m) return null;
  const value = parseLocaleNumber(m[1]!);
  if (!Number.isFinite(value)) return null;
  return { value, unit: m[2]!.trim() };
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Expand %VAR% (Windows), $VAR / ${VAR} and a leading ~ (POSIX) from config paths. */
export function expandEnv(input: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return input.replace(/%([A-Za-z0-9_()]+)%/g, (all, name: string) => {
      const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
      return key !== undefined && env[key] !== undefined ? env[key]! : all;
    });
  }
  let out = input;
  if (out === "~" || out.startsWith("~/")) out = (env.HOME ?? "~") + out.slice(1);
  return out.replace(/\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a?: string, b?: string) => {
    const v = env[(a ?? b)!];
    return v ?? all;
  });
}

/* ------------------------------------------------------------------ */
/* Tiny logger                                                          */
/* ------------------------------------------------------------------ */
type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: number = LEVELS.info;
let logFile: string | undefined;

export function configureLogger(opts: { level?: Level; file?: string }) {
  if (opts.level) minLevel = LEVELS[opts.level];
  if (opts.file) {
    logFile = opts.file;
    try {
      // crude rotation: start fresh when the log grows past 5 MB
      if (statSync(logFile).size > 5 * 1024 * 1024) writeFileSync(logFile, "");
    } catch {
      /* file does not exist yet */
    }
  }
}

function emit(level: Level, msg: string, extra?: unknown) {
  if (LEVELS[level] < minLevel) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${
    extra === undefined ? "" : " " + (extra instanceof Error ? extra.message : JSON.stringify(extra))
  }`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n");
    } catch {
      /* ignore */
    }
  }
}
export const log = {
  debug: (m: string, x?: unknown) => emit("debug", m, x),
  info: (m: string, x?: unknown) => emit("info", m, x),
  warn: (m: string, x?: unknown) => emit("warn", m, x),
  error: (m: string, x?: unknown) => emit("error", m, x),
};

/** Log a recurring problem at most once per `everyMs`. */
export function throttled(everyMs: number) {
  let last = 0;
  return (fn: () => void) => {
    const now = Date.now();
    if (now - last >= everyMs) {
      last = now;
      fn();
    }
  };
}

/** Simple glob matching for sensor filters: "cpu_core_*" */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}
