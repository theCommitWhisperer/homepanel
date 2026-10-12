/**
 * Built-in sensors from Node's `os` module — work everywhere, with or without
 * LibreHardwareMonitor: CPU load (from os.cpus() time deltas), memory load / used, and the
 * 1-minute load average on Linux/macOS.
 *
 * Ids deliberately match the LHM ones (cpu_load_total, ram_load, ram_used) so dashboards do not
 * care where a value came from; when LHM supplies the same id, LHM wins (see combine()).
 */
import os from "node:os";
import { round } from "../util.js";
import type { InternalSensor, SensorSource } from "./types.js";

export interface CpuSample {
  idle: number;
  total: number;
}

export function sampleCpus(cpus: os.CpuInfo[] = os.cpus()): CpuSample[] {
  return cpus.map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}

/** Busy % between two samples (overall and per logical CPU). */
export function cpuLoad(prev: CpuSample[], cur: CpuSample[]): { total: number; perCpu: number[] } {
  let idle = 0;
  let total = 0;
  const perCpu: number[] = [];
  for (let i = 0; i < Math.min(prev.length, cur.length); i++) {
    const di = cur[i]!.idle - prev[i]!.idle;
    const dt = cur[i]!.total - prev[i]!.total;
    idle += di;
    total += dt;
    perCpu.push(dt > 0 ? round(clamp((1 - di / dt) * 100), 1) : 0);
  }
  return { total: total > 0 ? round(clamp((1 - idle / total) * 100), 1) : 0, perCpu };
}
const clamp = (v: number) => Math.min(100, Math.max(0, v));

export class OsSource implements SensorSource {
  readonly name = "built-in (os)";
  private prev: CpuSample[];
  constructor(
    private osApi: Pick<typeof os, "cpus" | "totalmem" | "freemem" | "loadavg"> = os,
    private platform: NodeJS.Platform = process.platform,
  ) {
    this.prev = sampleCpus(this.osApi.cpus());
  }
  async read(): Promise<InternalSensor[]> {
    const cpus = this.osApi.cpus();
    const cur = sampleCpus(cpus);
    const { total, perCpu } = cpuLoad(this.prev, cur);
    this.prev = cur;
    const model = cpus[0]?.model?.trim() || "CPU";
    const out: InternalSensor[] = [
      { id: "cpu_load_total", name: "CPU Load", kind: "load", value: total, unit: "%", hardware: model },
      ...perCpu.map(
        (v, i): InternalSensor => ({
          id: `cpu_load_thread${i + 1}`,
          name: `CPU Thread #${i + 1} Load`,
          kind: "load",
          value: v,
          unit: "%",
          hardware: model,
          hiddenByDefault: true,
        }),
      ),
    ];
    const totalMem = this.osApi.totalmem();
    const free = this.osApi.freemem();
    if (totalMem > 0) {
      out.push(
        { id: "ram_load", name: "Memory Load", kind: "load", value: round(((totalMem - free) / totalMem) * 100, 1), unit: "%", hardware: "Memory" },
        { id: "ram_used", name: "Memory Used", kind: "data", value: round((totalMem - free) / 1024 ** 3, 1), unit: "GB", hardware: "Memory" },
      );
    }
    if (this.platform !== "win32") {
      out.push({ id: "load_avg_1m", name: "Load Average (1 min)", kind: "other", value: round(this.osApi.loadavg()[0] ?? 0, 2), unit: "", hardware: "OS" });
    }
    return out;
  }
}

/**
 * Merge a primary source (LHM / hwmon / mock) with the built-in one. Primary ids win; a
 * failing primary does not take the built-ins down with it.
 */
export class CombinedSource implements SensorSource {
  readonly name: string;
  readonly hint?: string;
  lastPrimaryError?: Error;
  constructor(
    private primary: SensorSource | undefined,
    private builtin: SensorSource,
  ) {
    this.name = primary ? `${primary.name} + built-in` : builtin.name;
    this.hint = primary?.hint;
  }
  async read(): Promise<InternalSensor[]> {
    const base = await this.builtin.read();
    if (!this.primary) return base;
    let main: InternalSensor[] = [];
    try {
      main = await this.primary.read();
      this.lastPrimaryError = undefined;
    } catch (e) {
      this.lastPrimaryError = e as Error;
    }
    const have = new Set(main.map((s) => s.id));
    return [...main, ...base.filter((s) => !have.has(s.id))];
  }
}
