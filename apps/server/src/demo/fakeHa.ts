import { EventEmitter } from "node:events";
import type { HaEntityState } from "@homepanel/protocol";
import type { CameraFetchResult, HaSource } from "../ha/types.js";
import { demoCameraSvg } from "./images.js";

const iso = () => new Date().toISOString();

function entity(entity_id: string, state: string, attributes: Record<string, unknown>): HaEntityState {
  const t = iso();
  return { entity_id, state, attributes, last_changed: t, last_updated: t };
}

function light(id: string, name: string, on: boolean, brightness: number, rgb: [number, number, number]) {
  return entity(id, on ? "on" : "off", {
    friendly_name: name,
    supported_color_modes: ["rgb"],
    color_mode: on ? "rgb" : null,
    brightness: on ? brightness : null,
    rgb_color: on ? rgb : null,
    _last_brightness: brightness,
    _last_rgb: rgb,
  });
}

/** Fake Home Assistant for DEMO mode. */
export class FakeHa extends EventEmitter implements HaSource {
  readonly status = "demo" as const;
  private entities = new Map<string, HaEntityState>();
  private timers: NodeJS.Timeout[] = [];

  constructor() {
    super();
    const list: HaEntityState[] = [
      light("light.living_room", "Living Room", true, 180, [255, 180, 107]),
      light("light.kitchen", "Kitchen", false, 255, [255, 255, 255]),
      light("light.office", "Office", true, 120, [120, 140, 255]),
      entity("switch.desk_fan", "off", { friendly_name: "Desk Fan", icon: "mdi:fan" }),
      entity("sensor.outdoor_temperature", "12.4", {
        friendly_name: "Outdoor Temperature",
        unit_of_measurement: "°C",
        device_class: "temperature",
        state_class: "measurement",
      }),
      entity("weather.home", "partlycloudy", {
        friendly_name: "Home",
        temperature: 12.4,
        temperature_unit: "°C",
        humidity: 71,
        pressure: 1014,
        wind_speed: 14,
        wind_speed_unit: "km/h",
        forecast: [
          { datetime: iso(), condition: "partlycloudy", temperature: 14, templow: 7 },
          { datetime: iso(), condition: "rainy", temperature: 11, templow: 6 },
          { datetime: iso(), condition: "sunny", temperature: 16, templow: 8 },
        ],
      }),
      entity("binary_sensor.front_door_ring", "off", { friendly_name: "Front Door Visitor", device_class: "occupancy" }),
      entity("camera.front_door", "idle", {
        friendly_name: "Front Door",
        brand: "Reolink",
        model_name: "Video Doorbell PoE",
        entity_picture: "/api/camera_proxy/camera.front_door",
      }),
      entity("event.side_door_ring", new Date(Date.now() - 3_600_000).toISOString(), {
        friendly_name: "Side Door Ring",
        event_type: "ring",
        event_types: ["ring"],
        device_class: "doorbell",
      }),
      entity("camera.side_door", "idle", { friendly_name: "Side Door", brand: "Eufy" }),
      entity("lock.front_door", "locked", { friendly_name: "Front Door Lock" }),
      entity("sun.sun", "above_horizon", { friendly_name: "Sun" }),
    ];
    for (const e of list) this.entities.set(e.entity_id, e);
  }

  start() {
    // outdoor temperature drifts slowly
    const t = setInterval(() => {
      const cur = this.entities.get("sensor.outdoor_temperature")!;
      const v = Math.max(-5, Math.min(30, Number(cur.state) + (Math.random() - 0.5) * 0.3));
      this.set("sensor.outdoor_temperature", v.toFixed(1), cur.attributes);
      const w = this.entities.get("weather.home")!;
      this.set("weather.home", w.state, { ...w.attributes, temperature: Math.round(v * 10) / 10 });
    }, 30_000);
    t.unref?.();
    this.timers.push(t);
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  states() {
    return [...this.entities.values()].map(publicState);
  }

  getState(id: string) {
    const e = this.entities.get(id);
    return e ? publicState(e) : undefined;
  }

  set(id: string, state: string, attributes: Record<string, unknown>) {
    const prev = this.entities.get(id) ?? null;
    const t = iso();
    const next: HaEntityState = {
      entity_id: id,
      state,
      attributes,
      last_changed: prev && prev.state === state ? prev.last_changed : t,
      last_updated: t,
    };
    this.entities.set(id, next);
    this.emit("state", id, publicState(next), prev ? publicState(prev) : null);
  }

  /** Simulate a doorbell press: binary_sensor on → off after 5 s (front), event update (side). */
  ring(which: "front" | "side" = "front") {
    if (which === "side") {
      const e = this.entities.get("event.side_door_ring")!;
      this.set("event.side_door_ring", iso(), e.attributes);
      return;
    }
    const e = this.entities.get("binary_sensor.front_door_ring")!;
    if (e.state === "on") this.set(e.entity_id, "off", e.attributes);
    this.set(e.entity_id, "on", e.attributes);
    const t = setTimeout(() => this.set(e.entity_id, "off", e.attributes), 5_000);
    t.unref?.();
  }

  async callService(domain: string, service: string, data: Record<string, unknown> = {}) {
    const raw = data.entity_id;
    const ids: string[] = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
    if (!ids.length) {
      if (domain === "homeassistant" || domain === "notify" || domain === "script" || domain === "scene") return;
      throw new Error("entity_id required");
    }
    for (const id of ids) {
      const e = this.entities.get(id);
      if (!e) throw new Error(`Entity ${id} not found`);
      const d = id.split(".")[0];
      const svc = service;
      if (domain !== d && domain !== "homeassistant") throw new Error(`Service ${domain}.${service} does not apply to ${id}`);
      if (d === "light") this.light(e, svc, data);
      else if (d === "switch" || d === "fan" || d === "input_boolean") {
        const on = svc === "turn_on" ? true : svc === "turn_off" ? false : svc === "toggle" ? e.state !== "on" : undefined;
        if (on === undefined) throw new Error(`Unsupported service ${domain}.${service}`);
        this.set(id, on ? "on" : "off", e.attributes);
      } else if (d === "lock") {
        if (svc === "lock" || svc === "unlock") this.set(id, svc === "lock" ? "locked" : "unlocked", e.attributes);
        else throw new Error(`Unsupported service ${domain}.${service}`);
      } else if (svc !== "update_entity") {
        throw new Error(`Unsupported service ${domain}.${service}`);
      }
    }
  }

  private light(e: HaEntityState, svc: string, data: Record<string, unknown>) {
    const a = e.attributes as Record<string, any>;
    let on = svc === "turn_on" ? true : svc === "turn_off" ? false : svc === "toggle" ? e.state !== "on" : undefined;
    if (on === undefined) throw new Error(`Unsupported service light.${svc}`);
    let brightness: number = a._last_brightness ?? 255;
    let rgb: [number, number, number] = a._last_rgb ?? [255, 255, 255];
    if (on) {
      if (typeof data.brightness === "number") brightness = data.brightness;
      if (typeof data.brightness_pct === "number") brightness = Math.round((data.brightness_pct / 100) * 255);
      if (Array.isArray(data.rgb_color) && data.rgb_color.length === 3) rgb = data.rgb_color.map(Number) as [number, number, number];
      brightness = Math.max(0, Math.min(255, Math.round(brightness)));
      if (brightness === 0) on = false;
    }
    this.set(e.entity_id, on ? "on" : "off", {
      ...a,
      color_mode: on ? "rgb" : null,
      brightness: on ? brightness : null,
      rgb_color: on ? rgb : null,
      _last_brightness: brightness || a._last_brightness || 255,
      _last_rgb: rgb,
    });
  }

  async camera(entityId: string, kind: "snapshot" | "stream", signal: AbortSignal): Promise<CameraFetchResult> {
    const e = this.entities.get(entityId);
    if (!e || !(entityId.startsWith("camera.") || entityId.startsWith("image."))) {
      return { status: 404, contentType: "text/plain", body: Buffer.from("camera not found") };
    }
    const name = String(e.attributes.friendly_name ?? entityId);
    if (kind === "snapshot") {
      return { status: 200, contentType: "image/svg+xml", body: Buffer.from(demoCameraSvg(name)) };
    }
    // multipart "MJPEG-like" stream of SVG frames, one per second (Safari/Chrome render multipart/x-mixed-replace in <img>)
    const { PassThrough } = await import("node:stream");
    const out = new PassThrough();
    const boundary = "homepanelframe";
    const frame = () => {
      const svg = Buffer.from(demoCameraSvg(name));
      out.write(`--${boundary}\r\nContent-Type: image/svg+xml\r\nContent-Length: ${svg.length}\r\n\r\n`);
      out.write(svg);
      out.write("\r\n");
    };
    frame();
    const iv = setInterval(frame, 1000);
    const close = () => {
      clearInterval(iv);
      out.end();
    };
    signal.addEventListener("abort", close, { once: true });
    out.on("close", () => clearInterval(iv));
    return { status: 200, contentType: `multipart/x-mixed-replace; boundary=${boundary}`, body: out, close };
  }
}

/** Strip internal underscore attributes. */
function publicState(e: HaEntityState): HaEntityState {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e.attributes)) if (!k.startsWith("_")) attrs[k] = v;
  return { ...e, attributes: attrs };
}
