/**
 * LibreHardwareMonitor "Remote Web Server" (http://localhost:8085/data.json) → AgentSensor[].
 *
 * data.json is a tree: root → computer → hardware → (sub-hardware) → sensor group → sensor.
 * Every node has Text/Min/Value/Max strings; sensors carry formatted values ("45.0 °C",
 * "1200 RPM", "35,2 %" in comma-decimal locales). Recent LHM builds add `SensorId`
 * ("/amdcpu/0/temperature/2"), `Type` ("Temperature") and `HardwareId` ("/amdcpu/0"); when
 * present we use them for the hardware category, index and sensor type. Older builds without
 * them are classified from ImageURL icons, group names and units, and give the same ids.
 *
 * Ids are stable slugs built from hardware category + index + sensor type + sensor name,
 * never from LHM's running node numbers, so they survive reboots and LHM updates:
 *
 *   cpu_package  cpu_core_max  cpu_ccd1  cpu_core3  cpu_load_total  cpu_power  cpu_clock_core1
 *   gpu_core  gpu_hotspot  gpu_memory_junction  gpu_load_core  gpu_fan1  gpu_power  gpu_memory_used
 *   nvme0_temp  nvme0_temp1  disk0_temp  motherboard  mb_vrm_mos  fan2  ram_load  ram_used
 *
 * A second CPU/GPU gets cpu2_/gpu2_. Discrete GPUs rank above integrated ones, so `gpu_*`
 * is always the card you game on.
 */
import type { SensorKind } from "@homepanel/protocol";
import { log, parseValueWithUnit, round, slugify, throttled } from "../util.js";
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

type Category = "cpu" | "gpu" | "nvme" | "disk" | "mainboard" | "ram" | "nic" | "battery" | "psu" | "cooler" | "other";
type Vendor = "nvidia" | "amd" | "intel" | undefined;

interface Hw {
  category: Category;
  vendor: Vendor;
  name: string;
  /** identity used for numbering: hardware path from LHM ids, or tree path */
  key: string;
  /** index from LHM's hardware path ("/nvme/1" → 1), if known */
  pathIndex?: number;
}

interface RawSensor {
  hw: Hw;
  name: string;
  type: string; // LHM SensorType: Temperature, Load, Fan, Power, Clock, Data, Voltage, ...
  value: number;
  unit: string;
}

/* ------------------------------------------------------------------ */
/* Hardware classification                                              */
/* ------------------------------------------------------------------ */
function fromHardwarePath(path: string): { category: Category; vendor: Vendor; pathIndex?: number } {
  const segs = path.toLowerCase().split("/").filter(Boolean);
  const head = segs[0] ?? "";
  const last = segs.at(-1);
  const pathIndex = last !== undefined && /^\d+$/.test(last) ? Number(last) : undefined;
  const c = (category: Category, vendor?: Vendor) => ({ category, vendor, pathIndex });
  if (head.endsWith("cpu")) return c("cpu", head.startsWith("intel") ? "intel" : head.startsWith("amd") ? "amd" : undefined);
  if (head === "gpu-nvidia" || head === "nvidiagpu") return c("gpu", "nvidia");
  if (head === "gpu-amd" || head === "atigpu" || head === "amdgpu") return c("gpu", "amd");
  if (head === "gpu-intel" || head === "intelgpu") return c("gpu", "intel");
  if (head === "nvme") return c("nvme");
  if (["hdd", "ssd", "ata", "storage", "scsi"].includes(head)) return c("disk");
  if (["motherboard", "mainboard", "lpc", "ec", "superio"].includes(head)) return c("mainboard");
  if (head === "ram" || head === "memory" || head === "dimm") return c("ram");
  if (head === "nic") return c("nic");
  if (head === "battery") return c("battery");
  if (head === "psu") return c("psu");
  if (["aquacomputer", "nzxt", "corsair", "heatmaster", "tbalancer", "aeroflow", "kraken", "razer"].some((x) => head.includes(x)))
    return c("cooler");
  return c("other");
}

const ICON: Record<string, { category: Category; vendor?: Vendor }> = {
  cpu: { category: "cpu" },
  nvidia: { category: "gpu", vendor: "nvidia" },
  ati: { category: "gpu", vendor: "amd" },
  amd: { category: "gpu", vendor: "amd" },
  intel: { category: "gpu", vendor: "intel" },
  hdd: { category: "disk" },
  ram: { category: "ram" },
  mainboard: { category: "mainboard" },
  chip: { category: "mainboard" },
  bigng: { category: "mainboard" },
  nic: { category: "nic" },
  battery: { category: "battery" },
  psu: { category: "psu" },
  water: { category: "cooler" },
  fan: { category: "cooler" },
};

const hasGrandchildren = (n: LhmNode) => (n.Children ?? []).some((c) => (c.Children?.length ?? 0) > 0);

/** Does this node look like an NVMe drive? (old LHM: no ids, same hdd.png icon for every disk) */
function looksNvme(n: LhmNode): boolean {
  const texts: string[] = [];
  const walk = (x: LhmNode) => {
    texts.push(x.Text);
    for (const c of x.Children ?? []) walk(c);
  };
  walk(n);
  return texts.some((t) => /^(available spare|composite temperature)$/i.test(t)) || /nvme/i.test(n.Text);
}

/** If `n` is a hardware node, describe it. Sensor groups ("Temperatures"...) are not hardware. */
function hardwareOf(n: LhmNode, treePath: string): Hw | null {
  if (n.HardwareId) {
    const h = fromHardwarePath(n.HardwareId);
    if (h.category === "disk" && looksNvme(n)) h.category = "nvme";
    return { ...h, name: n.Text.trim(), key: n.HardwareId.toLowerCase() };
  }
  const icon = n.ImageURL?.match(/images_icon\/([a-z0-9_-]+)\.png$/i)?.[1]?.toLowerCase();
  if (!icon || icon === "computer" || !hasGrandchildren(n)) return null;
  const hit = ICON[icon];
  if (!hit) return null;
  const category: Category = hit.category === "disk" && looksNvme(n) ? "nvme" : hit.category;
  return { category, vendor: hit.vendor, name: n.Text.trim(), key: treePath };
}

/* ------------------------------------------------------------------ */
/* Sensor type                                                          */
/* ------------------------------------------------------------------ */
const GROUP_TYPE: Record<string, string> = {
  voltages: "Voltage",
  currents: "Current",
  clocks: "Clock",
  temperatures: "Temperature",
  load: "Load",
  loads: "Load",
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
  timings: "Timing",
  humidity: "Humidity",
  conductivity: "Conductivity",
};

function sensorType(s: LhmNode, groupText: string | undefined, unit: string): string {
  const norm = (t: string) => {
    const l = t.toLowerCase();
    if (l === "smalldata" || l === "data") return "Data";
    return l[0]!.toUpperCase() + l.slice(1);
  };
  if (s.Type) return norm(s.Type);
  const seg = s.SensorId?.split("/").at(-2);
  if (seg && !/^\d+$/.test(seg)) return norm(seg);
  const byGroup = groupText ? GROUP_TYPE[groupText.trim().toLowerCase()] : undefined;
  if (byGroup) {
    // LHM puts "GPU Memory Used (MB)" under "Data" but values under "Load" use % — trust the group
    return byGroup;
  }
  if (unit === "°C") return "Temperature";
  if (unit === "%") return "Load";
  if (unit === "RPM") return "Fan";
  if (unit === "W") return "Power";
  if (unit === "MHz") return "Clock";
  if (unit === "V") return "Voltage";
  if (unit === "A") return "Current";
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

/** Hardware path of a sensor id: "/amdcpu/0/temperature/2" → "/amdcpu/0" */
function hwPathFromSensorId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const segs = id.split("/");
  if (segs.length < 4) return undefined;
  return segs.slice(0, -2).join("/");
}

export function collectRaw(root: LhmNode): RawSensor[] {
  const out: RawSensor[] = [];
  const visit = (n: LhmNode, hw: Hw | null, parent: LhmNode | null, path: string) => {
    const asHw = hardwareOf(n, path);
    let ctx = hw;
    if (asHw) {
      // Super I/O chips sit under the motherboard: label their sensors with the board's name.
      ctx = hw && hw.category === "mainboard" && asHw.category === "mainboard" ? { ...asHw, name: hw.name } : asHw;
    }
    const kids = n.Children ?? [];
    if (kids.length === 0) {
      if (!n.Value) return;
      const parsed = parseValueWithUnit(n.Value);
      if (!parsed) return;
      let sensorHw = ctx;
      const hwPath = hwPathFromSensorId(n.SensorId);
      if (hwPath) {
        const h = fromHardwarePath(hwPath);
        if (h.category === "disk" && ctx?.category === "nvme") h.category = "nvme";
        sensorHw = { ...h, name: ctx?.name ?? hwPath, key: hwPath.toLowerCase() };
      }
      if (!sensorHw) return;
      let { value, unit } = parsed;
      unit = unit === "C" || unit === "℃" ? "°C" : unit;
      if (unit === "°F" || unit === "℉") {
        // LHM can be switched to Fahrenheit; the protocol speaks °C
        value = ((value - 32) * 5) / 9;
        unit = "°C";
      }
      out.push({ hw: sensorHw, name: n.Text.trim(), type: sensorType(n, parent?.Text, unit), value, unit });
      return;
    }
    kids.forEach((k, i) => visit(k, ctx, n, `${path}/${i}`));
  };
  visit(root, null, null, "");
  return out;
}

/* ------------------------------------------------------------------ */
/* Slugs                                                                */
/* ------------------------------------------------------------------ */
/** "fan_1" → "fan1", "core_3_thread_2" → "core3_thread2" (numbers stick to their noun) */
const glue = (s: string) => s.replace(/\b(fan|core|ccd|ccds|thread|temp|temperature|dimm|pcore|ecore|pump|cpu|gpu|channel)_(\d+)\b/g, "$1$2");
const slug = (s: string) => glue(slugify(s));
const stripWords = (s: string, ...res: RegExp[]) => {
  let out = s;
  for (const r of res) out = out.replace(r, " ");
  return out.replace(/\s+/g, " ").trim();
};
const P_CPU = /^cpu\s+/i;
const P_GPU = /^gpu\s+/i;
const P_TAIL = /\s*\((tdie|tctl|smu|svi2 tfn)\)\s*$/i;

/** Integrated GPUs rank below discrete ones. */
function gpuRank(h: Hw): number {
  const integrated =
    /radeon\s*\(tm\)\s*graphics$|radeon graphics$|vega \d+ graphics|uhd graphics|iris|hd graphics|\b(780m|760m|740m|680m|660m|610m)\b|arc\(tm\) graphics$/i.test(
      h.name,
    );
  if (integrated) return 0;
  return h.vendor === "nvidia" ? 3 : 2;
}

interface Named {
  id: string;
  label: string;
  hidden?: boolean;
}

function name(r: RawSensor, prefix: string, firstStorageTemp: boolean): Named {
  const n = r.name;
  const t = r.type;
  const cat = r.hw.category;

  if (t === "Temperature") {
    switch (cat) {
      case "cpu": {
        if (/^(core \(tctl\/tdie\)|core \(tctl\)|tctl\/tdie|tctl|cpu package|package)$/i.test(n))
          return { id: `${prefix}_package`, label: "CPU Package" };
        if (/^(core max|ccds? max( \(tdie\))?)$/i.test(n)) return { id: `${prefix}_core_max`, label: "CPU Core Max" };
        if (/^(core average|ccds? average( \(tdie\))?)$/i.test(n)) return { id: `${prefix}_core_average`, label: "CPU Core Average" };
        const s = slug(stripWords(n, P_CPU, P_TAIL)).replace(/^p_core/, "pcore").replace(/^e_core/, "ecore");
        return { id: `${prefix}_${s}`, label: /^cpu/i.test(n) ? n : `CPU ${n}`, hidden: /distance to tjmax/i.test(n) };
      }
      case "gpu": {
        if (/^gpu hot ?spot$/i.test(n)) return { id: `${prefix}_hotspot`, label: "GPU Hot Spot" };
        // NVIDIA "GPU Memory Junction", AMD "GPU Memory" (VRAM): same thing for a dashboard
        if (/^gpu memory( junction)?$/i.test(n)) return { id: `${prefix}_memory_junction`, label: "GPU Memory Junction" };
        return { id: `${prefix}_${slug(stripWords(n, P_GPU))}`, label: /^gpu/i.test(n) ? n : `GPU ${n}` };
      }
      case "nvme":
      case "disk": {
        const short = r.hw.name.replace(/\s+\d+(\.\d+)?\s*(GB|TB)$/i, "");
        if (firstStorageTemp && /^(composite temperature|temperature|composite)$/i.test(n))
          return { id: `${prefix}_temp`, label: `${short} Temperature` };
        const num = n.match(/^temperature\s*#?\s*(\d+)$/i);
        // secondary NAND/controller sensors: available by id, not published by "auto"
        if (num) return { id: `${prefix}_temp${num[1]}`, label: `${short} ${n}`, hidden: !firstStorageTemp };
        return { id: `${prefix}_temp_${slug(n)}`, label: `${short} ${n}`, hidden: !firstStorageTemp };
      }
      case "mainboard": {
        const unplugged = r.value <= 0 || r.value >= 127; // unconnected Super I/O inputs read 0 / -128 / 127+
        if (/^(system|motherboard|mainboard)$/i.test(n)) return { id: "motherboard", label: "Motherboard", hidden: unplugged };
        return { id: `mb_${slug(n)}`, label: `Motherboard ${n}`, hidden: unplugged };
      }
      case "ram":
        return { id: `${prefix}_${slug(stripWords(n, /^memory\s+/i))}`, label: /memory|dimm/i.test(n) ? n : `Memory ${n}` };
      default:
        return { id: `${prefix}_${slug(n)}`, label: `${r.hw.name} ${n}` };
    }
  }

  if (t === "Load") {
    if (cat === "cpu") {
      if (/^cpu total$/i.test(n)) return { id: `${prefix}_load_total`, label: "CPU Load" };
      const s = slug(stripWords(n, P_CPU));
      return { id: `${prefix}_load_${s}`, label: `${/^cpu/i.test(n) ? n : `CPU ${n}`} Load`, hidden: /thread\s*#?\s*\d+/i.test(n) };
    }
    if (cat === "gpu") {
      const s = slug(stripWords(n, P_GPU));
      return { id: `${prefix}_load_${s}`, label: `${/^gpu/i.test(n) ? n : `GPU ${n}`} Load`, hidden: /^d3d/i.test(n) };
    }
    if (cat === "ram") {
      if (/^memory$/i.test(n)) return { id: "ram_load", label: "Memory Load" };
      if (/^virtual memory$/i.test(n)) return { id: "ram_load_virtual", label: "Virtual Memory Load" };
    }
    const storage = cat === "nvme" || cat === "disk";
    return {
      id: `${prefix}_load_${slug(n)}`,
      label: storage ? `${r.hw.name} ${n}` : `${n}`,
      hidden: cat === "nic" || (storage && /activity/i.test(n)),
    };
  }

  if (t === "Fan") {
    if (cat === "mainboard" || cat === "cooler") {
      const num = n.match(/^fan\s*#?\s*(\d+)$/i);
      if (num) return { id: `fan${num[1]}`, label: `Fan #${num[1]}` };
      return { id: `fan_${slug(stripWords(n, /\bfan\b/i)) || slug(n)}`, label: n };
    }
    if (cat === "gpu") return { id: `${prefix}_${slug(stripWords(n, P_GPU))}`, label: /^gpu/i.test(n) ? n : `GPU ${n}` };
    return { id: `${prefix}_fan_${slug(n)}`, label: `${r.hw.name} ${n}` };
  }

  if (t === "Power") {
    if (cat === "cpu" && /^(cpu )?package$/i.test(n)) return { id: `${prefix}_power`, label: "CPU Power" };
    if (cat === "cpu" && /^core #?\d+/i.test(n))
      return { id: `${prefix}_power_${slug(stripWords(n, P_TAIL))}`, label: `CPU ${stripWords(n, P_TAIL)} Power`, hidden: true };
    if (cat === "gpu" && /^gpu (package|power|board power|total)$/i.test(n)) return { id: `${prefix}_power`, label: "GPU Power" };
    const s = slug(stripWords(n, cat === "cpu" ? P_CPU : P_GPU, P_TAIL));
    const what = cat === "cpu" ? "CPU" : cat === "gpu" ? "GPU" : r.hw.name;
    return { id: `${prefix}_power_${s}`, label: `${what} ${stripWords(n, P_CPU, P_GPU, P_TAIL)} Power` };
  }

  if (t === "Clock") {
    const s = slug(stripWords(n, cat === "cpu" ? P_CPU : P_GPU));
    const what = cat === "cpu" ? "CPU" : cat === "gpu" ? "GPU" : r.hw.name;
    return { id: `${prefix}_clock_${s}`, label: `${what} ${stripWords(n, P_CPU, P_GPU)} Clock` };
  }

  if (t === "Data") {
    if (cat === "ram") {
      const s = slug(stripWords(n, /^memory\s+/i));
      return { id: `ram_${s}`, label: n };
    }
    const s = slug(stripWords(n, P_GPU));
    return {
      id: `${prefix}_${s}`,
      label: cat === "gpu" ? (/^gpu/i.test(n) ? n : `GPU ${n}`) : `${r.hw.name} ${n}`,
      hidden: cat === "nic" || /^d3d/i.test(n) || cat === "nvme" || cat === "disk",
    };
  }

  // Voltage, Current, Control, Level, Factor, Throughput, Energy, Frequency, Flow...: published
  // only when asked for by id ("sensors: [...]") or with `list-sensors --all`.
  return { id: `${prefix}_${slug(t)}_${slug(stripWords(n, cat === "cpu" ? P_CPU : cat === "gpu" ? P_GPU : /^$/))}`, label: `${r.hw.name} ${n}`, hidden: true };
}

export function parseLhm(root: LhmNode): InternalSensor[] {
  const raw = collectRaw(root);

  // Deterministic numbering independent of LHM's node order.
  const unique = (cat: Category) => [...new Map(raw.filter((r) => r.hw.category === cat).map((r) => [r.hw.key, r.hw])).values()];
  const byPathThenKey = (a: Hw, b: Hw) => (a.pathIndex ?? 1e9) - (b.pathIndex ?? 1e9) || a.key.localeCompare(b.key);
  const gpus = unique("gpu").sort((a, b) => gpuRank(b) - gpuRank(a) || byPathThenKey(a, b));
  const cpus = unique("cpu").sort(byPathThenKey);
  // storage keeps LHM's own index when it has one, otherwise tree order (stable for a given PC)
  const nvmes = unique("nvme");
  const disks = unique("disk");
  const index = new Map<string, number>();
  gpus.forEach((h, i) => index.set(h.key, i));
  cpus.forEach((h, i) => index.set(h.key, i));
  const storageIndex = (list: Hw[]) => {
    const withIdx = list.every((h) => h.pathIndex !== undefined) && new Set(list.map((h) => h.pathIndex)).size === list.length;
    list.forEach((h, i) => index.set(h.key, withIdx ? h.pathIndex! : i));
  };
  storageIndex(nvmes);
  storageIndex(disks);

  const prefixOf = (h: Hw): string => {
    const i = index.get(h.key) ?? 0;
    switch (h.category) {
      case "cpu":
        return i === 0 ? "cpu" : `cpu${i + 1}`;
      case "gpu":
        return i === 0 ? "gpu" : `gpu${i + 1}`;
      case "nvme":
        return `nvme${i}`;
      case "disk":
        return `disk${i}`;
      case "mainboard":
        return "mb";
      case "ram":
        return "ram";
      case "nic":
        return `net_${slug(h.name)}`;
      case "battery":
        return "battery";
      case "psu":
        return `psu_${slug(h.name)}`;
      case "cooler":
        return `cooler_${slug(h.name)}`;
      default:
        return slug(h.name) || "hw";
    }
  };

  const ids = new IdAllocator();
  const sawStorageTemp = new Set<string>();
  const out: InternalSensor[] = [];
  for (const r of raw) {
    const isStorage = r.hw.category === "nvme" || r.hw.category === "disk";
    const first = isStorage && r.type === "Temperature" && !sawStorageTemp.has(r.hw.key);
    if (first) sawStorageTemp.add(r.hw.key);
    const named = name(r, prefixOf(r.hw), first);
    const kind: SensorKind = KIND[r.type] ?? "other";
    out.push({
      id: ids.take(named.id.replace(/_+/g, "_").replace(/_$/, "")),
      name: named.label,
      kind,
      value: round(r.value, r.unit === "V" ? 3 : 1),
      unit: r.unit,
      hardware: r.hw.name,
      ...(named.hidden || kind === "other" ? { hiddenByDefault: true } : {}),
    });
  }
  return out;
}

export class LhmSource implements SensorSource {
  readonly name = "LibreHardwareMonitor";
  readonly hint: string;
  private warn = throttled(5 * 60_000);
  constructor(
    private url: string,
    private auth?: { username: string; password: string },
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.hint =
      `Could not read ${url}. Is LibreHardwareMonitor running, with Options → Remote Web Server → Run ` +
      `enabled (port 8085)?`;
  }
  async read(): Promise<InternalSensor[]> {
    let res: Response;
    try {
      const headers: Record<string, string> = {};
      if (this.auth) headers.Authorization = "Basic " + Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64");
      res = await this.fetchImpl(this.url, { headers, signal: AbortSignal.timeout(3000) });
    } catch (e) {
      throw new Error(`${this.hint} (${(e as Error).message})`);
    }
    if (!res.ok) throw new Error(`LibreHardwareMonitor returned HTTP ${res.status} for ${this.url}`);
    const sensors = parseLhm((await res.json()) as LhmNode);
    if (sensors.length === 0) {
      this.warn(() => log.warn("LibreHardwareMonitor answered but reported no sensors (just started? not running as administrator?)"));
    } else if (!sensors.some((s) => s.kind === "temperature" && s.id.startsWith("cpu"))) {
      this.warn(() =>
        log.warn("No CPU temperature from LibreHardwareMonitor: it needs administrator rights and the PawnIO driver (accept its install prompt)."),
      );
    }
    return sensors;
  }
}
