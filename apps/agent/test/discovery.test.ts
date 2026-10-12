import { describe, expect, it } from "vitest";
import { topics } from "@homepanel/protocol";
import { discoveryMessages, valueTemplate } from "../src/discovery.js";

describe("HA discovery", () => {
  const sensors = [
    { id: "cpu_package", name: "CPU Package", kind: "temperature" as const, value: 60, unit: "°C" },
    { id: "cpu_load_total", name: "CPU Load", kind: "load" as const, value: 12, unit: "%" },
    { id: "gpu_power", name: "GPU Power", kind: "power" as const, value: 200, unit: "W" },
  ];
  const msgs = discoveryMessages("gaming-pc", "Gaming PC", sensors, { publishIntervalMs: 2000 });

  it("topics and ids", () => {
    expect(msgs.map((m) => m.topic)).toEqual([
      "homeassistant/sensor/homepanel_gaming-pc/cpu_package/config",
      "homeassistant/sensor/homepanel_gaming-pc/cpu_load_total/config",
      "homeassistant/sensor/homepanel_gaming-pc/gpu_power/config",
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

  it("value_template picks the sensor by id from the JSON array", () => {
    expect(valueTemplate("cpu_package")).toBe(
      "{% for s in value_json.sensors %}{% if s.id == 'cpu_package' %}{{ s.value }}{% endif %}{% endfor %}",
    );
    expect(msgs[0]!.payload.value_template).toBe(valueTemplate("cpu_package"));
    expect(valueTemplate("x'); evil")).toContain("s.id == 'xevil'");
  });

  it("fans get an icon, no device class", () => {
    const [fan] = discoveryMessages("pc", "PC", [{ id: "fan2", name: "Fan #2", kind: "fan", value: 900, unit: "RPM" }], { publishIntervalMs: 2000 });
    expect(fan!.payload).toMatchObject({ unit_of_measurement: "RPM", icon: "mdi:fan", state_class: "measurement" });
    expect(fan!.payload).not.toHaveProperty("device_class");
  });
});
