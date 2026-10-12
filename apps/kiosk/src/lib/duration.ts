/** Parse "5m", "30s", "1h", "1h30m", "500ms" or a bare number of seconds → milliseconds. Returns null when invalid. */
export function parseDuration(input: string | number | undefined | null): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? input * 1000 : null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s) * 1000;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = parseFloat(m[1]);
    const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms"]!;
    total += n * mult;
    consumed += m[0].length;
  }
  if (consumed !== s.replace(/\s+/g, "").length && consumed !== s.length) return null;
  return consumed > 0 ? total : null;
}
