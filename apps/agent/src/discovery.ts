/**
 * Home Assistant MQTT discovery for agent sensors.
 * https://www.home-assistant.io/integrations/sensor.mqtt/
 *
 * Each sensor's state is picked out of the shared sensors JSON array by id with a Jinja loop.
 * All entities share one state topic, so HA parses one message per interval for the whole PC.
 */
import type { AgentSensor } from "@homepanel/protocol";
import { topics } from "@homepanel/protocol";
import { AGENT_VERSION } from "./util.js";

export interface DiscoveryMessage {
  topic: string;
  payload: Record<string, unknown>;
}

export function valueTemplate(sensorId: string): string {
  // ids are [a-z0-9_] slugs, so they're safe inside a single-quoted Jinja string
  const safe = sensorId.replace(/[^a-z0-9_]/gi, "");
  return `{% for s in value_json.sensors %}{% if s.id == '${safe}' %}{{ s.value }}{% endif %}{% endfor %}`;
}

function deviceClass(s: AgentSensor): string | undefined {
  if (s.unit === "°C") return "temperature";
  if (s.kind === "power" && s.unit === "W") return "power";
  if (s.kind === "data" && /^(GB|MB|KB|TB)$/.test(s.unit)) return "data_size";
  if (s.kind === "clock" && /^(MHz|GHz)$/.test(s.unit)) return "frequency";
  return undefined;
}

function icon(s: AgentSensor): string | undefined {
  if (deviceClass(s)) return undefined; // HA picks one from the device class
  if (s.kind === "fan") return "mdi:fan";
  if (s.kind === "load") return s.id.startsWith("gpu") ? "mdi:expansion-card" : s.id.startsWith("ram") ? "mdi:memory" : s.id.startsWith("cpu") ? "mdi:cpu-64-bit" : "mdi:gauge";
  return undefined;
}

export function discoveryMessages(
  pc: string,
  pcName: string,
  sensors: AgentSensor[],
  opts: { publishIntervalMs: number },
): DiscoveryMessage[] {
  const device = {
    identifiers: [`homepanel_${pc}`],
    name: pcName,
    manufacturer: "HomePanel",
    model: "PC agent",
    sw_version: AGENT_VERSION,
  };
  // mark the entity unavailable if no update arrives for ~10 intervals (min 60 s)
  const expireAfter = Math.max(60, Math.ceil((opts.publishIntervalMs * 10) / 1000));
  return sensors.map((s) => {
    const payload: Record<string, unknown> = {
      name: s.name,
      unique_id: `homepanel_${pc}_${s.id}`,
      // entity_id becomes sensor.<device name>_<sensor name>, e.g. sensor.gaming_pc_cpu_package
      has_entity_name: true,
      device,
      state_topic: topics.sensors(pc),
      value_template: valueTemplate(s.id),
      unit_of_measurement: s.unit || undefined,
      state_class: "measurement",
      availability_topic: topics.status(pc),
      payload_available: "online",
      payload_not_available: "offline",
      expire_after: expireAfter,
      suggested_display_precision: s.unit === "RPM" || s.unit === "MHz" ? 0 : 1,
    };
    const dc = deviceClass(s);
    if (dc) payload.device_class = dc;
    const ic = icon(s);
    if (ic) payload.icon = ic;
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
    return { topic: topics.haDiscovery(pc, s.id), payload };
  });
}
