/**
 * --mock sensor source: the bundled LibreHardwareMonitor fixture (Ryzen 7800X3D + RTX 4080
 * SUPER) run through the real parser, with every value drifting smoothly so dashboards look
 * alive. Lets the whole agent run end-to-end on Linux / CI without hardware.
 */
import fixture from "../fixtures/lhm-ryzen-nvidia.json" with { type: "json" };
import { parseLhm, type LhmNode } from "./lhm.js";
import { round } from "../util.js";
import type { InternalSensor, SensorSource } from "./types.js";

export function mockFixture(): LhmNode {
  return fixture as LhmNode;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

export class MockSource implements SensorSource {
  readonly name = "mock (LHM fixture)";
  private base = parseLhm(mockFixture());
  private t0: number;
  constructor(private now: () => number = Date.now) {
    this.t0 = now();
  }
  async read(): Promise<InternalSensor[]> {
    const t = (this.now() - this.t0) / 1000;
    return this.base.map((s) => {
      if (s.kind === "data" || s.kind === "other" || s.value === 0) return { ...s };
      const phase = hash(s.id) * 2 * Math.PI;
      const period = 30 + hash(s.id + "p") * 90;
      const amp = s.kind === "temperature" ? 6 : s.kind === "load" ? Math.min(25, s.value) : s.value * 0.15;
      let v = s.value + amp * Math.sin((2 * Math.PI * t) / period + phase) + (Math.random() - 0.5) * amp * 0.1;
      if (s.unit === "%") v = Math.min(100, Math.max(0, v));
      if (v < 0) v = 0;
      return { ...s, value: round(v, s.unit === "RPM" || s.unit === "MHz" ? 0 : 1) };
    });
  }
}
