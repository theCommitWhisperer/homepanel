import { round } from "../util.js";
import type { InternalSensor, SensorSource } from "./types.js";

interface Spec {
  id: string;
  name: string;
  kind: InternalSensor["kind"];
  unit: string;
  base: number;
  amp: number;
  period: number; // seconds
  min?: number;
  max?: number;
  hardware: string;
}

const CPU = "AMD Ryzen 7 7800X3D (mock)";
const GPU = "NVIDIA GeForce RTX 4080 SUPER (mock)";
const SPECS: Spec[] = [
  { id: "cpu_package", name: "CPU Package", kind: "temperature", unit: "°C", base: 58, amp: 9, period: 47, hardware: CPU },
  { id: "cpu_ccd1", name: "CPU CCD1 (Tdie)", kind: "temperature", unit: "°C", base: 54, amp: 8, period: 47, hardware: CPU },
  { id: "cpu_total_load", name: "CPU Total", kind: "load", unit: "%", base: 22, amp: 18, period: 31, min: 0, max: 100, hardware: CPU },
  { id: "cpu_package_power", name: "CPU Package", kind: "power", unit: "W", base: 55, amp: 25, period: 31, hardware: CPU },
  { id: "gpu_core", name: "GPU Core", kind: "temperature", unit: "°C", base: 56, amp: 12, period: 73, hardware: GPU },
  { id: "gpu_hotspot", name: "GPU Hot Spot", kind: "temperature", unit: "°C", base: 69, amp: 13, period: 73, hardware: GPU },
  { id: "gpu_memory_junction", name: "GPU Memory Junction", kind: "temperature", unit: "°C", base: 64, amp: 8, period: 90, hardware: GPU },
  { id: "gpu_core_load", name: "GPU Core", kind: "load", unit: "%", base: 45, amp: 45, period: 53, min: 0, max: 100, hardware: GPU },
  { id: "gpu_package_power", name: "GPU Package", kind: "power", unit: "W", base: 160, amp: 120, period: 53, min: 15, hardware: GPU },
  { id: "gpu_fan_1", name: "GPU Fan 1", kind: "fan", unit: "RPM", base: 1300, amp: 500, period: 73, min: 0, hardware: GPU },
  { id: "ram_load", name: "Memory", kind: "load", unit: "%", base: 47, amp: 4, period: 120, hardware: "Generic Memory" },
  { id: "nvme_samsung_ssd_990_pro_2tb_temp", name: "Samsung SSD 990 PRO Temperature", kind: "temperature", unit: "°C", base: 42, amp: 3, period: 200, hardware: "Samsung SSD 990 PRO 2TB" },
  { id: "nvme_wd_black_sn850x_4000gb_temp", name: "WD_BLACK SN850X Temperature", kind: "temperature", unit: "°C", base: 39, amp: 3, period: 230, hardware: "WD_BLACK SN850X 4000GB" },
  { id: "mainboard_vrm_mos", name: "Motherboard VRM MOS", kind: "temperature", unit: "°C", base: 42, amp: 4, period: 110, hardware: "Mock Motherboard" },
  { id: "fan_2", name: "Fan #2", kind: "fan", unit: "RPM", base: 1150, amp: 250, period: 61, hardware: "Mock Motherboard" },
];

/** Smooth sine + jitter so dashboards look alive in --mock mode. */
export class MockSource implements SensorSource {
  readonly name = "mock";
  private t0 = Date.now();
  constructor(private now: () => number = Date.now) {}
  async read(): Promise<InternalSensor[]> {
    const t = (this.now() - this.t0) / 1000;
    return SPECS.map((s) => {
      let v = s.base + s.amp * Math.sin((2 * Math.PI * t) / s.period + s.id.length) + (Math.random() - 0.5) * s.amp * 0.1;
      if (s.min !== undefined) v = Math.max(s.min, v);
      if (s.max !== undefined) v = Math.min(s.max, v);
      return { id: s.id, name: s.name, kind: s.kind, unit: s.unit, value: round(v, s.unit === "RPM" ? 0 : 1), hardware: s.hardware };
    });
  }
}
