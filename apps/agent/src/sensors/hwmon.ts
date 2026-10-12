/**
 * Linux sensors: /sys/class/hwmon/hwmon* (temperatures, fans, power) + /proc/stat (CPU load)
 * + /proc/meminfo (RAM load). No lm-sensors package needed.
 *
 * Driver names → id prefixes:
 *   k10temp / zenpower / coretemp / cpu_thermal  → cpu_*    (Tctl/Package → cpu_package)
 *   amdgpu / nouveau / radeon / i915 / xe         → gpu_*    (edge → gpu_core, junction → gpu_hotspot, mem → gpu_memory_junction)
 *   nvme                                          → nvme_<model-slug>_temp
 *   nct* / it87 / acpitz / asus* / ...            → mainboard_* (fans → fan_<n>)
 */
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { SensorKind } from "@homepanel/protocol";
import { round, slugify } from "../util.js";
import { IdAllocator, type InternalSensor, type SensorSource } from "./types.js";

const CPU_DRIVERS = new Set(["k10temp", "zenpower", "coretemp", "cpu_thermal", "fam15h_power"]);
const GPU_DRIVERS = new Set(["amdgpu", "nouveau", "radeon", "i915", "xe"]);

async function readTrim(p: string): Promise<string | undefined> {
  try {
    return (await readFile(p, "utf8")).trim();
  } catch {
    return undefined;
  }
}

async function nvmeModel(chipDir: string): Promise<string | undefined> {
  // hwmonN/device -> .../nvme/nvme0 ; model is in device/model
  const m = await readTrim(join(chipDir, "device", "model"));
  if (m) return m;
  try {
    const link = await readlink(join(chipDir, "device"));
    return link.split("/").pop();
  } catch {
    return undefined;
  }
}

function cpuTempSlug(label: string, idx: number): string {
  const l = label.toLowerCase();
  if (/^(tctl|tdie|package id \d+|cpu|physical id \d+)$/.test(l) || (l === "" && idx === 1)) return "package";
  if (/^tccd\d+$/.test(l)) return `ccd${l.slice(4)}`;
  const core = l.match(/^core (\d+)$/);
  if (core) return `core_${Number(core[1]) + 1}`; // coretemp counts from 0; LHM from 1 — match LHM
  return slugify(label) || `temp${idx}`;
}

function gpuTempSlug(label: string, idx: number): string {
  const l = label.toLowerCase();
  if (l === "edge" || l === "" || l === "gpu") return "core";
  if (l === "junction" || l === "hotspot") return "hotspot";
  if (l === "mem" || l === "vram") return "memory_junction";
  return slugify(label) || `temp${idx}`;
}

export async function readHwmon(root = "/sys/class/hwmon"): Promise<InternalSensor[]> {
  let entries: string[];
  try {
    entries = (await readdir(root)).filter((e) => e.startsWith("hwmon"));
  } catch {
    return [];
  }
  entries.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));

  const ids = new IdAllocator();
  const out: InternalSensor[] = [];
  let gpuCount = 0;
  let mainboardFan = 0;

  for (const e of entries) {
    const dir = join(root, e);
    const driver = (await readTrim(join(dir, "name"))) ?? e;
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }

    let prefix: string;
    let hardware: string = driver;
    let category: "cpu" | "gpu" | "nvme" | "mainboard" | "other";
    if (CPU_DRIVERS.has(driver)) {
      category = "cpu";
      prefix = "cpu";
    } else if (GPU_DRIVERS.has(driver)) {
      category = "gpu";
      gpuCount++;
      prefix = gpuCount === 1 ? "gpu" : `gpu${gpuCount}`;
    } else if (driver === "nvme") {
      category = "nvme";
      const model = (await nvmeModel(dir)) ?? e;
      hardware = model;
      prefix = `nvme_${slugify(model)}`;
    } else if (/^(nct|it8|f71|w83|asus|acpitz|gigabyte|dell|thinkpad|applesmc|nzxt)/.test(driver)) {
      category = "mainboard";
      prefix = "mainboard";
    } else {
      category = "other";
      prefix = slugify(driver);
    }

    const temps = files.filter((f) => /^temp\d+_input$/.test(f)).sort(byIndex);
    for (const f of temps) {
      const idx = Number(f.match(/\d+/)![0]);
      const raw = await readTrim(join(dir, f));
      if (raw === undefined || raw === "") continue;
      const milli = Number(raw);
      if (!Number.isFinite(milli)) continue;
      const label = (await readTrim(join(dir, `temp${idx}_label`))) ?? "";
      let slug: string;
      let name: string;
      if (category === "cpu") {
        slug = cpuTempSlug(label, idx);
        name = slug === "package" ? "CPU Package" : `CPU ${label || `Temp ${idx}`}`;
      } else if (category === "gpu") {
        slug = gpuTempSlug(label, idx);
        name = { core: "GPU Core", hotspot: "GPU Hot Spot", memory_junction: "GPU Memory Junction" }[slug] ?? `GPU ${label}`;
      } else if (category === "nvme") {
        slug = idx === 1 || /composite/i.test(label) ? "temp" : `temp_${slugify(label) || idx}`;
        name = `${hardware} ${idx === 1 ? "Temperature" : label || `Temp ${idx}`}`;
      } else {
        slug = slugify(label) || `temp${idx}`;
        name = category === "mainboard" ? `Motherboard ${label || `Temp ${idx}`}` : `${driver} ${label || `temp${idx}`}`;
      }
      const value = round(milli / 1000, 1);
      out.push({
        id: ids.take(`${prefix}_${slug}`),
        name,
        kind: "temperature",
        value,
        unit: "°C",
        hardware,
        ...(value <= 0 || value >= 127 ? { hiddenByDefault: true } : {}),
      });
    }

    const fans = files.filter((f) => /^fan\d+_input$/.test(f)).sort(byIndex);
    for (const f of fans) {
      const idx = Number(f.match(/\d+/)![0]);
      const raw = await readTrim(join(dir, f));
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      const label = (await readTrim(join(dir, `fan${idx}_label`))) ?? "";
      let id: string;
      if (category === "mainboard") id = `fan_${++mainboardFan}`;
      else id = `${prefix}_fan${fans.length > 1 ? `_${idx}` : ""}`;
      out.push({
        id: ids.take(id),
        name: label || (category === "gpu" ? "GPU Fan" : `Fan #${category === "mainboard" ? mainboardFan : idx}`),
        kind: "fan",
        value: v,
        unit: "RPM",
        hardware,
      });
    }

    const powers = files.filter((f) => /^power\d+_(input|average)$/.test(f)).sort(byIndex);
    const seenPower = new Set<number>();
    for (const f of powers) {
      const idx = Number(f.match(/\d+/)![0]);
      if (seenPower.has(idx)) continue;
      seenPower.add(idx);
      const v = Number(await readTrim(join(dir, f)));
      if (!Number.isFinite(v)) continue;
      out.push({
        id: ids.take(`${prefix}_${category === "gpu" ? "package" : `power${idx}`}_power`.replace(/power\d+_power$/, "power")),
        name: category === "gpu" ? "GPU Package" : `${driver} Power`,
        kind: "power",
        value: round(v / 1e6, 1),
        unit: "W",
        hardware,
      });
    }

    if (category === "gpu") {
      // amdgpu exposes busy % on the PCI device
      const busy = await readTrim(join(dir, "device", "gpu_busy_percent"));
      if (busy !== undefined && Number.isFinite(Number(busy))) {
        out.push({ id: ids.take(`${prefix}_core_load`), name: "GPU Core", kind: "load", value: Number(busy), unit: "%", hardware });
      }
    }
  }
  return out;
}

function byIndex(a: string, b: string) {
  return Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]);
}

/* ------------------------------------------------------------------ */
/* /proc/stat CPU load (delta between two reads)                        */
/* ------------------------------------------------------------------ */
export interface CpuTimes {
  idle: number;
  total: number;
}
export function parseProcStat(text: string): Map<string, CpuTimes> {
  const m = new Map<string, CpuTimes>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const [name, ...rest] = line.trim().split(/\s+/);
    const n = rest.map(Number);
    const idle = (n[3] ?? 0) + (n[4] ?? 0); // idle + iowait
    const total = n.slice(0, 8).reduce((a, b) => a + b, 0); // exclude guest (already in user)
    m.set(name!, { idle, total });
  }
  return m;
}
export function loadPercent(prev: CpuTimes, cur: CpuTimes): number {
  const dt = cur.total - prev.total;
  if (dt <= 0) return 0;
  return round(Math.min(100, Math.max(0, (1 - (cur.idle - prev.idle) / dt) * 100)), 1);
}

export function parseMeminfo(text: string): { totalKb: number; availKb: number } | null {
  const get = (k: string) => Number(text.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1]);
  const totalKb = get("MemTotal");
  const availKb = get("MemAvailable");
  if (!Number.isFinite(totalKb) || !Number.isFinite(availKb)) return null;
  return { totalKb, availKb };
}

export class HwmonSource implements SensorSource {
  readonly name = "Linux hwmon";
  readonly hint = "No /sys/class/hwmon sensors found. Try `sudo modprobe k10temp` (AMD) or `coretemp` (Intel), or run `sensors-detect`.";
  private prev?: Map<string, CpuTimes>;
  constructor(
    private root = "/sys/class/hwmon",
    private procRoot = "/proc",
  ) {}
  async read(): Promise<InternalSensor[]> {
    const sensors = await readHwmon(this.root);
    const stat = await readTrim(join(this.procRoot, "stat"));
    if (stat) {
      const cur = parseProcStat(stat);
      if (this.prev) {
        const prevTotal = this.prev.get("cpu");
        const curTotal = cur.get("cpu");
        if (prevTotal && curTotal) {
          sensors.push({ id: "cpu_total_load", name: "CPU Total", kind: "load", value: loadPercent(prevTotal, curTotal), unit: "%", hardware: "CPU" });
        }
        for (const [name, t] of cur) {
          const p = this.prev.get(name);
          if (name === "cpu" || !p) continue;
          const n = Number(name.slice(3)) + 1;
          sensors.push({
            id: `cpu_thread_${n}_load`,
            name: `CPU Thread #${n}`,
            kind: "load",
            value: loadPercent(p, t),
            unit: "%",
            hardware: "CPU",
            hiddenByDefault: true,
          });
        }
      }
      this.prev = cur;
    }
    const mem = await readTrim(join(this.procRoot, "meminfo"));
    const mi = mem ? parseMeminfo(mem) : null;
    if (mi && mi.totalKb > 0) {
      const usedGb = (mi.totalKb - mi.availKb) / 1024 / 1024;
      sensors.push({ id: "ram_load", name: "Memory", kind: "load", value: round((1 - mi.availKb / mi.totalKb) * 100, 1), unit: "%", hardware: "Memory" });
      sensors.push({ id: "ram_used", name: "Memory Used", kind: "data", value: round(usedGb, 1), unit: "GB", hardware: "Memory" });
    }
    return sensors;
  }
}

export type { SensorKind };
