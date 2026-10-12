import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const randomId = (bytes = 9) => randomBytes(bytes).toString("base64url");
export const sixDigits = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic-ish JSON write (tmp + rename). */
export function writeJson(file: string, data: unknown, mode?: number) {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n", mode);
}

export function writeFileAtomic(file: string, content: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/** "60s" | "5m" | "1h" | "1500ms" | number(ms) → ms */
export function parseDuration(v: string | number | undefined, fallbackMs: number): number {
  if (typeof v === "number") return v;
  if (!v) return fallbackMs;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(v);
  if (!m) return fallbackMs;
  const n = parseFloat(m[1]!);
  const unit = (m[2] || "s").toLowerCase();
  return Math.round(n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000));
}

/** Copy every entry of src into dest (recursive), without overwriting existing files. */
export function copyDirMissing(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirMissing(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

/** Resolve rel inside root; returns null if it escapes root. */
export function safeJoin(root: string, rel: string): string | null {
  const p = path.resolve(root, "." + path.sep + rel);
  const r = path.resolve(root);
  return p === r || p.startsWith(r + path.sep) ? p : null;
}
