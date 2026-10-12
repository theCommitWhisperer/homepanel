import type { InternalSensor } from "./sensors/types.js";

/* ------------------------------------------------------------------ */
/* tiny argv parser                                                     */
/* ------------------------------------------------------------------ */
export interface Parsed {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
}
const VALUE_FLAGS = new Set(["config", "c", "pc-id", "name", "mqtt-url", "mqtt-user", "mqtt-pass", "key", "lhm-url"]);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const m = a.match(/^--?([a-z][a-z0-9-]*)(?:=(.*))?$/i);
    if (!m) {
      positional.push(a);
      continue;
    }
    const name = m[1]!.toLowerCase();
    if (m[2] !== undefined) flags[name] = m[2];
    else if (VALUE_FLAGS.has(name) && i + 1 < argv.length) flags[name] = argv[++i]!;
    else flags[name] = true;
  }
  if (flags.c && !flags.config) flags.config = flags.c;
  return { command: positional.shift() ?? "run", positional, flags };
}

export const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);


export function sensorTable(rows: InternalSensor[], published: Set<string>, ha: Set<string>): string {
  const table = rows.map((s) => ({
    flags: `${published.has(s.id) ? "P" : " "}${ha.has(s.id) ? "H" : " "}`,
    id: s.id,
    name: s.name,
    value: `${s.value} ${s.unit}`.trim(),
    hardware: s.hardware ?? "",
  }));
  const cols = ["flags", "id", "name", "value", "hardware"] as const;
  const head = { flags: "PH", id: "id", name: "name", value: "value", hardware: "hardware" };
  const width = (c: (typeof cols)[number]) => Math.max(head[c].length, ...table.map((r) => r[c].length));
  const w = Object.fromEntries(cols.map((c) => [c, width(c)])) as Record<(typeof cols)[number], number>;
  const line = (r: Record<string, string>) => cols.map((c) => (c === "value" ? r[c]!.padStart(w[c]) : r[c]!.padEnd(w[c]))).join("  ").trimEnd();
  return [line(head), cols.map((c) => "-".repeat(w[c])).join("  "), ...table.map(line)].join("\n");
}

