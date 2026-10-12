/**
 * LibreHardwareMonitor "Remote Web Server" (http://localhost:8085/data.json) → AgentSensor[].
 *
 * The JSON is a tree: root → computer → hardware → (sub-hardware) → sensor group → sensor.
 * Every node has Text/Min/Value/Max strings; sensors carry formatted values ("45.0 °C",
 * "1,243 RPM", "12.3 %"). Newer LHM versions (0.9.3+) also add `SensorId`
 * ("/amdcpu/0/temperature/2"), `Type` ("Temperature") and `HardwareId` — we use them when
 * present but don't rely on them, so older builds parse the same way.
 *
 * Ids are stable slugs derived from the hardware *category* and the sensor *name*, never from
 * LHM's running node numbers, so they survive reboots and LHM updates:
 *   cpu_package, cpu_ccd1, cpu_core_1, cpu_total_load, cpu_package_power,
 *   gpu_core, gpu_hotspot, gpu_memory_junction, gpu_core_load, gpu_fan_1,
 *   nvme_samsung_ssd_990_pro_2tb_temp, mainboard_vrm_mos, fan_2, ram_load ...
 */
import type { SensorKind } from "@homepanel/protocol";
import { parseValueWithUnit, round, slugify, throttled, log } from "../util.js";
import { IdAllocator, type InternalSensor, type SensorSource } from "./types.js";

export interface LhmNode {
  id?: number;
  Text: string;
  Min?: string;
  Value?: string;
  Max?: string;
  ImageURL?: string;
  SensorId?: string;
  Type?: string;
  HardwareId?: string;
  Children?: LhmNode[];
}

type HwCategory = "cpu" | "gpu" | "storage-nvme" | "storage" | "mainboard" | "ram" | "nic" | "battery" | "psu" | "cooler" | "other";

interface HwCtx {
  category: HwCategory;
  name: string; // e.g. "AMD Ryzen 7 7800X3D"
  vendor?: "nvidia" | "amd" | "intel";
  key: string; // identity for grouping (HardwareId or path)
}

interface RawSensor {
  hw: HwCtx;
  name: string;
  type: string; // normalised LHM SensorType, e.g. "Temperature"
  value: number;
  unit: string;
}

const ICON_CATEGORY: Record<string, { category: HwCategory; vendor?: HwCtx["vendor"] }> = {
  cpu: { category: "cpu" },
  nvidia: { category: "gpu", vendor: "nvidia" },
  ati: { category: "gpu", vendor: "amd" },
  amd: { category: "gpu", vendor: "amd" },
  intel: { category: "gpu", vendor: "intel" },
  hdd: { category: "storage" },
  ram: { category: "ram" },
  mainboard: { category: "mainboard" },
  chip: { category: "mainboard" },
  bigng: { category: "mainboard" },
  nic: { category: "nic" },
  battery: { category: "battery" },
  psu: { category: "psu" },
  water: { category: "cooler" },
};

function hardwareFromNode(n: LhmNode): HwCtx | null {
  const hid = n.HardwareId?.toLowerCase();
  if (hid) {
    const head = hid.split("/")[1] ?? "";
    const c = (category: HwCategory, vendor?: HwCtx["vendor"]): HwCtx => ({ category, vendor, name: n.Text, key: hid });
    if (head.endsWith("cpu")) return c("cpu");
    if (head === "gpu-nvidia") return c("gpu", "nvidia");
    if (head === "gpu-amd" || head === "atigpu") return c("gpu", "amd");
    if (head === "gpu-intel") return c("gpu", "intel");
    if (head === "nvme") return c("storage-nvme");
    if (head === "hdd" || head === "ssd" || head === "storage") return c("storage");
    if (head === "motherboard" || head === "lpc" || head === "ec" || head === "mainboard") return c("mainboard");
    if (head === "ram" || head === "memory") return c("ram");
    if (head === "nic") return c("nic");
    if (head === "battery") return c("battery");
    if (head === "psu") return c("psu");
    return c("other");
  }
  const icon = n.ImageURL?.match(/images_icon\/([a-z0-9_-]+)\.png$/i)?.[1]?.toLowerCase();
  if (!icon || icon === "computer") return null;
  // Sensor groups ("Fans", "Powers"...) also use images_icon/<type>.png; their children are leaf
  // sensors. Hardware nodes contain groups (or sub-hardware), i.e. children that have children.
  const isContainerOfContainers = (n.Children ?? []).some((c) => (c.Children?.length ?? 0) > 0);
  if (!isContainerOfContainers) return null;
  const hit = ICON_CATEGORY[icon];
  // Group nodes ("Temperatures", "Load" ...) also use images_icon/*.png in LHM; they are not hardware.
  if (!hit) return null;
  let category = hit.category;
  if (category === "storage" && /nvme|\b(970|980|990|9100)\b|sn\d{3}/i.test(n.Text)) category = "storage-nvme";
  return { category, vendor: hit.vendor, name: n.Text, key: n.Text };
}

const GROUP_TEXT_TYPE: Record<string, string> = {
  voltages: "Voltage",
  currents: "Current",
  clocks: "Clock",
  temperatures: "Temperature",
  load: "Load",
  frequencies: "Frequency",
  fans: "Fan",
  flows: "Flow",
  controls: "Control",
  levels: "Level",
  factors: "Factor",
  powers: "Power",
  data: "Data",
  throughput: "Throughput",
  energy: "Energy",
  noise: "Noise",
  timing: "Timing",
  humidity: "Humidity",
  conductivity: "Conductivity",
};

function sensorType(sensor: LhmNode, groupText: string | undefined, unit: string): string {
  if (sensor.Type) return sensor.Type === "SmallData" ? "Data" : sensor.Type;
  const seg = sensor.SensorId?.split("/").at(-2);
  if (seg) {
    const t = seg === "smalldata" ? "Data" : seg[0]!.toUpperCase() + seg.slice(1);
    return t;
  }
  const byGroup = groupText ? GROUP_TEXT_TYPE[groupText.toLowerCase()] : undefined;
  if (byGroup) return byGroup;
  if (unit === "°C") return "Temperature";
  if (unit === "%") return "Load";
  if (unit === "RPM") return "Fan";
  if (unit === "W") return "Power";
  if (unit === "MHz") return "Clock";
  if (unit === "V") return "Voltage";
  if (unit === "GB" || unit === "MB") return "Data";
  return "Other";
}

const KIND: Record<string, SensorKind> = {
  Temperature: "temperature",
  Load: "load",
  Fan: "fan",
  Power: "power",
  Clock: "clock",
  Data: "data",
};
/** Suffix appended to non-temperature ids (temperatures get the short name). */
const SUFFIX: Record<string, string> = {
  Load: "load",
  Fan: "fan",
  Power: "power",
  Clock: "clock",
  Data: "",
  Voltage: "voltage",
  Current: "current",
  Control: "control",
  Level: "level",
  Factor: "factor",
  Throughput: "rate",
  Energy: "energy",
  Frequency: "freq",
};

export function collectRaw(root: LhmNode): RawSensor[] {
  const out: RawSensor[] = [];
  const visit = (n: LhmNode, hw: HwCtx | null, parent: LhmNode | null) => {
    const asHw = hardwareFromNode(n);
    let ctx = hw;
    if (asHw) {
      // Super I/O chips sit under the motherboard: keep the board name as the hardware label.
      ctx = hw && hw.category === "mainboard" && asHw.category === "mainboard" ? { ...asHw, name: hw.name } : asHw;
    }
    const kids = n.Children ?? [];
    if (kids.length === 0) {
      if (!ctx || !n.Value) return;
      const parsed = parseValueWithUnit(n.Value);
      if (!parsed) return;
      const type = sensorType(n, parent?.Text, parsed.unit);
      out.push({ hw: ctx, name: n.Text.trim(), type, value: parsed.value, unit: normaliseUnit(parsed.unit) });
      return;
    }
    for (const k of kids) visit(k, ctx, n);
  };
  visit(root, null, null);
  return out;
}

function normaliseUnit(u: string): string {
  if (u === "C" || u === "℃") return "°C";
  return u;
}

/** Integrated GPUs rank below discrete ones so "gpu_*" is the card you game on. */
function gpuRank(h: HwCtx): number {
  const integrated =
    /radeon\s*\(tm\)\s*graphics$|radeon graphics$|vega \d+ graphics|uhd graphics|iris|hd graphics|780m|760m|680m|610m/i.test(
      h.name,
    );
  if (integrated) return 0;
  if (h.vendor === "nvidia") return 3;
  return 2;
}

function strip(name: string, ...prefixes: RegExp[]): string {
  let s = name;
  for (const p of prefixes) s = s.replace(p, "");
  return s.trim() || name;
}

/** Map one raw sensor to (base id, label). */
function nameSlug(r: RawSensor): string {
  const t = r.type;
  const n = r.name;
  switch (r.hw.category) {
    case "cpu": {
      if (t === "Temperature" && /^(core \(tctl\/tdie\)|cpu package|package|core \(tctl\)|tctl\/tdie)$/i.test(n))
        return "package";
      if (t === "Load" && /^cpu total$/i.test(n)) return "total";
      // "CPU Core #1" -> core_1 ; "CCD1 (Tdie)" -> ccd1 ; "Core #1 (SMU)" -> core_1 ; "CPU Core #1 Thread #2" -> core_1_thread_2
      return slugify(strip(n, /^cpu\s+/i, /\s*\((tdie|smu|tctl)\)\s*$/i));
    }
    case "gpu": {
      if (/^gpu hot ?spot$/i.test(n)) return "hotspot";
      return slugify(strip(n, /^gpu\s+/i));
    }
    case "ram": {
      if (/^memory$/i.test(n)) return "";
      return slugify(strip(n, /^memory\s+/i));
    }
    case "storage":
    case "storage-nvme": {
      if (t === "Temperature" && /^(composite temperature|temperature|composite)$/i.test(n)) return "";
      return slugify(n);
    }
    default:
      return slugify(n);
  }
}

function prefixFor(r: RawSensor, gpuIndex: Map<string, number>, cpuIndex: Map<string, number>): string {
  switch (r.hw.category) {
    case "cpu": {
      const i = cpuIndex.get(r.hw.key) ?? 0;
      return i === 0 ? "cpu" : `cpu${i + 1}`;
    }
    case "gpu": {
      const i = gpuIndex.get(r.hw.key) ?? 0;
      return i === 0 ? "gpu" : `gpu${i + 1}`;
    }
    case "storage-nvme":
      return `nvme_${slugify(r.hw.name)}`;
    case "storage":
      return `disk_${slugify(r.hw.name)}`;
    case "mainboard":
      return "mainboard";
    case "ram":
      return "ram";
    case "nic":
      return `net_${slugify(r.hw.name)}`;
    case "battery":
      return "battery";
    case "psu":
      return `psu_${slugify(r.hw.name)}`;
    case "cooler":
      return `cooler_${slugify(r.hw.name)}`;
    default:
      return slugify(r.hw.name) || "hw";
  }
}

export function parseLhm(root: LhmNode): InternalSensor[] {
  const raw = collectRaw(root);

  // Deterministic CPU/GPU numbering independent of LHM's node order.
  const gpus = [...new Map(raw.filter((r) => r.hw.category === "gpu").map((r) => [r.hw.key, r.hw])).values()];
  gpus.sort((a, b) => gpuRank(b) - gpuRank(a) || a.key.localeCompare(b.key));
  const gpuIndex = new Map(gpus.map((g, i) => [g.key, i]));
  const cpus = [...new Set(raw.filter((r) => r.hw.category === "cpu").map((r) => r.hw.key))].sort();
  const cpuIndex = new Map(cpus.map((k, i) => [k, i]));

  const ids = new IdAllocator();
  const out: InternalSensor[] = [];
  for (const r of raw) {
    const kind: SensorKind = KIND[r.type] ?? "other";
    const prefix = prefixFor(r, gpuIndex, cpuIndex);
    const slug = nameSlug(r);
    let id: string;
    if (r.hw.category === "mainboard" && r.type === "Fan" && /^fan\s*#?\s*\d+$/i.test(r.name)) {
      // Motherboard headers get the short ids the dashboard uses: fan_1, fan_2 ...
      id = `fan_${r.name.match(/\d+/)![0]}`;
    } else {
      const suffix = r.type === "Temperature" ? "" : (SUFFIX[r.type] ?? slugify(r.type));
      const isStorageTemp = r.type === "Temperature" && r.hw.category.startsWith("storage");
      const parts = [prefix, slug];
      if (isStorageTemp) parts.push("temp");
      if (suffix && !slug.split("_").includes(suffix)) parts.push(suffix);
      id = parts.filter(Boolean).join("_");
      if (isStorageTemp && slug) id = `${prefix}_temp_${slug.replace(/^temperature_?/, "")}`;
    }
    id = ids.take(id.replace(/_+/g, "_"));

    const hidden =
      kind === "other" ||
      r.hw.category === "nic" ||
      /thread #\d+/i.test(r.name) || // per-thread loads: 16-32 rows of noise
      // unconnected Super I/O temperature inputs read 0 / -128 / 127+
      (r.type === "Temperature" && r.hw.category === "mainboard" && (r.value <= 0 || r.value >= 127)) ||
      (r.type === "Data" && r.hw.category === "gpu" && /d3d/i.test(r.name));
    out.push({
      id,
      name: labelFor(r),
      kind,
      value: round(r.value, r.unit === "V" ? 3 : 1),
      unit: r.unit,
      hardware: r.hw.name,
      ...(hidden ? { hiddenByDefault: true } : {}),
    });
  }
  return out;
}

function labelFor(r: RawSensor): string {
  const n = r.name;
  switch (r.hw.category) {
    case "cpu":
      if (r.type === "Temperature" && /tctl|package/i.test(n)) return "CPU Package";
      return /^cpu/i.test(n) ? n : `CPU ${n}`;
    case "gpu":
      return /^gpu/i.test(n) ? n : `GPU ${n}`;
    case "ram":
      return /memory/i.test(n) ? n : `Memory ${n}`;
    case "storage":
    case "storage-nvme": {
      const short = r.hw.name.replace(/\s+\d+(GB|TB)$/i, "");
      return `${short} ${/^composite temperature$/i.test(n) ? "Temperature" : n}`;
    }
    case "mainboard":
      return r.type === "Temperature" ? `Motherboard ${n}` : n;
    default:
      return `${r.hw.name} ${n}`;
  }
}

export class LhmSource implements SensorSource {
  readonly name = "LibreHardwareMonitor";
  readonly hint: string;
  private warn = throttled(60_000);
  constructor(
    private url: string,
    private auth?: { username: string; password: string },
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.hint =
      `Could not read ${url}. Is LibreHardwareMonitor running *as administrator* with ` +
      `Options → Remote Web Server → Run enabled (port 8085)?`;
  }
  async read(): Promise<InternalSensor[]> {
    const headers: Record<string, string> = {};
    if (this.auth) {
      headers.Authorization = "Basic " + Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64");
    }
    const res = await this.fetchImpl(this.url, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`LibreHardwareMonitor returned HTTP ${res.status}`);
    const json = (await res.json()) as LhmNode;
    const sensors = parseLhm(json);
    if (sensors.length === 0) {
      this.warn(() =>
        log.warn(
          "LibreHardwareMonitor answered but reported no sensors — it is probably not running elevated (right-click → Run as administrator).",
        ),
      );
    } else if (!sensors.some((s) => s.kind === "temperature" && s.id.startsWith("cpu"))) {
      this.warn(() => log.warn("No CPU temperature from LibreHardwareMonitor — run it as administrator so the PawnIO driver loads."));
    }
    return sensors;
  }
}
