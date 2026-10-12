#!/usr/bin/env node
/**
 * HomePanel dev mock server — just enough of the contract (packages/protocol) to drive the kiosk UI
 * while the real server is being built. Plain Node + `ws`.
 *
 *   node dev/mock-server.mjs            → http://localhost:8080  (vite dev/preview proxy here)
 *   PORT=8099 node dev/mock-server.mjs
 *   SERVE_DIST=1 also serves ./dist like the real server would.
 *
 * Device token "demo" is pre-paired (profile desk-monitor); "ipad" → kitchen-ipad; "fire" → fire-hd8.
 * Admin password: demo.   POST /mock/ring triggers a doorbell takeover (also every RING_EVERY_S if set).
 * GET /mock/offline?pc=gaming-pc toggles the PC asleep/awake.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "../dist");

/* ------------------------------------------------------------------ profiles */
const profiles = {
  "desk-monitor": {
    id: "desk-monitor", name: "Desk monitor", grid: { cols: 12, rows: 8 }, theme: "dark", lite: false,
    idle: { after: "10m", show: "idle-gif" },
    widgets: [
      { type: "clock", at: [0, 0, 4, 3], showDate: true },
      { type: "pc-temps", at: [4, 0, 5, 4], pc: "gaming-pc", title: "Gaming PC" },
      { type: "entity", at: [9, 0, 3, 3], entity: "weather.home", label: "Outside" },
      { type: "lights", at: [0, 3, 4, 3], entities: ["light.living_room", "light.desk_lamp", "light.hallway"] },
      { type: "media", id: "idle-gif", at: [9, 3, 3, 3], src: "/media/gifs/aurora.svg", fit: "cover" },
      { type: "pc-drives", at: [0, 6, 6, 2], pc: "gaming-pc" },
      { type: "buttons", at: [6, 6, 6, 2], pc: "gaming-pc" },
      { type: "camera", at: [4, 4, 5, 2], entity: "camera.front_door", title: "Front door" },
    ],
  },
  "kitchen-ipad": {
    id: "kitchen-ipad", name: "Kitchen iPad", grid: { cols: 6, rows: 8 }, theme: "dark", lite: false,
    widgets: [
      { type: "clock", at: [0, 0, 4, 2], showDate: true },
      { type: "entity", at: [4, 0, 2, 2], entity: "weather.home", label: "Outside" },
      { type: "camera", at: [0, 2, 4, 4], entity: "camera.front_door", title: "Front door" },
      { type: "lights", at: [4, 2, 2, 4], entities: ["light.living_room", "light.desk_lamp", "light.hallway"] },
      { type: "buttons", at: [0, 6, 6, 2], buttons: [
        { label: "All lights off", icon: "bulb", action: { kind: "ha", domain: "light", service: "turn_off", data: { entity_id: "all" } } },
        { label: "Wake gaming PC", icon: "power", action: { kind: "wol", pc: "gaming-pc" } },
        { label: "Movie scene", icon: "play", action: { kind: "ha", domain: "scene", service: "turn_on", data: { entity_id: "scene.movie" } } },
        { label: "Kitchen fan", icon: "fan", action: { kind: "ha", domain: "switch", service: "toggle", data: { entity_id: "switch.kitchen_fan" } } },
      ] },
    ],
  },
  "fire-hd8": {
    id: "fire-hd8", name: "Fire HD 8", grid: { cols: 4, rows: 6 }, theme: "dark", lite: true,
    widgets: [
      { type: "clock", at: [0, 0, 4, 2], showDate: true, format24: false },
      { type: "lights", at: [0, 2, 4, 2], entities: ["light.living_room", "light.desk_lamp", "light.hallway", "switch.kitchen_fan"] },
      { type: "buttons", at: [0, 4, 4, 2], pc: "gaming-pc" },
    ],
  },
};
const toYaml = (p) => {
  // tiny YAML emitter good enough for these demo profiles
  const lines = [];
  const scalar = (v) => (typeof v === "string" ? (/^[\w./:-]+$/.test(v) && !/^(true|false|null|\d+)$/.test(v) ? v : JSON.stringify(v)) : JSON.stringify(v));
  const flow = (v) => (Array.isArray(v) ? "[" + v.map(flow).join(", ") + "]" : v && typeof v === "object" ? "{ " + Object.entries(v).map(([k, x]) => k + ": " + flow(x)).join(", ") + " }" : scalar(v));
  for (const [k, v] of Object.entries(p)) {
    if (k === "widgets") {
      lines.push("widgets:");
      for (const w of v) {
        const ent = Object.entries(w);
        ent.forEach(([wk, wv], i) => lines.push((i ? "    " : "  - ") + wk + ": " + flow(wv)));
      }
    } else lines.push(k + ": " + flow(v));
  }
  return lines.join("\n") + "\n";
};
const profileYaml = Object.fromEntries(Object.entries(profiles).map(([id, p]) => [id, toYaml(p)]));

/* ------------------------------------------------------------------ devices + pairing */
const devices = {
  demo: { id: "dev-desk", name: "Desk monitor", profileId: "desk-monitor" },
  ipad: { id: "dev-ipad", name: "Kitchen iPad", profileId: "kitchen-ipad" },
  fire: { id: "dev-fire", name: "Hallway Fire", profileId: "fire-hd8" },
};
const pairings = new Map(); // pairingId → {pairingId, code, userAgent, ip, createdAt, expiresAt, status, token?}
let seq = 1;
const adminSessions = new Set();

/* ------------------------------------------------------------------ demo state */
let pcOnline = true;
const base = { cpu_package: 61, cpu_ccd1: 57, gpu_core: 54, gpu_hotspot: 66, nvme0_temp: 42, mobo: 38 };
const sensorDefs = [
  ["cpu_package", "CPU Package", "temperature", "°C", "AMD Ryzen 7 7800X3D"],
  ["cpu_ccd1", "CPU CCD1", "temperature", "°C", "AMD Ryzen 7 7800X3D"],
  ["gpu_core", "GPU Core", "temperature", "°C", "NVIDIA GeForce RTX 4080"],
  ["gpu_hotspot", "GPU Hot Spot", "temperature", "°C", "NVIDIA GeForce RTX 4080"],
  ["nvme0_temp", "NVMe SSD", "temperature", "°C", "Samsung 990 Pro"],
  ["mobo", "Motherboard", "temperature", "°C", "ASUS B650"],
  ["cpu_load", "CPU Load", "load", "%", "AMD Ryzen 7 7800X3D"],
  ["gpu_load", "GPU Load", "load", "%", "NVIDIA GeForce RTX 4080"],
  ["cpu_fan", "CPU Fan", "fan", "RPM", "ASUS B650"],
];
let t = 0;
function sensors() {
  t += 1;
  const wav = (k, a, p) => a * Math.sin(t / p + k.length);
  const v = {};
  for (const k of Object.keys(base)) v[k] = +(base[k] + wav(k, 4, 6) + (Math.random() - 0.5) * 2.2).toFixed(1);
  v.gpu_hotspot = +(v.gpu_hotspot + 10 + 8 * Math.max(0, Math.sin(t / 25))).toFixed(1); // occasionally warm
  v.cpu_load = +(35 + wav("l", 25, 5) + Math.random() * 8).toFixed(0);
  v.gpu_load = +(60 + wav("g", 30, 8)).toFixed(0);
  v.cpu_fan = Math.round(1100 + v.cpu_package * 8);
  return { ts: Date.now(), pc: "gaming-pc", hostname: "KEVIN-RIG", sensors: sensorDefs.map(([id, name, kind, unit, hardware]) => ({ id, name, kind, unit, hardware, value: v[id] })) };
}
const drives = () => ({ ts: Date.now(), pc: "gaming-pc", drives: [
  { letter: "C:", label: "Windows", totalGB: 1000, freeGB: 312.4 },
  { letter: "D:", label: "Games", totalGB: 4000, freeGB: 388 },
  { letter: "E:", label: "Media", totalGB: 8000, freeGB: 3150 },
  { letter: "F:", label: "Backup", totalGB: 2000, freeGB: 62 },
] });
const actions = { pc: "gaming-pc", actions: [
  { id: "open-c", label: "Open C:", type: "open", icon: "folder" },
  { id: "open-d", label: "Open Games", type: "open", icon: "folder" },
  { id: "open-e", label: "Open Media", type: "open", icon: "folder" },
  { id: "steam", label: "Launch Steam", type: "launch", icon: "play" },
  { id: "discord", label: "Discord", type: "launch" },
  { id: "mute", label: "Mute audio", type: "keys", icon: "keyboard" },
  { id: "lock", label: "Lock PC", type: "system", icon: "lock", guard: "home-only" },
  { id: "sleep", label: "Sleep", type: "system", icon: "moon", guard: "confirm" },
  { id: "shutdown", label: "Shut down", type: "system", icon: "power", guard: "confirm+home-only" },
] };
const now = () => new Date().toISOString();
const ha = {
  "light.living_room": { state: "on", attributes: { friendly_name: "Living room", brightness: 200, supported_color_modes: ["xy", "color_temp"], color_mode: "xy", rgb_color: [255, 196, 128] } },
  "light.desk_lamp": { state: "off", attributes: { friendly_name: "Desk lamp", supported_color_modes: ["brightness"] } },
  "light.hallway": { state: "on", attributes: { friendly_name: "Hallway", brightness: 90, supported_color_modes: ["rgb"], rgb_color: [120, 170, 255] } },
  "switch.kitchen_fan": { state: "off", attributes: { friendly_name: "Kitchen fan" } },
  "weather.home": { state: "partlycloudy", attributes: { friendly_name: "Home", temperature: 64, temperature_unit: "°F", humidity: 58, forecast: [
    { datetime: new Date(Date.now() + 864e5).toISOString(), temperature: 66, templow: 51, condition: "sunny" },
    { datetime: new Date(Date.now() + 2 * 864e5).toISOString(), temperature: 59, templow: 48, condition: "rainy" },
    { datetime: new Date(Date.now() + 3 * 864e5).toISOString(), temperature: 61, templow: 47, condition: "cloudy" },
  ] } },
  "camera.front_door": { state: "idle", attributes: { friendly_name: "Front door" } },
  "binary_sensor.front_door_visitor": { state: "off", attributes: { friendly_name: "Front door visitor" } },
};
for (const [id, e] of Object.entries(ha)) Object.assign(e, { entity_id: id, last_changed: now(), last_updated: now() });

const agentsSummary = () => [{ pcId: "gaming-pc", name: "Gaming PC", status: pcOnline ? "online" : "offline", lastSeen: Date.now() - (pcOnline ? 0 : 3600e3), hostname: "KEVIN-RIG", hasMac: true }];

/* ------------------------------------------------------------------ ws */
const clients = new Set(); // {ws, token, keys:Set}
function valueFor(key) {
  if (key === "agents") return agentsSummary();
  if (key.startsWith("ha:")) return ha[key.slice(3)];
  const m = /^agent:([^:]+):(\w+)$/.exec(key);
  if (m && m[1] === "gaming-pc") {
    if (m[2] === "status") return pcOnline ? "online" : "offline";
    if (m[2] === "sensors") return pcOnline ? sensors() : undefined;
    if (m[2] === "drives") return drives();
    if (m[2] === "actions") return actions;
  }
  return undefined;
}
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
function publish(key, value) {
  for (const c of clients) if (c.keys.has(key)) send(c.ws, { type: "state", key, value, ts: Date.now() });
}

function runAction(c, msg) {
  const a = msg.action || {};
  const reply = (ok, error) => setTimeout(() => send(c.ws, { type: "action_result", id: msg.id, ok, ...(error ? { error } : {}) }), 350 + Math.random() * 500);
  if (a.kind === "ha") {
    const ids = [].concat(a.data?.entity_id ?? []);
    for (const id of ids) {
      const e = ha[id];
      if (!e) continue;
      if (a.service === "toggle") e.state = e.state === "on" ? "off" : "on";
      if (a.service === "turn_on") { e.state = "on"; if (a.data.brightness_pct != null) e.attributes.brightness = Math.round(a.data.brightness_pct * 2.55); if (a.data.rgb_color) e.attributes.rgb_color = a.data.rgb_color; }
      if (a.service === "turn_off") e.state = "off";
      if (a.service === "toggle" && e.state === "on" && id.startsWith("light.") && e.attributes.brightness == null && e.attributes.supported_color_modes?.[0] !== "onoff") e.attributes.brightness = 255;
      e.last_changed = e.last_updated = now();
      setTimeout(() => publish("ha:" + id, e), 200);
    }
    if (ids.includes("all")) for (const [id, e] of Object.entries(ha)) if (id.startsWith("light.")) { e.state = "off"; setTimeout(() => publish("ha:" + id, e), 200); }
    return reply(true);
  }
  if (a.kind === "wol") { setTimeout(() => { pcOnline = true; broadcastPc(); }, 3000); return reply(true); }
  if (a.kind === "agent") {
    const info = actions.actions.find((x) => x.id === a.action);
    if (!info) return reply(false, "unknown action");
    if (!pcOnline) return reply(false, "offline");
    if (info.guard?.includes("confirm") && !msg.confirmed) return reply(false, "confirm-required");
    if (a.action === "sleep" || a.action === "shutdown") setTimeout(() => { pcOnline = false; broadcastPc(); }, 1500);
    return reply(true);
  }
  reply(false, "bad action");
}
function broadcastPc() {
  publish("agent:gaming-pc:status", pcOnline ? "online" : "offline");
  publish("agents", agentsSummary());
}

function takeover() {
  const id = "ring-" + Date.now();
  const tk = { id, kind: "doorbell", title: "Someone's at the front door", camera: "camera.front_door",
    streamUrl: "/api/camera/camera.front_door/stream", snapshotUrl: "/api/camera/camera.front_door/snapshot",
    message: "Front door · Reolink doorbell", closeAfterMs: 60000,
    actions: [{ label: "Turn on porch light", action: { kind: "ha", domain: "light", service: "turn_on", data: { entity_id: "light.hallway" } } }] };
  for (const c of clients) if (c.token) send(c.ws, { type: "takeover", takeover: tk });
  return id;
}

/* ------------------------------------------------------------------ http */
const svgSnapshot = () => {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#55606b"/><stop offset="1" stop-color="#2a3138"/></linearGradient>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3c4a3a"/><stop offset="1" stop-color="#232b22"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#s)"/>
<rect y="430" width="1280" height="290" fill="url(#g)"/>
<path d="M430 720 L560 430 L720 430 L850 720Z" fill="#6b6f72"/>
<rect x="520" y="150" width="240" height="290" fill="#3b2b22" stroke="#1b1410" stroke-width="10"/>
<circle cx="735" cy="300" r="9" fill="#c9a65a"/>
<rect x="140" y="170" width="220" height="160" fill="#8fb0c8" opacity=".55" stroke="#222" stroke-width="8"/>
<rect x="920" y="170" width="220" height="160" fill="#8fb0c8" opacity=".55" stroke="#222" stroke-width="8"/>
<ellipse cx="${640 + 40 * Math.sin(Date.now() / 3000)}" cy="560" rx="60" ry="16" fill="#000" opacity=".25"/>
<g transform="translate(${600 + 40 * Math.sin(Date.now() / 3000)} 360)"><circle cx="40" cy="40" r="36" fill="#d8b49a"/><rect x="0" y="80" width="80" height="120" rx="30" fill="#2f5d8a"/></g>
<rect x="0" y="0" width="1280" height="44" fill="#000" opacity=".45"/>
<text x="20" y="30" font-family="monospace" font-size="22" fill="#fff">FRONT DOOR  ${new Date().toISOString().slice(0, 10)} ${ts}</text></svg>`;
};
const auroraSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a1a2a"/><stop offset="1" stop-color="#1a2f3a"/></linearGradient>
<linearGradient id="a" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5cc8be" stop-opacity="0"/><stop offset=".5" stop-color="#5cc8be" stop-opacity=".8"/><stop offset="1" stop-color="#9b7bff" stop-opacity="0"/></linearGradient></defs>
<rect width="600" height="600" fill="url(#b)"/>
<path d="M-50 260 C 120 140, 260 320, 650 180" stroke="url(#a)" stroke-width="70" fill="none" opacity=".7"><animate attributeName="d" dur="9s" repeatCount="indefinite" values="M-50 260 C 120 140, 260 320, 650 180;M-50 220 C 160 300, 300 140, 650 240;M-50 260 C 120 140, 260 320, 650 180"/></path>
<path d="M-50 330 C 200 240, 330 380, 650 270" stroke="url(#a)" stroke-width="40" fill="none" opacity=".45"><animate attributeName="d" dur="13s" repeatCount="indefinite" values="M-50 330 C 200 240, 330 380, 650 270;M-50 300 C 180 380, 360 260, 650 320;M-50 330 C 200 240, 330 380, 650 270"/></path>
<path d="M0 600 L0 470 L90 400 L160 450 L250 370 L340 440 L420 390 L520 460 L600 420 L600 600Z" fill="#081018"/>
<g fill="#fff" opacity=".8"><circle cx="60" cy="60" r="1.6"/><circle cx="180" cy="90" r="1.2"/><circle cx="320" cy="40" r="1.8"/><circle cx="450" cy="110" r="1.1"/><circle cx="540" cy="50" r="1.5"/><circle cx="250" cy="130" r="1"/></g></svg>`;

function readBody(req) {
  return new Promise((res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => res(b)); });
}
function json(res, code, data) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); }
const isAdmin = (req) => adminSessions.has((req.headers.authorization || "").replace(/^Bearer /, ""));
const deviceOk = (req, url) => !!devices[url.searchParams.get("t") || (req.headers.authorization || "").replace(/^Bearer /, "")];
let config = `doorbells:\n  front:\n    provider: reolink\n    name: Front door\n    ring: binary_sensor.front_door_visitor\n    camera: camera.front_door\non_ring:\n  show_on: []\n  wake_screens: true\n  close_after: 60s\nfully_kiosk: {}\nassistant: {}\n`;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const m = (method, re) => req.method === method && re.exec(p);
  let r;
  try {
    if (p === "/api/health") return json(res, 200, { ok: true, ha: "demo", mqtt: "demo", version: "mock" });

    /* pairing */
    if (m("POST", /^\/api\/pair\/start$/)) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const pr = { pairingId: "p" + seq++, code, userAgent: req.headers["user-agent"] || "", ip: req.socket.remoteAddress || "", createdAt: Date.now(), expiresAt: Date.now() + 5 * 60e3, status: "pending" };
      pairings.set(pr.pairingId, pr);
      return json(res, 200, { pairingId: pr.pairingId, code, expiresAt: pr.expiresAt });
    }
    if ((r = m("GET", /^\/api\/pair\/status\/([^/]+)$/))) {
      const pr = pairings.get(r[1]);
      if (!pr) return json(res, 404, { error: "unknown" });
      if (pr.status === "pending" && Date.now() > pr.expiresAt) pr.status = "expired";
      if (pr.status === "approved") return json(res, 200, { status: "approved", deviceToken: pr.token, device: devices[pr.token] });
      return json(res, 200, { status: pr.status });
    }

    /* camera + media (device auth) */
    if ((r = m("GET", /^\/api\/camera\/([^/]+)\/(snapshot|stream)$/))) {
      if (!deviceOk(req, url)) return json(res, 401, { error: "unauthorized" });
      if (r[2] === "snapshot") { res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" }); return res.end(svgSnapshot()); }
      // "MJPEG" stand-in: a multipart stream of SVG frames isn't supported by browsers, so serve a snapshot.
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
      return res.end(svgSnapshot());
    }
    if (m("GET", /^\/api\/media$/)) return json(res, 200, ["gifs/aurora.svg", "photos/one.svg", "photos/two.svg"]);
    if ((r = m("GET", /^\/media\/(.+)$/))) {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      if (r[1].includes("aurora")) return res.end(auroraSvg);
      const hue = r[1].includes("one") ? 200 : 30;
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="hsl(${hue},40%,30%)"/><text x="200" y="160" font-size="40" text-anchor="middle" fill="#fff" font-family="sans-serif">${r[1]}</text></svg>`);
    }

    /* mock helpers */
    if (p === "/mock/ring" || p === "/api/demo/ring") return json(res, 200, { ok: true, id: takeover() });
    if (p === "/mock/offline") { pcOnline = !pcOnline; broadcastPc(); return json(res, 200, { online: pcOnline }); }
    if (p === "/mock/approve-all") { for (const pr of pairings.values()) if (pr.status === "pending") { pr.status = "approved"; pr.token = "demo"; } return json(res, 200, { ok: true }); }

    /* admin */
    if (m("POST", /^\/api\/admin\/login$/)) {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (b.password !== "demo") return json(res, 401, { error: "Wrong password" });
      const s = "adm-" + Math.random().toString(36).slice(2);
      adminSessions.add(s);
      return json(res, 200, { session: s });
    }
    if (p.startsWith("/api/admin/") && !isAdmin(req)) return json(res, 401, { error: "Sign in again" });
    if (m("GET", /^\/api\/admin\/pairings$/)) {
      const list = [...pairings.values()].filter((x) => x.status === "pending" && x.expiresAt > Date.now());
      if (!list.length) list.push({ pairingId: "fake-fire", code: "482913", userAgent: "Mozilla/5.0 (Linux; Android 9; KFONWI) AppleWebKit/537.36 Silk/100.0", ip: "192.168.1.47", createdAt: Date.now() - 40e3 });
      return json(res, 200, list.map(({ pairingId, code, userAgent, ip, createdAt }) => ({ pairingId, code, userAgent, ip, createdAt })));
    }
    if ((r = m("POST", /^\/api\/admin\/pairings\/([^/]+)\/approve$/))) {
      const b = JSON.parse((await readBody(req)) || "{}");
      const token = "tok-" + Math.random().toString(36).slice(2);
      devices[token] = { id: "dev-" + seq++, name: b.name, profileId: b.profileId };
      const pr = pairings.get(r[1]);
      if (pr) { pr.status = "approved"; pr.token = token; }
      return json(res, 200, devices[token]);
    }
    if ((r = m("POST", /^\/api\/admin\/pairings\/([^/]+)\/reject$/))) { const pr = pairings.get(r[1]); if (pr) pr.status = "rejected"; return json(res, 200, { ok: true }); }
    if (m("GET", /^\/api\/admin\/devices$/)) return json(res, 200, Object.values(devices));
    if ((r = m("PATCH", /^\/api\/admin\/devices\/([^/]+)$/))) {
      const b = JSON.parse((await readBody(req)) || "{}");
      for (const [tok, d] of Object.entries(devices)) if (d.id === r[1]) {
        Object.assign(d, b);
        for (const c of clients) if (c.token === tok && b.profileId && profiles[b.profileId]) send(c.ws, { type: "profile", profile: profiles[b.profileId] });
      }
      return json(res, 200, { ok: true });
    }
    if ((r = m("DELETE", /^\/api\/admin\/devices\/([^/]+)$/))) {
      for (const [tok, d] of Object.entries(devices)) if (d.id === r[1]) {
        delete devices[tok];
        for (const c of clients) if (c.token === tok) send(c.ws, { type: "unauthorized", reason: "This screen was removed in the admin page." });
      }
      return json(res, 200, { ok: true });
    }
    if (m("GET", /^\/api\/admin\/profiles$/)) return json(res, 200, Object.values(profiles).map((x) => ({ id: x.id, name: x.name, yaml: profileYaml[x.id] })));
    if ((r = m("PUT", /^\/api\/admin\/profiles\/([^/]+)$/))) {
      const body = await readBody(req);
      if (!/^id:\s*/m.test(body)) return json(res, 200, { ok: false, errors: ["id: Required"] });
      const name = (/^name:\s*(.+)$/m.exec(body) || [])[1] || r[1];
      profileYaml[r[1]] = body;
      if (!profiles[r[1]]) profiles[r[1]] = { id: r[1], name, grid: { cols: 6, rows: 4 }, theme: "dark", lite: false, widgets: [] };
      profiles[r[1]].name = name.replace(/^"|"$/g, "");
      return json(res, 200, { ok: true });
    }
    if ((r = m("DELETE", /^\/api\/admin\/profiles\/([^/]+)$/))) { delete profiles[r[1]]; delete profileYaml[r[1]]; return json(res, 200, { ok: true }); }
    if (m("GET", /^\/api\/admin\/agents$/)) return json(res, 200, agentsSummary().concat([{ pcId: "office-nuc", name: "Office NUC", status: "never-seen", hasMac: false }]));
    if (m("POST", /^\/api\/admin\/agents$/)) { const b = JSON.parse((await readBody(req)) || "{}"); return json(res, 200, { pcId: b.pcId, key: [...Array(40)].map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("") }); }
    if (m("DELETE", /^\/api\/admin\/agents\/([^/]+)$/)) return json(res, 200, { ok: true });
    if (m("GET", /^\/api\/admin\/entities$/)) return json(res, 200, Object.values(ha));
    if (m("GET", /^\/api\/admin\/config$/)) { res.writeHead(200, { "Content-Type": "text/yaml" }); return res.end(config); }
    if (m("PUT", /^\/api\/admin\/config$/)) { config = await readBody(req); return json(res, 200, { ok: true }); }
    if (m("POST", /^\/api\/admin\/assistant$/)) {
      const b = JSON.parse((await readBody(req)) || "{}");
      const msgs = b.messages || [];
      const last = (msgs[msgs.length - 1] || {}).content || "";
      if (/no.?provider/i.test(last)) return json(res, 200, { messages: msgs, error: "no-provider" });
      const out = msgs.concat({ role: "assistant", content: "I can add a pc-temps widget for gaming-pc to the desk monitor at [4, 0, 5, 5], showing the hottest sensor with a 10-minute history. Want me to save that?" });
      return json(res, 200, { messages: out, pending: { callId: "call-" + seq++, tool: "save_profile", summary: "Update profile “Desk monitor”: add widget pc-temps (pc: gaming-pc) at column 5, row 1, 5×5 cells." } });
    }
    if ((r = m("POST", /^\/api\/admin\/assistant\/(approve|reject)$/))) {
      return json(res, 200, { messages: [{ role: "assistant", content: r[1] === "approve" ? "Done — the desk monitor now shows your PC temperatures." : "Okay, I left everything as it was." }] });
    }

    /* static dist (optional) */
    if (process.env.SERVE_DIST && req.method === "GET") {
      let f = path.join(DIST, decodeURIComponent(p));
      if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, "index.html");
      res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
      return fs.createReadStream(f).pipe(res);
    }
    json(res, 404, { error: "not found (mock)" });
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  const c = { ws, token: null, keys: new Set() };
  clients.add(c);
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === "hello") {
      const d = devices[msg.deviceToken];
      if (!d) return send(ws, { type: "unauthorized", reason: "This screen isn't paired." });
      c.token = msg.deviceToken;
      return send(ws, { type: "welcome", device: d, profile: profiles[d.profileId] ?? profiles["desk-monitor"] });
    }
    if (!c.token) return;
    if (msg.type === "subscribe") {
      c.keys = new Set(msg.keys || []);
      for (const k of c.keys) { const v = valueFor(k); if (v !== undefined) send(ws, { type: "state", key: k, value: v, ts: Date.now() }); }
    } else if (msg.type === "action") runAction(c, msg);
    else if (msg.type === "ping") send(ws, { type: "pong" });
  });
  ws.on("close", () => clients.delete(c));
});

setInterval(() => { if (pcOnline) publish("agent:gaming-pc:sensors", sensors()); }, 2000);
setInterval(() => publish("agent:gaming-pc:drives", drives()), 60000);
if (process.env.RING_EVERY_S) setInterval(takeover, Number(process.env.RING_EVERY_S) * 1000);

server.listen(PORT, () => console.log(`[mock] HomePanel mock server on http://localhost:${PORT}  (token "demo", admin password "demo")`));
