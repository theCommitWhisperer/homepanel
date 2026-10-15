import { parseCidr, pickPrimary, type NetIface } from "../steps/static-ip.js";
import { setHaAddress } from "../ha/address.js";
/** The real probes behind the system check (read-only; short timeouts everywhere). */
import { request as httpsRequest } from "node:https";
import { release } from "node:os";
import { findHomeAssistant } from "../ha/discover.js";
import { HaClient, HaSocket } from "../ha/client.js";
import { ServerApi } from "../local/api.js";
import { defaultPaths, LHM_URL, primaryInterface, type LocalPaths } from "../local/flow.js";
import { defaultOps, type WinOps } from "../local/ops.js";
import { powershellArgs } from "../local/ps.js";
import { tcpProbe } from "../proxmox/setup.js";
import { SERVER_PORT } from "../constants.js";
import { StateStore } from "../state.js";
import { hostname } from "node:os";
import { join } from "node:path";
import type { HaDetails, LanScan, PrecheckEnv } from "./types.js";

/** Count sensor leaves (nodes with a Value and no children) in LibreHardwareMonitor's data.json. */
export function countLhmSensors(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as { Children?: unknown[]; Value?: unknown };
  const kids = Array.isArray(n.Children) ? n.Children : [];
  if (!kids.length) return typeof n.Value === "string" && n.Value.trim() !== "" ? 1 : 0;
  return kids.reduce<number>((a, c) => a + countLhmSensors(c), 0);
}

/** Windows 11 = build 22000+. */
export function windowsName(rel: string): { name: string; build?: number } {
  const m = /^10\.0\.(\d+)/.exec(rel);
  if (!m) return { name: `Windows ${rel}` };
  const build = Number(m[1]);
  return { name: build >= 22000 ? "Windows 11" : "Windows 10", build };
}

/** Does https://host:8006 look like a Proxmox web UI? (self-signed certificate; only reading the page) */
function looksLikeProxmox(host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpsRequest({ host, port: 8006, path: "/", method: "GET", rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let body = "";
      const server = String(res.headers.server ?? "");
      res.setEncoding("utf8");
      res.on("data", (d: string) => {
        body += d;
        if (body.length > 20_000) res.destroy();
      });
      const done = () => resolve(/pve|proxmox/i.test(server) || /proxmox/i.test(body));
      res.on("end", done);
      res.on("close", done);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Parallel /24 scan: TCP 8006 (Proxmox) and 8080 (HomePanel), 300 ms connect timeouts. */
export async function scanLan(
  ip: string,
  o: { probe?: (h: string, port: number, ms: number) => Promise<boolean>; health?: (url: string) => Promise<boolean>; isProxmox?: (h: string) => Promise<boolean> } = {},
): Promise<LanScan> {
  const probe = o.probe ?? tcpProbe;
  const base = ip.split(".").slice(0, 3).join(".");
  const hosts = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`).filter((h) => h !== ip);
  const pve: string[] = [];
  const hp: string[] = [];
  await Promise.all(
    hosts.map(async (h) => {
      const [a, b] = await Promise.all([probe(h, 8006, 300), probe(h, SERVER_PORT, 300)]);
      if (a) pve.push(h);
      if (b) hp.push(h);
    }),
  );
  const isPve = o.isProxmox ?? ((h: string) => looksLikeProxmox(h, 1500));
  const health =
    o.health ??
    (async (u: string) => {
      const r = await new ServerApi(u, globalThis.fetch).health(1500);
      return r?.ok !== undefined;
    });
  const sortIp = (a: string, b: string) => Number(a.split(".")[3]) - Number(b.split(".")[3]);
  const proxmox = (await Promise.all(pve.map(async (h) => ((await isPve(h)) ? h : undefined)))).filter((h): h is string => !!h).sort(sortIp);
  const homepanel = (await Promise.all(hp.sort(sortIp).map(async (h) => ((await health(`http://${h}:${SERVER_PORT}`)) ? `http://${h}:${SERVER_PORT}` : undefined)))).filter(
    (u): u is string => !!u,
  );
  return { proxmox, homepanel };
}

/** One WebSocket session: version, HA OS?, installed apps, ZHA. */
export async function haDetails(url: string, token: string): Promise<HaDetails> {
  const s = await HaSocket.connect(url, token, 6000);
  try {
    const cfg = await s.getConfig().catch(() => undefined);
    const haOs = Array.isArray(cfg?.components) ? cfg!.components.includes("hassio") : false;
    let addons: HaDetails["addons"];
    let error: string | undefined;
    if (haOs) {
      try {
        const r = await s.supervisor<{ addons?: { slug: string; state: string; version?: string }[] }>("/addons", "get", undefined, 10);
        addons = (r?.addons ?? []).map((a) => ({ slug: a.slug, state: a.state, version: a.version }));
      } catch (e) {
        error = (e as Error).message;
      }
    }
    let ip: HaDetails["ip"];
    if (haOs) {
      try {
        const net = await s.supervisor<{ interfaces?: NetIface[] }>("/network/info", "get", undefined, 10);
        const nic = pickPrimary(net?.interfaces ?? []);
        if (nic) {
          const m = nic.ipv4?.method;
          ip = { method: m === "static" ? "static" : m === "auto" || m === "dhcp" ? "dhcp" : "other", address: parseCidr(nic.ipv4?.address?.[0])?.ip, iface: nic.interface };
        }
      } catch {
        /* keep unknown */
      }
    }
    let zha: HaDetails["zha"] = "unknown";
    try {
      const entries = await s.configEntries("zha");
      if (entries.length) zha = "loaded";
      else {
        const flows = await new HaClient(url, { token }).flowsInProgress().catch(() => []);
        zha = flows.some((f) => f.handler === "zha") ? "discovered" : "none";
      }
    } catch {
      /* keep unknown */
    }
    return { version: (cfg?.version as string | undefined) ?? s.haVersion, haOs, ...(addons ? { addons } : {}), zha, ...(ip ? { ip } : {}), ...(error ? { error } : {}) };
  } finally {
    s.close();
  }
}

/** Retained agent status over MQTT (only used when no admin password is saved). */
export async function mqttAgentStatus(url: string, username: string, password: string, pcId: string, waitMs = 1500): Promise<"online" | "offline" | undefined> {
  const mqtt = await import("mqtt");
  const client = await mqtt.connectAsync(url, { username, password, connectTimeout: 3000, reconnectPeriod: 0 });
  try {
    const topic = `homepanel/agent/${pcId}/status`;
    const got = new Promise<"online" | "offline" | undefined>((resolve) => {
      const t = setTimeout(() => resolve(undefined), waitMs);
      client.on("message", (tp, payload) => {
        if (tp !== topic) return;
        clearTimeout(t);
        const v = payload.toString().trim();
        resolve(v === "online" ? "online" : "offline");
      });
    });
    await client.subscribeAsync(topic);
    return await got;
  } finally {
    await client.endAsync().catch(() => undefined);
  }
}

export function realPrecheckEnv(o: { ops?: WinOps; paths?: LocalPaths; fetchImpl?: typeof fetch; haHome?: string } = {}): PrecheckEnv {
  const ops = o.ops ?? defaultOps();
  const paths = o.paths ?? defaultPaths(ops.platform);
  const f = o.fetchImpl ?? globalThis.fetch;
  const win = ops.platform === "win32";
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return {
    platform: ops.platform,
    async osInfo() {
      if (win) return windowsName(release());
      return { name: `${process.platform} ${release()}` };
    },
    isElevated: () => ops.isElevated(),
    async wingetPresent() {
      const r = await ops.run("winget", ["--version"], { timeoutMs: 8000 });
      return r.code === 0;
    },
    net: () => ({ ...primaryInterface(), hostname: hostname() }),
    networkCategory: () => ops.networkCategory(),
    async internet() {
      for (const u of ["https://api.github.com/", "https://www.msftconnecttest.com/connecttest.txt"]) {
        try {
          const r = await f(u, { method: "HEAD", signal: AbortSignal.timeout(4000) });
          if (r.status < 500) return true;
        } catch {
          /* next */
        }
      }
      return false;
    },
    localSaved() {
      const s = new StateStore(paths.setupDir);
      return { state: s.state, secrets: s.secrets };
    },
    haSaved() {
      const s = new StateStore(o.haHome);
      return { state: s.state, secrets: s.secrets };
    },
    rememberHa(url) {
      setHaAddress(new StateStore(o.haHome), url);
    },
    async findHa(extra) {
      const r = await findHomeAssistant({ extra, mdnsMs: 2500, fetchImpl: f });
      return r.map((x) => ({ url: x.url, status: x.status ?? "unreachable", ...(x.name ? { name: x.name } : {}), ...(x.version ? { version: x.version } : {}) }));
    },
    haPreparingProgress: (url) => new HaClient(url, { fetchImpl: f }).preparingProgress(),
    haTokenValid: (url, token) => new HaClient(url, { token, fetchImpl: f }).apiOk(),
    haDetails,
    serverHealth: (url) => new ServerApi(url, f).health(3000),
    async agentStatusAdmin(serverUrl, pw, pcId) {
      const a = new ServerApi(serverUrl, f);
      try {
        await a.login(pw);
      } catch {
        return undefined;
      }
      const list = await a.agents();
      const me = list.find((x) => x.pcId === pcId);
      return me ? me.status : "unregistered";
    },
    agentStatusMqtt: (url, user, pass, pcId) => mqttAgentStatus(url, user, pass, pcId),
    taskInfo: (n) => ops.taskInfo(n),
    serviceInfo: (n) => ops.serviceInfo(n),
    async lhm() {
      try {
        const r = await f(LHM_URL, { signal: AbortSignal.timeout(2500) });
        if (!r.ok) return { ok: false, count: 0 };
        return { ok: true, count: countLhmSensors(await r.json()) };
      } catch {
        return { ok: false, count: 0 };
      }
    },
    async usbZbt1() {
      if (!win) return undefined;
      const script =
        "$d = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_10C4&PID_EA60' -and ($_.FriendlyName -match 'ZBT|SkyConnect|Zigbee' -or $_.InstanceId -match 'ZBT|SKYCONNECT') }\n" +
        "if ($d) { 'yes' } else { 'no' }";
      const r = await ops.run(powershell, powershellArgs(script), { timeoutMs: 8000 });
      if (r.code !== 0) return undefined;
      return r.stdout.trim() === "yes";
    },
    scanLan: (ip) => scanLan(ip),
  };
}
