import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLhm, type LhmNode } from "../src/sensors/lhm.js";
import { filterSensors, haSensors } from "../src/sensors/types.js";
import { parseLocaleNumber, parseValueWithUnit, slugify } from "../src/util.js";

const load = (name: string) => readFileSync(new URL(`../src/fixtures/${name}`, import.meta.url), "utf8");
/** AMD Ryzen 7 7800X3D + RTX 4080 SUPER + Radeon iGPU, LHM 0.9.4 (SensorId/Type/HardwareId), en-US */
const ryzenRaw = load("lhm-ryzen-nvidia.json");
/** Intel i7-13700K + Radeon RX 7900 XTX + UHD 770, older LHM (no ids), German locale ("45,0 °C") */
const intelRaw = load("lhm-intel-amdgpu-de.json");
const ryzen = JSON.parse(ryzenRaw) as LhmNode;
const intel = JSON.parse(intelRaw) as LhmNode;
const stripIds = (raw: string) =>
  JSON.parse(raw, (k, v) => (k === "SensorId" || k === "Type" || k === "HardwareId" ? undefined : v)) as LhmNode;
const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((s) => [s.id, s]));

describe("number parsing", () => {
  it.each([
    ["45.0 °C", 45, "°C"],
    ["45,0 °C", 45, "°C"],
    ["35,2 %", 35.2, "%"],
    ["1200 RPM", 1200, "RPM"],
    ["5.1 W", 5.1, "W"],
    ["12,25 W", 12.25, "W"],
    ["4850.0 MHz", 4850, "MHz"],
    ["4850,0 MHz", 4850, "MHz"],
    ["1,234.5 MHz", 1234.5, "MHz"],
    ["1.234,5 MHz", 1234.5, "MHz"],
    ["1,234,567 KB", 1234567, "KB"],
    ["-3.5 °C", -3.5, "°C"],
    ["0,912 V", 0.912, "V"],
    ["182.0 MB/s", 182, "MB/s"],
    ["1 200 RPM", 1200, "RPM"],
  ])("%s", (input, value, unit) => {
    expect(parseValueWithUnit(input)).toEqual({ value, unit });
  });
  it("rejects garbage", () => {
    expect(parseValueWithUnit("-")).toBeNull();
    expect(parseValueWithUnit("")).toBeNull();
    expect(Number.isNaN(parseLocaleNumber("abc"))).toBe(true);
  });
});

describe("slugify", () => {
  it.each([
    ["AMD Ryzen 7 7800X3D", "amd_ryzen_7_7800x3d"],
    ["Fan #2", "fan2"],
    ["CPU Core #12", "cpu_core12"],
    ["GPU Hot Spot", "gpu_hot_spot"],
    ["Température", "temperature"],
    ["  --weird__ name!! ", "weird_name"],
  ])("%s → %s", (a, b) => expect(slugify(a)).toBe(b));
});

describe("LHM: AMD Ryzen + NVIDIA (LHM with SensorId)", () => {
  const sensors = parseLhm(ryzen);
  const m = byId(sensors);

  it("produces the friendly ids", () => {
    for (const id of [
      "cpu_package",
      "cpu_core_max",
      "cpu_ccd1",
      "cpu_load_total",
      "cpu_power",
      "cpu_clock_core1",
      "gpu_core",
      "gpu_hotspot",
      "gpu_memory_junction",
      "gpu_load_core",
      "gpu_fan1",
      "gpu_fan2",
      "gpu_power",
      "gpu_memory_used",
      "nvme0_temp",
      "nvme1_temp",
      "nvme0_load_used_space",
      "motherboard",
      "mb_vrm_mos",
      "fan1",
      "fan2",
      "ram_load",
      "ram_used",
    ]) {
      expect(m.has(id), id).toBe(true);
    }
  });

  it("values, units, kinds, names and hardware", () => {
    expect(m.get("cpu_package")).toMatchObject({ value: 63.8, unit: "°C", kind: "temperature", name: "CPU Package", hardware: "AMD Ryzen 7 7800X3D" });
    expect(m.get("cpu_core_max")).toMatchObject({ value: 58.4, kind: "temperature" });
    expect(m.get("gpu_hotspot")).toMatchObject({ value: 74.6, unit: "°C", name: "GPU Hot Spot", hardware: "NVIDIA GeForce RTX 4080 SUPER" });
    expect(m.get("gpu_memory_junction")).toMatchObject({ value: 68 });
    expect(m.get("fan2")).toMatchObject({ value: 1243, unit: "RPM", kind: "fan", name: "Fan #2", hardware: "ASUS ROG STRIX B650E-F GAMING WIFI" });
    expect(m.get("gpu_fan1")).toMatchObject({ value: 1452, unit: "RPM", kind: "fan" });
    expect(m.get("gpu_clock_memory")).toMatchObject({ value: 11502, unit: "MHz", kind: "clock" });
    expect(m.get("cpu_load_total")).toMatchObject({ value: 17.6, unit: "%", kind: "load", name: "CPU Load" });
    expect(m.get("cpu_power")).toMatchObject({ value: 61.3, unit: "W", kind: "power" });
    expect(m.get("gpu_power")).toMatchObject({ value: 211.7, unit: "W" });
    expect(m.get("gpu_memory_used")).toMatchObject({ value: 8563.5, unit: "MB", kind: "data" });
    expect(m.get("nvme0_temp")).toMatchObject({ value: 41.9, hardware: "Samsung SSD 990 PRO 2TB" });
    expect(m.get("nvme1_temp")).toMatchObject({ value: 38.9, hardware: "WD_BLACK SN850X 4000GB" });
    expect(m.get("motherboard")).toMatchObject({ value: 34, name: "Motherboard" });
    expect(m.get("ram_load")).toMatchObject({ value: 46.8 });
  });

  it("ranks the discrete NVIDIA card as gpu and the iGPU as gpu2", () => {
    expect(m.get("gpu_core")!.hardware).toContain("NVIDIA");
    expect(m.get("gpu2_core")!.hardware).toBe("AMD Radeon(TM) Graphics");
  });

  it("ids are unique and slug-shaped", () => {
    const ids = sensors.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
  });

  it("same ids and values without SensorId/Type/HardwareId (older LHM builds)", () => {
    const a = sensors.map((s) => [s.id, s.kind, s.value, !!s.hiddenByDefault]);
    const b = parseLhm(stripIds(ryzenRaw)).map((s) => [s.id, s.kind, s.value, !!s.hiddenByDefault]);
    expect(b).toEqual(a);
  });

  it("stable when LHM lists hardware in a different order", () => {
    const shuffled = structuredClone(ryzen);
    shuffled.Children![0]!.Children!.reverse();
    const ids = (l: { id: string }[]) => l.map((s) => s.id).sort();
    expect(ids(parseLhm(shuffled))).toEqual(ids(sensors));
    // and the old-LHM variant too (tree-path based numbering for storage)
    const legacy = stripIds(ryzenRaw);
    expect(byId(parseLhm(legacy)).get("nvme0_temp")?.hardware).toBe("Samsung SSD 990 PRO 2TB");
  });

  it("same ids when the values change (sensor readings never leak into ids)", () => {
    const changed = JSON.parse(ryzenRaw.replace(/"Value": "(\d+)/g, '"Value": "9$1')) as LhmNode;
    expect(parseLhm(changed).map((s) => s.id)).toEqual(sensors.map((s) => s.id));
  });

  it("auto hides voltages, per-thread loads, unplugged inputs, D3D, NICs, SMART counters", () => {
    const auto = byId(filterSensors(sensors, "auto"));
    expect(auto.has("cpu_package")).toBe(true);
    expect(auto.has("gpu_hotspot")).toBe(true);
    expect([...auto.keys()].some((k) => k.includes("voltage"))).toBe(false);
    expect([...auto.keys()].some((k) => k.includes("thread"))).toBe(false);
    expect(auto.has("mb_temperature7")).toBe(false); // reads 0 °C: nothing plugged in
    expect(auto.has("gpu_load_d3d_3d")).toBe(false);
    expect(auto.has("nvme0_temp2")).toBe(false);
    expect(auto.has("nvme0_data_written")).toBe(false);
    expect([...auto.keys()].some((k) => k.startsWith("net_"))).toBe(false);
    expect(auto.get("cpu_package")).not.toHaveProperty("hiddenByDefault");
    // hidden ones are still reachable by id
    expect(filterSensors(sensors, ["cpu_load_core1_thread2"]).map((s) => s.id)).toEqual(["cpu_load_core1_thread2"]);
  });

  it("explicit filters support globs", () => {
    const f = filterSensors(sensors, ["cpu_package", "gpu_*", "nvme*_temp"]).map((s) => s.id);
    expect(f).toContain("cpu_package");
    expect(f).toContain("gpu_hotspot");
    expect(f).toContain("nvme1_temp");
    expect(f).not.toContain("nvme1_temp2");
    expect(f).not.toContain("cpu_load_total");
  });

  it("HA default = temperatures, loads, fans and power (no clocks/data)", () => {
    const ha = haSensors(filterSensors(sensors, "auto"), "default");
    const ids = ha.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["cpu_package", "gpu_core", "gpu_hotspot", "cpu_load_total", "gpu_load_core", "ram_load", "fan2", "cpu_power", "nvme0_temp"]));
    expect(ha.every((s) => ["temperature", "load", "fan", "power"].includes(s.kind))).toBe(true);
    expect(haSensors(filterSensors(sensors, "auto"), ["cpu_package"]).map((s) => s.id)).toEqual(["cpu_package"]);
  });

  it("an empty tree (LHM just started) yields no sensors", () => {
    expect(parseLhm({ Text: "Sensor", Children: [] })).toEqual([]);
  });
});

describe("LHM: Intel + AMD Radeon, comma decimals, no SensorId", () => {
  const sensors = parseLhm(intel);
  const m = byId(sensors);

  it("parses German-locale values", () => {
    expect(m.get("cpu_package")).toMatchObject({ value: 71, unit: "°C", hardware: "Intel Core i7-13700K" });
    expect(m.get("cpu_core_max")).toMatchObject({ value: 76 });
    expect(m.get("cpu_load_total")).toMatchObject({ value: 34.5, unit: "%" });
    expect(m.get("cpu_power")).toMatchObject({ value: 142.6, unit: "W" });
    expect(m.get("cpu_clock_core1")).toMatchObject({ value: 5300, unit: "MHz" });
    expect(m.get("ram_used")).toMatchObject({ value: 18.6, unit: "GB" });
  });

  it("Intel cores and P/E core numbering", () => {
    expect(m.get("cpu_core1")).toMatchObject({ value: 63.5, name: "CPU Core #1" });
    expect(m.get("cpu_core16")).toMatchObject({ value: 63 });
    // TjMax distances are hidden (they look like temperatures but are margins)
    expect(m.get("cpu_core1_distance_to_tjmax")?.hiddenByDefault).toBe(true);
  });

  it("discrete Radeon is gpu, Intel iGPU is gpu2, AMD VRAM temp aliases to gpu_memory_junction", () => {
    expect(m.get("gpu_core")).toMatchObject({ value: 64, hardware: "AMD Radeon RX 7900 XTX" });
    expect(m.get("gpu_hotspot")).toMatchObject({ value: 81 });
    expect(m.get("gpu_memory_junction")).toMatchObject({ value: 72 });
    expect(m.get("gpu_load_core")).toMatchObject({ value: 97 });
    expect(m.get("gpu_fan")).toMatchObject({ value: 1675, unit: "RPM" });
    expect(m.get("gpu_power")).toMatchObject({ value: 344 });
    expect([...m.keys()].some((k) => k.startsWith("gpu2_"))).toBe(true);
    expect(m.get("gpu2_load_d3d_3d")?.hardware).toBe("Intel(R) UHD Graphics 770");
  });

  it("named fan headers, NVMe vs SATA, motherboard temps", () => {
    expect(m.get("fan_cpu")).toMatchObject({ value: 1488, kind: "fan" });
    expect(m.get("fan_pump")).toMatchObject({ value: 2710 });
    expect(m.get("fan_system1")).toMatchObject({ value: 1012 });
    expect(m.get("nvme0_temp")).toMatchObject({ value: 47.9, hardware: "Samsung SSD 980 PRO 1TB" });
    expect(m.get("disk0_temp")).toMatchObject({ value: 35, hardware: "CT2000MX500SSD1" });
    expect(m.get("motherboard")).toMatchObject({ value: 36.5 });
    expect(m.get("mb_vrm_mos")).toMatchObject({ value: 54, hardware: "MSI MAG Z790 TOMAHAWK WIFI (MS-7D91)" });
  });

  it("unique slug ids, voltages hidden", () => {
    const ids = sensors.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    expect(filterSensors(sensors, "auto").some((s) => s.unit === "V")).toBe(false);
  });

  it("same well-known ids as the Ryzen system where the hardware has them", () => {
    const common = ["cpu_package", "cpu_core_max", "cpu_load_total", "cpu_power", "gpu_core", "gpu_hotspot", "gpu_memory_junction", "gpu_load_core", "gpu_power", "nvme0_temp", "motherboard", "ram_load", "ram_used"];
    const r = byId(parseLhm(ryzen));
    for (const id of common) {
      expect(m.has(id), `intel ${id}`).toBe(true);
      expect(r.has(id), `ryzen ${id}`).toBe(true);
    }
  });

  it("Fahrenheit display is converted back to °C", () => {
    const f = JSON.parse(intelRaw.replace('"71,0 °C"', '"159,8 °F"')) as LhmNode;
    expect(byId(parseLhm(f)).get("cpu_package")).toMatchObject({ value: 71, unit: "°C" });
  });
});
