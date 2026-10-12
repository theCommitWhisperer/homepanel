import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwmonSource, readHwmon, readThermalZones } from "../src/sensors/hwmon.js";

let root: string;
const write = (p: string, v: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, v + "\n");
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hp-hwmon-"));
  const hw = join(root, "sys", "class", "hwmon");
  // hwmon0: nvme with device/model
  write(join(hw, "hwmon0", "name"), "nvme");
  write(join(hw, "hwmon0", "device", "model"), "Samsung SSD 980 1TB                     ");
  write(join(hw, "hwmon0", "temp1_input"), "38850");
  write(join(hw, "hwmon0", "temp1_label"), "Composite");
  write(join(hw, "hwmon0", "temp2_input"), "45850");
  write(join(hw, "hwmon0", "temp2_label"), "Sensor 1");
  // hwmon1: AMD CPU
  write(join(hw, "hwmon1", "name"), "k10temp");
  write(join(hw, "hwmon1", "temp1_input"), "52125");
  write(join(hw, "hwmon1", "temp1_label"), "Tctl");
  write(join(hw, "hwmon1", "temp3_input"), "47500");
  write(join(hw, "hwmon1", "temp3_label"), "Tccd1");
  // hwmon2: amdgpu
  write(join(hw, "hwmon2", "name"), "amdgpu");
  write(join(hw, "hwmon2", "temp1_input"), "41000");
  write(join(hw, "hwmon2", "temp1_label"), "edge");
  write(join(hw, "hwmon2", "temp2_input"), "44000");
  write(join(hw, "hwmon2", "temp2_label"), "junction");
  write(join(hw, "hwmon2", "fan1_input"), "0");
  write(join(hw, "hwmon2", "power1_average"), "8123000");
  write(join(hw, "hwmon2", "device", "gpu_busy_percent"), "3");
  // hwmon3: Super I/O with 2 fans + an unplugged temp
  write(join(hw, "hwmon3", "name"), "nct6798");
  write(join(hw, "hwmon3", "fan2_input"), "1043");
  write(join(hw, "hwmon3", "fan1_input"), "812");
  write(join(hw, "hwmon3", "temp1_input"), "34000");
  write(join(hw, "hwmon3", "temp1_label"), "SYSTIN");
  write(join(hw, "hwmon3", "temp7_input"), "-62000");
  // hwmon10 sorts after hwmon3 numerically: Intel coretemp
  write(join(hw, "hwmon10", "name"), "coretemp");
  write(join(hw, "hwmon10", "temp1_input"), "61000");
  write(join(hw, "hwmon10", "temp1_label"), "Package id 0");
  write(join(hw, "hwmon10", "temp2_input"), "58000");
  write(join(hw, "hwmon10", "temp2_label"), "Core 0");
  // a stray non-hwmon entry is ignored
  symlinkSync(join(hw, "hwmon1"), join(hw, "notahwmon"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("hwmon", () => {
  it("maps drivers to the same ids as the LHM parser", async () => {
    const s = await readHwmon(join(root, "sys", "class", "hwmon"));
    const m = new Map(s.map((x) => [x.id, x]));
    expect(m.get("cpu_package")).toMatchObject({ value: 52.1, unit: "°C", kind: "temperature", name: "CPU Package" });
    expect(m.get("cpu_ccd1")?.value).toBe(47.5);
    expect(m.get("gpu_core")?.value).toBe(41);
    expect(m.get("gpu_hotspot")?.value).toBe(44);
    expect(m.get("gpu_fan")).toMatchObject({ value: 0, unit: "RPM" });
    expect(m.get("gpu_power")).toMatchObject({ value: 8.1, unit: "W" });
    expect(m.get("gpu_load_core")).toMatchObject({ value: 3, unit: "%" });
    expect(m.get("nvme0_temp")).toMatchObject({ value: 38.9, hardware: "Samsung SSD 980 1TB" });
    expect(m.get("nvme0_temp1")?.value).toBe(45.9);
    expect(m.get("fan1")?.value).toBe(812);
    expect(m.get("fan2")?.value).toBe(1043);
    expect(m.get("motherboard")?.value).toBe(34);
    expect(m.get("mb_temp7")?.hiddenByDefault).toBe(true);
    // second CPU driver (coretemp) gets de-duplicated ids
    expect(m.get("cpu_package_2")?.value).toBe(61);
    expect(m.get("cpu_core1")?.value).toBe(58);
  });

  it("missing sysfs → empty list", async () => {
    expect(await readHwmon(join(root, "nope"))).toEqual([]);
    expect(await readThermalZones(join(root, "nope"))).toEqual([]);
  });

  it("thermal zones: CPU zone becomes cpu_package only when hwmon had none", async () => {
    const tz = join(root, "sys", "class", "thermal");
    write(join(tz, "thermal_zone0", "type"), "acpitz");
    write(join(tz, "thermal_zone0", "temp"), "27800");
    write(join(tz, "thermal_zone1", "type"), "x86_pkg_temp");
    write(join(tz, "thermal_zone1", "temp"), "48000");
    write(join(tz, "cooling_device0", "type"), "Processor");
    const alone = await readThermalZones(tz, false);
    expect(alone.find((s) => s.id === "cpu_package")).toMatchObject({ value: 48, kind: "temperature" });
    expect(alone.find((s) => s.id === "thermal_acpitz")).toMatchObject({ value: 27.8, hiddenByDefault: true });
    const withCpu = await readThermalZones(tz, true);
    expect(withCpu.find((s) => s.id === "cpu_package")).toBeUndefined();
    expect(withCpu.find((s) => s.id === "thermal_x86_pkg_temp")).toMatchObject({ hiddenByDefault: true });
    // the source combines both and never duplicates an id
    const src = await new HwmonSource(join(root, "sys", "class", "hwmon"), tz).read();
    expect(src.filter((s) => s.id === "cpu_package")).toHaveLength(1);
  });
});
