import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwmonSource, loadPercent, parseMeminfo, parseProcStat, readHwmon } from "../src/sensors/hwmon.js";

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
  write(join(root, "proc", "stat"), "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0");
  write(join(root, "proc", "meminfo"), "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    4000000 kB");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("hwmon", () => {
  it("maps drivers to stable ids", async () => {
    const s = await readHwmon(join(root, "sys", "class", "hwmon"));
    const m = new Map(s.map((x) => [x.id, x]));
    expect(m.get("cpu_package")).toMatchObject({ value: 52.1, unit: "°C", kind: "temperature", name: "CPU Package" });
    expect(m.get("cpu_ccd1")?.value).toBe(47.5);
    expect(m.get("gpu_core")?.value).toBe(41);
    expect(m.get("gpu_hotspot")?.value).toBe(44);
    expect(m.get("gpu_fan")).toMatchObject({ value: 0, unit: "RPM" });
    expect(m.get("gpu_package_power")).toMatchObject({ value: 8.1, unit: "W" });
    expect(m.get("gpu_core_load")).toMatchObject({ value: 3, unit: "%" });
    expect(m.get("nvme_samsung_ssd_980_1tb_temp")).toMatchObject({ value: 38.9, hardware: "Samsung SSD 980 1TB" });
    expect(m.get("nvme_samsung_ssd_980_1tb_temp_sensor_1")?.value).toBe(45.9);
    expect(m.get("fan_1")?.value).toBe(812);
    expect(m.get("fan_2")?.value).toBe(1043);
    expect(m.get("mainboard_systin")?.value).toBe(34);
    expect(m.get("mainboard_temp7")?.hiddenByDefault).toBe(true);
    // second CPU driver (coretemp) gets de-duplicated ids
    expect(m.get("cpu_package_2")?.value).toBe(61);
    expect(m.get("cpu_core_1")?.value).toBe(58);
  });

  it("missing sysfs → empty list", async () => {
    expect(await readHwmon(join(root, "nope"))).toEqual([]);
  });

  it("computes CPU load from /proc/stat deltas and RAM from meminfo", async () => {
    const src = new HwmonSource(join(root, "sys", "class", "hwmon"), join(root, "proc"));
    const first = await src.read();
    expect(first.find((s) => s.id === "cpu_total_load")).toBeUndefined();
    expect(first.find((s) => s.id === "ram_load")?.value).toBe(75);
    write(join(root, "proc", "stat"), "cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 75 0 75 450 0 0 0 0 0 0\ncpu1 75 0 75 450 0 0 0 0 0 0");
    const second = await src.read();
    expect(second.find((s) => s.id === "cpu_total_load")?.value).toBe(50);
    expect(second.find((s) => s.id === "cpu_thread_1_load")).toMatchObject({ value: 50, hiddenByDefault: true });
  });

  it("parsers", () => {
    const a = parseProcStat("cpu  10 0 10 80 0 0 0 0\n").get("cpu")!;
    const b = parseProcStat("cpu  20 0 20 160 0 0 0 0\n").get("cpu")!;
    expect(loadPercent(a, b)).toBe(20);
    expect(loadPercent(a, a)).toBe(0);
    expect(parseMeminfo("nothing")).toBeNull();
  });
});
