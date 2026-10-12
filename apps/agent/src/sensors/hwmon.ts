/**
 * Linux sensors: /sys/class/hwmon/hwmon* (temperatures, fans, power) and /sys/class/thermal
 * (thermal zones; the only source on many mini PCs / SBCs). No lm-sensors package needed.
 * CPU and memory load come from the cross-platform OS source (os.ts).
 *
 * Driver names → ids (same scheme as the LibreHardwareMonitor parser):
 *   k10temp / zenpower / coretemp / cpu_thermal  → cpu_*   (Tctl / Package id 0 → cpu_package, Core 0 → cpu_core1)
 *   amdgpu / nouveau / radeon / i915 / xe         → gpu_*   (edge → gpu_core, junction → gpu_hotspot, mem → gpu_memory_junction)
 *   nvme                                          → nvme0_temp, nvme1_temp ... (in hwmon order)
 *   nct* / it87 / acpitz / asus* / ...            → mb_*    (fans → fan1, fan2 ...)
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
  if (l === "core max") return "core_max";
  const core = l.match(/^core (\d+)$/);
  if (core) return `core${Number(core[1]) + 1}`; // coretemp counts from 0; LHM from 1 — match LHM
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
  let nvmeCount = 0;
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
      prefix = `nvme${nvmeCount++}`;
    } else if (/^(nct|it8|f71|w83|asus|acpitz|gigabyte|dell|thinkpad|applesmc|nzxt)/.test(driver)) {
      category = "mainboard";
      prefix = "mb";
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
        slug = idx === 1 || /composite/i.test(label) ? "temp" : /^sensor \d+$/i.test(label) ? `temp${label.match(/\d+/)![0]}` : `temp_${slugify(label) || idx}`;
        name = `${hardware} ${idx === 1 ? "Temperature" : label || `Temp ${idx}`}`;
      } else if (category === "mainboard" && /^(systin|system|motherboard)$/i.test(label)) {
        slug = "";
        name = "Motherboard";
      } else {
        slug = slugify(label) || `temp${idx}`;
        name = category === "mainboard" ? `Motherboard ${label || `Temp ${idx}`}` : `${driver} ${label || `temp${idx}`}`;
      }
      const value = round(milli / 1000, 1);
      out.push({
        id: ids.take(slug ? `${prefix}_${slug}` : "motherboard"),
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
      if (category === "mainboard") id = `fan${++mainboardFan}`;
      else id = `${prefix}_fan${fans.length > 1 ? idx : ""}`;
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
        id: ids.take(`${prefix}_power`),
        name: category === "gpu" ? "GPU Power" : category === "cpu" ? "CPU Power" : `${driver} Power`,
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
        out.push({ id: ids.take(`${prefix}_load_core`), name: "GPU Core Load", kind: "load", value: Number(busy), unit: "%", hardware });
      }
    }
  }
  return out;
}

function byIndex(a: string, b: string) {
  return Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]);
}

/* ------------------------------------------------------------------ */
/* /sys/class/thermal                                                   */
/* ------------------------------------------------------------------ */
const CPU_ZONES = /^(x86_pkg_temp|cpu[-_]thermal|soc[-_]thermal|cpu|tcpu|k10temp)$/i;

/**
 * Thermal zones. Most duplicate a hwmon chip (acpitz, x86_pkg_temp ≈ coretemp), so they are
 * hidden unless hwmon had no CPU temperature, in which case the CPU zone becomes cpu_package
 * (Raspberry Pi, many ARM boards and some Intel mini PCs).
 */
export async function readThermalZones(root = "/sys/class/thermal", haveCpuTemp = false): Promise<InternalSensor[]> {
  let entries: string[];
  try {
    entries = (await readdir(root)).filter((e) => /^thermal_zone\d+$/.test(e));
  } catch {
    return [];
  }
  entries.sort((a, b) => Number(a.slice(12)) - Number(b.slice(12)));
  const ids = new IdAllocator();
  const out: InternalSensor[] = [];
  let usedCpu = haveCpuTemp;
  for (const e of entries) {
    const type = (await readTrim(join(root, e, "type"))) ?? e;
    const milli = Number(await readTrim(join(root, e, "temp")));
    if (!Number.isFinite(milli)) continue;
    const value = round(milli / 1000, 1);
    if (!usedCpu && CPU_ZONES.test(type)) {
      usedCpu = true;
      out.push({ id: ids.take("cpu_package"), name: "CPU Package", kind: "temperature", value, unit: "°C", hardware: type });
      continue;
    }
    out.push({
      id: ids.take(`thermal_${slugify(type) || e}`),
      name: `Thermal ${type}`,
      kind: "temperature",
      value,
      unit: "°C",
      hardware: type,
      hiddenByDefault: true,
    });
  }
  return out;
}

export class HwmonSource implements SensorSource {
  readonly name = "Linux hwmon";
  readonly hint = "No /sys/class/hwmon sensors found. Try `sudo modprobe k10temp` (AMD) or `coretemp` (Intel), or run `sensors-detect`.";
  constructor(
    private root = "/sys/class/hwmon",
    private thermalRoot = "/sys/class/thermal",
  ) {}
  async read(): Promise<InternalSensor[]> {
    const hw = await readHwmon(this.root);
    const haveCpu = hw.some((s) => s.id === "cpu_package");
    const zones = await readThermalZones(this.thermalRoot, haveCpu);
    const taken = new Set(hw.map((s) => s.id));
    return [...hw, ...zones.filter((z) => !taken.has(z.id))];
  }
}

export type { SensorKind };
