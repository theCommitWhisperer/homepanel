import { createHmac } from "node:crypto";
import {
  signingString,
  topics,
  type AgentActionInfo,
  type AgentCommand,
  type AgentSensor,
} from "@homepanel/protocol";
import type { AgentManager, AgentTransport } from "../agents.js";

export const DEMO_AGENT_KEYS = { "gaming-pc": "demo-gaming-pc-key", "mini-pc": "demo-mini-pc-key" } as const;

const GAMING_ACTIONS: AgentActionInfo[] = [
  { id: "open-drive-c", label: "Open C:", type: "open", icon: "💽" },
  { id: "open-drive-d", label: "Open D:", type: "open", icon: "💾" },
  { id: "open-projects", label: "Projects", type: "open", icon: "📁" },
  { id: "launch-studio", label: "Roblox Studio", type: "launch", icon: "🎮" },
  { id: "play-pause", label: "Play / Pause", type: "keys", icon: "⏯️" },
  { id: "next-track", label: "Next", type: "keys", icon: "⏭️" },
  { id: "vol-up", label: "Vol +", type: "keys", icon: "🔊" },
  { id: "vol-down", label: "Vol −", type: "keys", icon: "🔉" },
  { id: "mute-mic", label: "Mute mic", type: "keys", icon: "🎙️" },
  { id: "monitors-off", label: "Monitors off", type: "system", icon: "🖥️" },
  { id: "lock", label: "Lock", type: "system", icon: "🔒" },
  { id: "sleep", label: "Sleep", type: "system", icon: "😴", guard: "confirm" },
  { id: "restart", label: "Restart", type: "system", icon: "🔄", guard: "confirm+home-only" },
  { id: "shutdown", label: "Shut down", type: "system", icon: "⏻", guard: "confirm+home-only" },
];

const MINI_ACTIONS: AgentActionInfo[] = [
  { id: "open-media", label: "Open media", type: "open", icon: "📂" },
  { id: "restart", label: "Restart", type: "system", icon: "🔄", guard: "confirm+home-only" },
];

/** A value that wanders smoothly between bounds. */
class Wiggle {
  private v: number;
  private target: number;
  constructor(private min: number, private max: number, private step: number, start?: number) {
    this.v = start ?? (min + max) / 2;
    this.target = this.v;
  }
  next(): number {
    if (Math.abs(this.v - this.target) < this.step || Math.random() < 0.05) {
      this.target = this.min + Math.random() * (this.max - this.min);
    }
    this.v += Math.sign(this.target - this.v) * this.step * (0.4 + Math.random() * 0.6);
    this.v += (Math.random() - 0.5) * this.step * 0.5;
    this.v = Math.max(this.min, Math.min(this.max, this.v));
    return this.v;
  }
}

const r1 = (n: number) => Math.round(n * 10) / 10;

interface FakePc {
  pc: string;
  hostname: string;
  sensors: () => AgentSensor[];
  drives: { letter: string; label: string; totalGB: number; freeGB: number }[];
  actions: AgentActionInfo[];
}

function gamingPc(): FakePc {
  const load = new Wiggle(5, 85, 6, 20);
  const gpuLoad = new Wiggle(2, 95, 8, 15);
  const nv0 = new Wiggle(38, 52, 0.6, 42);
  const nv1 = new Wiggle(33, 46, 0.5, 37);
  const mb = new Wiggle(32, 40, 0.3, 35);
  const cpuName = "AMD Ryzen 7 7800X3D";
  const gpuName = "NVIDIA GeForce RTX 4070 Ti SUPER";
  return {
    pc: "gaming-pc",
    hostname: "KEVIN-PC",
    drives: [
      { letter: "C:", label: "Windows", totalGB: 931.5, freeGB: 412.3 },
      { letter: "D:", label: "Games", totalGB: 1863, freeGB: 538.9 },
      { letter: "E:", label: "Projects", totalGB: 476.9, freeGB: 301.2 },
    ],
    actions: GAMING_ACTIONS,
    sensors: () => {
      const l = load.next();
      const g = gpuLoad.next();
      const pkg = 45 + (l / 100) * 30 + (Math.random() - 0.5) * 1.5; // ~45-75 °C
      const gpu = 38 + (g / 100) * 34 + (Math.random() - 0.5);
      const cores: AgentSensor[] = Array.from({ length: 8 }, (_, i) => ({
        id: `cpu_core${i + 1}`,
        name: `CPU Core #${i + 1}`,
        kind: "temperature",
        value: r1(pkg - 4 + Math.random() * 6),
        unit: "°C",
        hardware: cpuName,
      }));
      return [
        { id: "cpu_package", name: "CPU Package", kind: "temperature", value: r1(pkg), unit: "°C", hardware: cpuName },
        ...cores,
        { id: "gpu_core", name: "GPU Core", kind: "temperature", value: r1(gpu), unit: "°C", hardware: gpuName },
        { id: "gpu_hotspot", name: "GPU Hotspot", kind: "temperature", value: r1(gpu + 9 + Math.random() * 3), unit: "°C", hardware: gpuName },
        { id: "nvme0_temp", name: "NVMe0 (Samsung 990 Pro)", kind: "temperature", value: r1(nv0.next()), unit: "°C", hardware: "Samsung SSD 990 PRO 1TB" },
        { id: "nvme1_temp", name: "NVMe1 (WD SN850X)", kind: "temperature", value: r1(nv1.next()), unit: "°C", hardware: "WD_BLACK SN850X 2TB" },
        { id: "motherboard", name: "Motherboard", kind: "temperature", value: r1(mb.next()), unit: "°C", hardware: "MSI MAG B650 TOMAHAWK" },
        { id: "cpu_load", name: "CPU Load", kind: "load", value: r1(l), unit: "%", hardware: cpuName },
        { id: "gpu_load", name: "GPU Load", kind: "load", value: r1(g), unit: "%", hardware: gpuName },
        { id: "ram_load", name: "Memory Used", kind: "load", value: r1(38 + l * 0.2), unit: "%" },
        { id: "cpu_fan", name: "CPU Fan", kind: "fan", value: Math.round(700 + l * 9 + Math.random() * 30), unit: "RPM" },
        { id: "gpu_fan", name: "GPU Fan", kind: "fan", value: g < 25 ? 0 : Math.round(900 + g * 12 + Math.random() * 40), unit: "RPM", hardware: gpuName },
        { id: "case_fan1", name: "Case Fan 1", kind: "fan", value: Math.round(800 + l * 4 + Math.random() * 20), unit: "RPM" },
        { id: "cpu_power", name: "CPU Package Power", kind: "power", value: r1(28 + l * 0.9), unit: "W", hardware: cpuName },
        { id: "gpu_power", name: "GPU Power", kind: "power", value: r1(18 + g * 2.6), unit: "W", hardware: gpuName },
      ];
    },
  };
}

function miniPc(): FakePc {
  const load = new Wiggle(3, 45, 4, 12);
  const nv = new Wiggle(36, 48, 0.5, 40);
  const cpuName = "Intel N100";
  return {
    pc: "mini-pc",
    hostname: "T8-PLUS",
    drives: [{ letter: "/", label: "root", totalGB: 476.9, freeGB: 388.4 }],
    actions: MINI_ACTIONS,
    sensors: () => {
      const l = load.next();
      const pkg = 40 + l * 0.45 + (Math.random() - 0.5);
      return [
        { id: "cpu_package", name: "CPU Package", kind: "temperature", value: r1(pkg), unit: "°C", hardware: cpuName },
        { id: "nvme0_temp", name: "NVMe0", kind: "temperature", value: r1(nv.next()), unit: "°C" },
        { id: "cpu_load", name: "CPU Load", kind: "load", value: r1(l), unit: "%", hardware: cpuName },
        { id: "ram_load", name: "Memory Used", kind: "load", value: r1(52 + l * 0.1), unit: "%" },
        { id: "cpu_power", name: "CPU Package Power", kind: "power", value: r1(3 + l * 0.12), unit: "W", hardware: cpuName },
      ];
    },
  };
}

/**
 * In-process stand-in for MQTT + two PC agents. It feeds payloads to the AgentManager
 * exactly as MQTT would, and answers signed commands after 300 ms (verifying the HMAC).
 */
export class DemoAgentTransport implements AgentTransport {
  readonly status = "demo" as const;
  private pcs: FakePc[] = [gamingPc(), miniPc()];
  private timers: NodeJS.Timeout[] = [];

  constructor(private manager: AgentManager, private intervalMs = 2000) {}

  private emit(topic: string, obj: unknown) {
    this.manager.handleMessage(topic, Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)));
  }

  start() {
    for (const p of this.pcs) {
      this.emit(topics.status(p.pc), "online");
      this.emit(topics.actions(p.pc), { pc: p.pc, actions: p.actions });
      this.emit(topics.drives(p.pc), { ts: Date.now(), pc: p.pc, drives: p.drives });
      this.tick(p);
    }
    const iv = setInterval(() => this.pcs.forEach((p) => this.tick(p)), this.intervalMs);
    iv.unref?.();
    this.timers.push(iv);
    const dv = setInterval(() => {
      for (const p of this.pcs) {
        for (const d of p.drives) d.freeGB = r1(Math.max(1, d.freeGB + (Math.random() - 0.55) * 0.4));
        this.emit(topics.drives(p.pc), { ts: Date.now(), pc: p.pc, drives: p.drives });
      }
    }, 60_000);
    dv.unref?.();
    this.timers.push(dv);
  }

  private tick(p: FakePc) {
    this.emit(topics.sensors(p.pc), { ts: Date.now(), pc: p.pc, hostname: p.hostname, sensors: p.sensors() });
  }

  publish(topic: string, payload: string) {
    const m = /^homepanel\/agent\/([^/]+)\/cmd$/.exec(topic);
    if (!m) return;
    const pc = m[1]!;
    let cmd: AgentCommand;
    try {
      cmd = JSON.parse(payload);
    } catch {
      return;
    }
    const key = (DEMO_AGENT_KEYS as Record<string, string>)[pc];
    const expected = key ? createHmac("sha256", key).update(signingString(cmd)).digest("hex") : "";
    const fake = this.pcs.find((x) => x.pc === pc);
    const ok = !!fake && cmd.sig === expected && fake.actions.some((a) => a.id === cmd.action);
    const t = setTimeout(() => {
      this.emit(topics.cmdResult(pc), ok ? { id: cmd.id, ok: true } : { id: cmd.id, ok: false, error: cmd.sig === expected ? "unknown-action" : "bad-signature" });
    }, 300);
    this.timers.push(t);
  }

  stop() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }
}
