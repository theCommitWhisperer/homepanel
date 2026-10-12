import type { CpuInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { MockSource } from "../src/sensors/mock.js";
import { CombinedSource, cpuLoad, OsSource, sampleCpus } from "../src/sensors/os.js";
import type { InternalSensor, SensorSource } from "../src/sensors/types.js";

const cpu = (user: number, idle: number): CpuInfo => ({ model: "Test CPU", speed: 3000, times: { user, nice: 0, sys: 0, idle, irq: 0 } });

describe("built-in OS sensors", () => {
  it("CPU load from os.cpus() deltas", () => {
    const a = sampleCpus([cpu(100, 900), cpu(100, 900)]);
    const b = sampleCpus([cpu(150, 950), cpu(200, 900)]);
    expect(cpuLoad(a, b)).toEqual({ total: 75, perCpu: [50, 100] });
    expect(cpuLoad(a, a)).toEqual({ total: 0, perCpu: [0, 0] });
  });

  it("publishes cpu_load_total, ram_load, ram_used and load average", async () => {
    let cpus = [cpu(100, 900)];
    const fake = { cpus: () => cpus, totalmem: () => 16 * 1024 ** 3, freemem: () => 4 * 1024 ** 3, loadavg: () => [1.234, 1, 1] };
    const src = new OsSource(fake, "linux");
    cpus = [cpu(130, 970)];
    const m = new Map((await src.read()).map((s) => [s.id, s]));
    expect(m.get("cpu_load_total")).toMatchObject({ value: 30, unit: "%", kind: "load", hardware: "Test CPU" });
    expect(m.get("cpu_load_thread1")).toMatchObject({ value: 30, hiddenByDefault: true });
    expect(m.get("ram_load")).toMatchObject({ value: 75, unit: "%" });
    expect(m.get("ram_used")).toMatchObject({ value: 12, unit: "GB", kind: "data" });
    expect(m.get("load_avg_1m")).toMatchObject({ value: 1.23 });
    expect((await new OsSource(fake, "win32").read()).some((s) => s.id === "load_avg_1m")).toBe(false);
  });

  it("combined source: primary wins on shared ids, survives primary failure", async () => {
    const s = (id: string, value: number): InternalSensor => ({ id, name: id, kind: "load", value, unit: "%" });
    const builtin: SensorSource = { name: "b", read: async () => [s("cpu_load_total", 10), s("ram_load", 50)] };
    let fail = false;
    const primary: SensorSource = { name: "p", read: async () => { if (fail) throw new Error("LHM down"); return [s("cpu_load_total", 99), s("cpu_package", 60)]; } };
    const c = new CombinedSource(primary, builtin);
    expect(await c.read()).toEqual([s("cpu_load_total", 99), s("cpu_package", 60), s("ram_load", 50)]);
    fail = true;
    expect(await c.read()).toEqual([s("cpu_load_total", 10), s("ram_load", 50)]);
    expect(c.lastPrimaryError?.message).toBe("LHM down");
  });

  it("mock source drifts around the fixture values, keeping ids", async () => {
    let t = 0;
    const mock = new MockSource(() => t);
    const a = await mock.read();
    t = 20_000;
    const b = await mock.read();
    expect(b.map((x) => x.id)).toEqual(a.map((x) => x.id));
    const pa = a.find((x) => x.id === "cpu_package")!.value;
    const pb = b.find((x) => x.id === "cpu_package")!.value;
    expect(pb).not.toBe(pa);
    expect(Math.abs(pb - 63.8)).toBeLessThan(8);
    for (const x of b) if (x.unit === "%") expect(x.value).toBeGreaterThanOrEqual(0), expect(x.value).toBeLessThanOrEqual(100);
  });
});
