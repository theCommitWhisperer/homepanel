import { createHmac } from "node:crypto";
import {
  signingString,
  topics,
  type AgentActionInfo,
  type AgentCommand,
  type AgentSensor,
} from "@homepanel/protocol";
import type { AgentManager, AgentTransport } from "../mqtt/agents.js";

export const DEMO_AGENT_KEYS = { "gaming-pc": "demo-gaming-pc-key" } as const;

const GAMING_ACTIONS: AgentActionInfo[] = [
  { id: "open-drive-c", label: "C: drive", type: "open", icon: "drive" },
  { id: "open-drive-d", label: "D: drive", type: "open", icon: "drive" },
  { id: "open-downloads", label: "Downloads", type: "open", icon: "folder" },
  { id: "open-projects", label: "Projects", type: "open", icon: "folder" },
  { id: "launch-studio", label: "Roblox Studio", type: "launch", icon: "🎮" },
  { id: "launch-steam", label: "Steam", type: "launch", icon: "steam" },
  { id: "launch-discord", label: "Discord", type: "launch", icon: "💬" },
  { id: "media-playpause", label: "Play / Pause", type: "keys", icon: "⏯️" },
  { id: "media-next", label: "Next track", type: "keys", icon: "⏭️" },
  { id: "vol-up", label: "Vol +", type: "keys", icon: "🔊" },
  { id: "vol-down", label: "Vol −", type: "keys", icon: "🔉" },
  { id: "mute-mic", label: "Mute mic", type: "keys", icon: "🎙️" },
  { id: "audio-speakers", label: "Speakers", type: "script", icon: "🔈" },
  { id: "audio-headphones", label: "Headphones", type: "script", icon: "🎧" },
  { id: "monitors-off", label: "Screens off", type: "system", icon: "monitor" },
  { id: "lock", label: "Lock", type: "system", icon: "lock" },
  { id: "sleep", label: "Sleep", type: "system", icon: "moon", guard: "confirm" },
  { id: "restart", label: "Restart", type: "system", icon: "restart", guard: "confirm+home-only" },
  { id: "shutdown", label: "Shut down", type: "system", icon: "power", guard: "confirm+home-only" },
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
  const load = new Wiggle(4, 85, 6, 18);
  const gpuLoad = new Wiggle(1, 97, 8, 12);
  const nv0 = new Wiggle(38, 54, 0.6, 43);
  const nv1 = new Wiggle(33, 47, 0.5, 37);
  const cpuName = "AMD Ryzen 7 7800X3D";
  const gpuName = "NVIDIA GeForce RTX 4070 Ti SUPER";
  // thermal mass: temperatures chase a load-dependent target instead of jumping
  let pkg = 50;
  let gpu = 42;
  const chase = (cur: number, target: number, k: number) => cur + (target - cur) * k + (Math.random() - 0.5) * 0.6;
  const fan = (base: number, per: number, x: number) => Math.round(base + x * per + (Math.random() - 0.5) * 30);
  return {
    pc: "gaming-pc",
    hostname: "GAMING-PC",
    drives: [
      { letter: "C:", label: "Windows", totalGB: 931.5, freeGB: 402.7 },
      { letter: "D:", label: "Games", totalGB: 1863, freeGB: 512.4 },
      { letter: "E:", label: "Storage", totalGB: 3726, freeGB: 2210.9 },
    ],
    actions: GAMING_ACTIONS,
    sensors: () => {
      const l = load.next();
      const g = gpuLoad.next();
      pkg = chase(pkg, 44 + l * 0.36, 0.35); // ~44-75 °C
      gpu = chase(gpu, 36 + g * 0.36, 0.3); // ~36-71 °C
      return [
        { id: "cpu_package", name: "CPU Package", kind: "temperature", value: r1(pkg), unit: "°C", hardware: cpuName },
        { id: "cpu_core_max", name: "CPU Hottest Core", kind: "temperature", value: r1(pkg + 3 + Math.random() * 4), unit: "°C", hardware: cpuName },
        { id: "gpu_core", name: "GPU Core", kind: "temperature", value: r1(gpu), unit: "°C", hardware: gpuName },
        { id: "gpu_hotspot", name: "GPU Hotspot", kind: "temperature", value: r1(gpu + 10 + Math.random() * 3), unit: "°C", hardware: gpuName },
        { id: "gpu_memory_junction", name: "GPU VRAM", kind: "temperature", value: r1(gpu + 6 + Math.random() * 2), unit: "°C", hardware: gpuName },
        { id: "nvme0_temp", name: "NVMe0 (990 Pro)", kind: "temperature", value: r1(nv0.next()), unit: "°C", hardware: "Samsung SSD 990 PRO 1TB" },
        { id: "nvme1_temp", name: "NVMe1 (SN850X)", kind: "temperature", value: r1(nv1.next()), unit: "°C", hardware: "WD_BLACK SN850X 2TB" },
        { id: "cpu_load_total", name: "CPU Load", kind: "load", value: r1(l), unit: "%", hardware: cpuName },
        { id: "gpu_load_core", name: "GPU Load", kind: "load", value: r1(g), unit: "%", hardware: gpuName },
        { id: "cpu_fan", name: "CPU Fan", kind: "fan", value: fan(650, 9, l), unit: "RPM" },
        { id: "gpu_fan", name: "GPU Fan", kind: "fan", value: g < 25 ? 0 : fan(900, 12, g), unit: "RPM", hardware: gpuName },
        { id: "case_fan", name: "Case Fan", kind: "fan", value: fan(750, 4, Math.max(l, g)), unit: "RPM" },
      ];
    },
  };
}

/**
 * In-process stand-in for MQTT + the demo PC agent. It feeds payloads to the AgentManager
 * exactly as MQTT would, and answers signed commands after 300 ms (verifying the HMAC).
 */
export class DemoAgentTransport implements AgentTransport {
  readonly status = "demo" as const;
  private pcs: FakePc[] = [gamingPc()];
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
