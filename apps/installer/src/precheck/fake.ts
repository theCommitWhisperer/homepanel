/**
 * Fake worlds for the system check: unit tests and the `--fake` demo (HomePanel.exe ui --fake=<name>).
 * Each scenario is a plain description; fakePrecheckEnv turns it into a PrecheckEnv.
 */
import type { SecretsFile, SetupState } from "../state.js";
import type { FoundHa, HaDetails, LanScan, PrecheckEnv } from "./types.js";

export interface FakeScenario {
  platform?: NodeJS.Platform;
  os?: { name: string; build?: number };
  elevated?: boolean;
  winget?: boolean;
  net?: { ip?: string; mac?: string; hostname: string };
  category?: string;
  internet?: boolean;
  local?: { state?: Partial<SetupState>; secrets?: SecretsFile };
  ha?: { state?: Partial<SetupState>; secrets?: SecretsFile };
  /** what findHa answers */
  found?: FoundHa[];
  preparing?: string;
  /** tokens Home Assistant accepts */
  validTokens?: string[];
  details?: HaDetails;
  /** server URL → health */
  servers?: Record<string, { ok: boolean; version?: string; mqtt?: string; ha?: string }>;
  agents?: Record<string, "online" | "offline" | "never-seen">;
  mqttStatus?: "online" | "offline";
  tasks?: Record<string, string>;
  services?: Record<string, boolean>;
  lhm?: { ok: boolean; count: number };
  usbZbt1?: boolean;
  lan?: LanScan;
  /** artificial latency per probe (demo) */
  delayMs?: number;
}

const st = (s?: Partial<SetupState>): SetupState => ({ version: 1, steps: {}, ...(s ?? {}) }) as SetupState;

export function fakePrecheckEnv(s: FakeScenario): PrecheckEnv {
  const wait = async <T>(v: T, factor = 1): Promise<T> => {
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs! * factor * (0.5 + Math.random())));
    return v;
  };
  return {
    platform: s.platform ?? "win32",
    osInfo: () => wait(s.os ?? { name: "Windows 11", build: 26100 }),
    isElevated: () => wait(s.elevated ?? true),
    wingetPresent: () => wait(s.winget ?? true),
    net: () => s.net ?? { ip: "192.168.1.50", mac: "AA:BB:CC:DD:EE:FF", hostname: "GAMING-PC" },
    networkCategory: () => wait(s.category ?? "Private"),
    internet: () => wait(s.internet ?? true, 2),
    localSaved: () => ({ state: st(s.local?.state), secrets: s.local?.secrets ?? {} }),
    haSaved: () => ({ state: st(s.ha?.state), secrets: s.ha?.secrets ?? {} }),
    findHa: () => wait(s.found ?? [], 6),
    haPreparingProgress: () => wait(s.preparing),
    haTokenValid: (_u, t) => wait((s.validTokens ?? []).includes(t), 2),
    async haDetails() {
      if (!s.details) throw new Error("no details");
      return wait(s.details, 3);
    },
    serverHealth: (url) => wait(s.servers?.[url.replace(/\/+$/, "")], 2),
    agentStatusAdmin: (_u, _p, pcId) => wait(s.agents ? (s.agents[pcId] ?? "unregistered") : undefined, 2),
    agentStatusMqtt: () => wait(s.mqttStatus, 2),
    taskInfo: (n) => wait(s.tasks?.[n] ? { exists: true, state: s.tasks[n] } : { exists: false }),
    serviceInfo: (n) => wait(s.services && n in s.services ? { exists: true, running: s.services[n]!, env: [] } : { exists: false, running: false, env: [] }),
    lhm: () => wait(s.lhm ?? { ok: false, count: 0 }),
    usbZbt1: () => wait(s.usbZbt1),
    scanLan: () => wait(s.lan ?? { proxmox: [], homepanel: [] }, 8),
  };
}

const KEVIN_TOKEN = "eyJhbGciOiJIUzI1NiJ9.kevin.token";
const PC = { ip: "192.168.1.50", mac: "AA:BB:CC:DD:EE:FF", hostname: "GAMING-PC" };
const HOST_TASKS = { "HomePanel Server": "Running", "HomePanel Agent": "Running", "HomePanel Sensors": "Running" };
const HOST_LOCAL = {
  state: {
    local: { mode: "host" as const, serverUrl: "http://127.0.0.1:8080", mqttHost: "127.0.0.1", mqttUser: "homepanel", pcId: "gaming-pc", pcName: "Gaming PC" },
    steps: { "host.server": { status: "done" as const, at: "2026-10-01T10:00:00Z" }, "host.agent": { status: "done" as const, at: "2026-10-01T10:00:00Z" } },
  },
  secrets: { adminPassword: "admin-pw-123", mqttPassword: "mqtt-pw-123", agentKey: "k".repeat(32) },
};

/** Named scenarios (also selectable with `--fake=<name>`). */
export const SCENARIOS: Record<string, FakeScenario> = {
  /** Kevin today: Host on this PC; HA OS on Proxmox at 192.168.1.81 port 80, onboarded, token pasted; no Mosquitto / HomePanel app yet; ZBT-1 passed through. */
  kevin: {
    net: PC,
    local: HOST_LOCAL,
    ha: {
      state: { haUrl: "http://192.168.1.81", host: "192.168.1.81", haOs: true, hostType: "proxmox", serverUrl: "http://192.168.1.81:8080", proxmox: { host: "192.168.1.251" }, steps: { detect: { status: "done", at: "x" }, onboard: { status: "done", at: "x" }, token: { status: "done", at: "x" } } },
      secrets: { haToken: KEVIN_TOKEN },
    },
    found: [
      { url: "http://192.168.1.81", status: "onboarded", name: "Home" },
      { url: "http://192.168.1.81:8123", status: "unreachable" },
    ],
    validTokens: [KEVIN_TOKEN],
    details: { version: "2026.10.1", haOs: true, addons: [{ slug: "core_ssh", state: "started" }], zha: "discovered" },
    servers: { "http://127.0.0.1:8080": { ok: true, version: "0.3.0", mqtt: "connected", ha: "disconnected" } },
    agents: { "gaming-pc": "online" },
    tasks: HOST_TASKS,
    services: { mosquitto: true },
    lhm: { ok: true, count: 142 },
    lan: { proxmox: ["192.168.1.251"], homepanel: [] },
  },
  /** A brand-new PC on a network with nothing on it. */
  fresh: {
    net: { ...PC, hostname: "NEW-PC" },
    lhm: { ok: false, count: 0 },
  },
  /** Nothing found, but a Proxmox host answers. */
  proxmox: {
    net: { ...PC, hostname: "NEW-PC" },
    lan: { proxmox: ["192.168.1.251"], homepanel: [] },
  },
  /** Home Assistant OS still downloading Core on first boot. */
  preparing: {
    net: PC,
    ha: { state: { haUrl: "http://192.168.1.81", host: "192.168.1.81", hostType: "proxmox" } },
    found: [{ url: "http://192.168.1.81", status: "preparing" }],
    preparing: "home_assistant_core_install 40%",
    lan: { proxmox: ["192.168.1.251"], homepanel: [] },
  },
  /** Saved Home Assistant address doesn't answer (VM off). */
  "ha-down": {
    net: PC,
    local: HOST_LOCAL,
    ha: { state: { haUrl: "http://192.168.1.81", host: "192.168.1.81", haOs: true }, secrets: { haToken: KEVIN_TOKEN } },
    found: [],
    servers: { "http://127.0.0.1:8080": { ok: true, version: "0.3.0" } },
    agents: { "gaming-pc": "online" },
    tasks: HOST_TASKS,
    services: { mosquitto: true },
    lhm: { ok: true, count: 142 },
  },
  /** The saved token was revoked. */
  "token-expired": {
    net: PC,
    ha: { state: { haUrl: "http://192.168.1.81", host: "192.168.1.81", haOs: true }, secrets: { haToken: "old.revoked.token" } },
    found: [{ url: "http://192.168.1.81", status: "onboarded" }],
    validTokens: [KEVIN_TOKEN],
  },
  /** Everything moved to Home Assistant; this PC reports there. */
  done: {
    net: PC,
    local: {
      state: { local: { mode: "join", serverUrl: "http://192.168.1.81:8080", mqttHost: "192.168.1.81", mqttUser: "homepanel", pcId: "gaming-pc", movedFrom: "http://127.0.0.1:8080" } },
      secrets: { adminPassword: "ha-admin", mqttPassword: "ha-mqtt", agentKey: "k".repeat(32) },
    },
    ha: { state: { haUrl: "http://192.168.1.81", host: "192.168.1.81", haOs: true, serverUrl: "http://192.168.1.81:8080" }, secrets: { haToken: KEVIN_TOKEN } },
    found: [{ url: "http://192.168.1.81", status: "onboarded" }],
    validTokens: [KEVIN_TOKEN],
    details: {
      version: "2026.10.1",
      haOs: true,
      addons: [
        { slug: "core_mosquitto", state: "started" },
        { slug: "5c53de3b_homepanel", state: "started" },
      ],
      zha: "loaded",
    },
    servers: { "http://192.168.1.81:8080": { ok: true, version: "0.3.0", mqtt: "connected", ha: "connected" } },
    agents: { "gaming-pc": "online" },
    tasks: { "HomePanel Agent": "Running", "HomePanel Sensors": "Running", "HomePanel Tray": "Running" },
    lhm: { ok: true, count: 142 },
    lan: { proxmox: ["192.168.1.251"], homepanel: ["http://192.168.1.81:8080"] },
  },
  /** A second PC: nothing local, HomePanel already runs on Home Assistant (no token on this PC). */
  "second-pc": {
    net: { ip: "192.168.1.60", hostname: "OFFICE-PC" },
    found: [{ url: "http://192.168.1.81", status: "onboarded" }],
    servers: { "http://192.168.1.81:8080": { ok: true, version: "0.3.0", mqtt: "connected", ha: "connected" } },
    lan: { proxmox: [], homepanel: ["http://192.168.1.81:8080", "http://192.168.1.50:8080"] },
  },
  /** Kevin after installing both apps: time to move. */
  "ready-to-move": {
    net: PC,
    local: HOST_LOCAL,
    ha: { state: { haUrl: "http://192.168.1.81", host: "192.168.1.81", haOs: true, serverUrl: "http://192.168.1.81:8080" }, secrets: { haToken: KEVIN_TOKEN } },
    found: [{ url: "http://192.168.1.81", status: "onboarded" }],
    validTokens: [KEVIN_TOKEN],
    details: {
      version: "2026.10.1",
      haOs: true,
      addons: [
        { slug: "core_mosquitto", state: "started" },
        { slug: "5c53de3b_homepanel", state: "started" },
      ],
      zha: "loaded",
    },
    servers: { "http://127.0.0.1:8080": { ok: true }, "http://192.168.1.81:8080": { ok: true, version: "0.3.0" } },
    agents: { "gaming-pc": "online" },
    tasks: HOST_TASKS,
    services: { mosquitto: true },
    lhm: { ok: true, count: 142 },
  },
  /** Host mode, but the agent dropped offline and LHM is closed; Public network. */
  "host-broken": {
    net: PC,
    category: "Public",
    local: HOST_LOCAL,
    servers: { "http://127.0.0.1:8080": { ok: true, version: "0.3.0" } },
    agents: { "gaming-pc": "offline" },
    tasks: { "HomePanel Server": "Running", "HomePanel Agent": "Ready", "HomePanel Sensors": "Ready" },
    services: { mosquitto: true },
    lhm: { ok: false, count: 0 },
  },
};
