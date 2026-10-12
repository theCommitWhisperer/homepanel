import type { AgentSensor, SensorKind } from "@homepanel/protocol";
import { globToRegExp } from "../util.js";

export interface SensorSource {
  readonly name: string;
  read(): Promise<AgentSensor[]>;
  /** human hint printed when read() fails */
  readonly hint?: string;
}

/** Unit-less categories the protocol doesn't have; they map to kind "other" and are hidden in "auto". */
export type ExtraKind = "voltage" | "current" | "control" | "factor" | "level" | "throughput" | "energy";

/** Track ids so the same name never produces two identical ids in one reading. */
export class IdAllocator {
  private used = new Set<string>();
  take(id: string): string {
    let candidate = id;
    for (let n = 2; this.used.has(candidate); n++) candidate = `${id}_${n}`;
    this.used.add(candidate);
    return candidate;
  }
  has(id: string) {
    return this.used.has(id);
  }
}

export const DEFAULT_HA_LOADS = ["cpu_total_load", "gpu_core_load", "ram_load"];

/** Kinds included when `sensors: auto` (everything except voltages, controls, raw factors...). */
const AUTO_KINDS = new Set<SensorKind>(["temperature", "load", "fan", "power", "clock", "data"]);

export interface InternalSensor extends AgentSensor {
  /** true for things like voltages/fan-control % that `auto` should not publish */
  hiddenByDefault?: boolean;
}

export function filterSensors(all: InternalSensor[], filter: "auto" | string[]): AgentSensor[] {
  const strip = ({ hiddenByDefault: _h, ...s }: InternalSensor): AgentSensor => s;
  if (filter === "auto") return all.filter((s) => AUTO_KINDS.has(s.kind) && !s.hiddenByDefault).map(strip);
  const res = filter.map(globToRegExp);
  return all.filter((s) => res.some((r) => r.test(s.id))).map(strip);
}

export function haSensorIds(
  published: AgentSensor[],
  setting: "default" | "none" | string[],
): AgentSensor[] {
  if (setting === "none") return [];
  if (setting === "default") {
    // all named temperatures (skip secondary NVMe sensors "_temp_2" and generic "temperature_6"
    // Super I/O inputs) + headline loads
    return published.filter(
      (s) =>
        (s.kind === "temperature" && !/_temp_\d+$|_temperature_\d+$/.test(s.id)) || DEFAULT_HA_LOADS.includes(s.id),
    );
  }
  const res = setting.map(globToRegExp);
  return published.filter((s) => res.some((r) => r.test(s.id)));
}
