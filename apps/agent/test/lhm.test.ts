import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLhm, type LhmNode } from "../src/sensors/lhm.js";
import { filterSensors, haSensorIds } from "../src/sensors/types.js";
import { parseLocaleNumber, parseValueWithUnit } from "../src/util.js";

const raw = readFileSync(new URL("./fixtures/lhm-data.json", import.meta.url), "utf8");
const fixture = JSON.parse(raw) as LhmNode;
/** Same tree as older LHM builds serve it: no SensorId / Type / HardwareId */
const legacy = JSON.parse(raw, (k, v) => (k === "SensorId" || k === "Type" || k === "HardwareId" ? undefined : v)) as LhmNode;
const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((s) => [s.id, s]));

describe("number parsing", () => {
  it.each([
    ["45.0 °C", 45, "°C"],
    ["12.3 %", 12.3, "%"],
    ["1,234 RPM", 1234, "RPM"],
    ["11,502.0 MHz", 11502, "MHz"],
    ["45,5 °C", 45.5, "°C"],
    ["1.234,5 MHz", 1234.5, "MHz"],
    ["-3.5 °C", -3.5, "°C"],
    ["0.912 V", 0.912, "V"],
    ["182.0 MB/s", 182, "MB/s"],
  ])("%s", (input, value, unit) => {
    expect(parseValueWithUnit(input)).toEqual({ value, unit });
  });
  it("rejects garbage", () => {
    expect(parseValueWithUnit("-")).toBeNull();
    expect(parseValueWithUnit("")).toBeNull();
    expect(Number.isNaN(parseLocaleNumber("abc"))).toBe(true);
  });
});

describe("LibreHardwareMonitor parser", () => {
  const sensors = parseLhm(fixture);
  const m = byId(sensors);

  it("produces the well-known ids", () => {
    for (const id of [
      "cpu_package",
      "cpu_ccd1",
      "cpu_total_load",
      "cpu_package_power",
      "cpu_core_1_clock",
      "gpu_core",
      "gpu_hotspot",
      "gpu_memory_junction",
      "gpu_core_load",
      "gpu_fan_1",
      "gpu_package_power",
      "ram_load",
      "nvme_samsung_ssd_990_pro_2tb_temp",
      "nvme_wd_black_sn850x_4000gb_temp",
      "mainboard_vrm_mos",
      "fan_2",
    ]) {
      expect(m.has(id), id).toBe(true);
    }
  });

  it("parses values, units, kinds and hardware", () => {
    expect(m.get("cpu_package")).toMatchObject({ value: 63.8, unit: "°C", kind: "temperature", name: "CPU Package", hardware: "AMD Ryzen 7 7800X3D" });
    expect(m.get("gpu_hotspot")).toMatchObject({ value: 74.6, unit: "°C", hardware: "NVIDIA GeForce RTX 4080 SUPER" });
    expect(m.get("fan_2")).toMatchObject({ value: 1243, unit: "RPM", kind: "fan", hardware: "ASUS ROG STRIX B650E-F GAMING WIFI" });
    expect(m.get("gpu_fan_1")).toMatchObject({ value: 1452, unit: "RPM" });
    expect(m.get("gpu_memory_clock")).toMatchObject({ value: 11502, unit: "MHz", kind: "clock" });
    expect(m.get("cpu_total_load")).toMatchObject({ value: 17.6, unit: "%", kind: "load" });
    expect(m.get("gpu_memory_used")).toMatchObject({ value: 8563.5, unit: "MB", kind: "data" });
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

  it("gives identical ids with and without SensorId/Type (old LHM versions)", () => {
    const a = parseLhm(fixture).map((s) => [s.id, s.kind, s.value]);
    const b = parseLhm(legacy).map((s) => [s.id, s.kind, s.value]);
    expect(b).toEqual(a);
  });

  it("is stable when hardware order changes", () => {
    const shuffled = structuredClone(fixture);
    shuffled.Children![0]!.Children!.reverse();
    const ids = (l: { id: string }[]) => l.map((s) => s.id).sort();
    expect(ids(parseLhm(shuffled))).toEqual(ids(sensors));
  });

  it("auto filter hides voltages, per-thread loads, unplugged inputs and NICs", () => {
    const auto = byId(filterSensors(sensors, "auto"));
    expect(auto.has("cpu_package")).toBe(true);
    expect(auto.has("mainboard_vcore_voltage")).toBe(false);
    expect(auto.has("cpu_core_1_thread_1_load")).toBe(false);
    expect(auto.has("mainboard_temperature_7")).toBe(false); // reads 0 °C
    expect([...auto.keys()].some((k) => k.startsWith("net_"))).toBe(false);
    expect(auto.get("cpu_package")).not.toHaveProperty("hiddenByDefault");
  });

  it("explicit filters support globs", () => {
    const f = filterSensors(sensors, ["cpu_package", "gpu_*", "nvme_*_temp"]).map((s) => s.id);
    expect(f).toContain("cpu_package");
    expect(f).toContain("gpu_hotspot");
    expect(f).toContain("nvme_wd_black_sn850x_4000gb_temp");
    expect(f).not.toContain("nvme_wd_black_sn850x_4000gb_temp_2");
    expect(f).not.toContain("cpu_total_load");
  });

  it("default HA set = main temperatures + headline loads", () => {
    const ha = haSensorIds(filterSensors(sensors, "auto"), "default").map((s) => s.id);
    expect(ha).toEqual(expect.arrayContaining(["cpu_package", "gpu_core", "gpu_hotspot", "cpu_total_load", "gpu_core_load", "ram_load", "nvme_samsung_ssd_990_pro_2tb_temp"]));
    expect(ha).not.toContain("nvme_samsung_ssd_990_pro_2tb_temp_2");
    expect(ha).not.toContain("gpu_bus_load");
    expect(haSensorIds(sensors, "none")).toEqual([]);
  });

  it("an empty tree (LHM not elevated / just started) yields no sensors", () => {
    expect(parseLhm({ Text: "Sensor", Children: [] })).toEqual([]);
  });
});
