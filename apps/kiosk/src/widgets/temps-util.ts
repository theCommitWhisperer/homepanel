export type Level = "ok" | "warn" | "crit";
export function level(v: number, warnAt: number, critAt: number): Level {
  return v >= critAt ? "crit" : v >= warnAt ? "warn" : "ok";
}
export const levelColor: Record<Level, string> = { ok: "var(--accent)", warn: "var(--warn)", crit: "var(--crit)" };
