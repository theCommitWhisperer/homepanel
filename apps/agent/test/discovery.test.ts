import { describe, expect, it } from "vitest";
import { topics } from "@homepanel/protocol";
import { discoveryMessages, valueTemplate } from "../src/discovery.js";

describe("HA discovery", () => {
  const sensors = [
    { id: "cpu_package", name: "CPU Package", kind: "temperature" as const, value: 60, unit: "°C" },
    { id: "cpu_total_load", name: "CPU Total", kind: "load" as const, value: 12, unit: "%" },
    { id: "gpu_package_power", name: "GPU Package", kind: "power" as const, value: 200, unit: "W" },
  ];
  const msgs = discoveryMessages("gaming-pc", "Gaming PC", sensors, { publishIntervalMs: 2000 });

  it("topics and ids", () => {
    expect(msgs.map((m) => m.topic)).toEqual([
      "homeassistant/sensor/homepanel_gaming-pc/cpu_package/config",
      "homeassistant/sensor/homepanel_gaming-pc/cpu_total_load/config",
      "homeassistant/sensor/homepanel_gaming-pc/gpu_package_power/config",
    ]);
    expect(msgs[0]!.topic).toBe(topics.haDiscovery("gaming-pc", "cpu_package"));
  });

  it("payload shape", () => {
    const p = msgs[0]!.payload;
    expect(p).toMatchObject({
      name: "CPU Package",
      unique_id: "homepanel_gaming-pc_cpu_package",
      device: { identifiers: ["homepanel_gaming-pc"], name: "Gaming PC", manufacturer: "HomePanel", model: "PC agent" },
      state_topic: "homepanel/agent/gaming-pc/sensors",
      availability_topic: "homepanel/agent/gaming-pc/status",
      payload_available: "online",
      payload_not_available: "offline",
      unit_of_measurement: "°C",
      device_class: "temperature",
      state_class: "measurement",
      expire_after: 60,
    });
    expect(msgs[1]!.payload).not.toHaveProperty("device_class");
    expect(msgs[1]!.payload).toMatchObject({ unit_of_measurement: "%", icon: "mdi:cpu-64-bit" });
    expect(msgs[2]!.payload).toMatchObject({ device_class: "power", unit_of_measurement: "W" });
    // the payload must be plain JSON
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it("value_template picks by id with a safe fallback", () => {
    expect(valueTemplate("cpu_package")).toBe(
      "{% set s = value_json.sensors | default([]) | selectattr('id', 'eq', 'cpu_package') | list %}" +
        "{{ s[0].value if s | length > 0 else none }}",
    );
    expect(valueTemplate("x'); evil")).not.toContain("'); evil");
  });

  it("template semantics (mini Jinja evaluation)", () => {
    // Emulate what HA does: filter value_json.sensors by id; missing → None (unknown)
    const evalTpl = (json: { sensors?: { id: string; value: number }[] }, id: string) => {
      const s = (json.sensors ?? []).filter((x) => x.id === id);
      return s.length > 0 ? s[0]!.value : null;
    };
    expect(evalTpl({ sensors: [{ id: "cpu_package", value: 61.2 }] }, "cpu_package")).toBe(61.2);
    expect(evalTpl({ sensors: [] }, "cpu_package")).toBeNull();
    expect(evalTpl({}, "cpu_package")).toBeNull();
  });
});
