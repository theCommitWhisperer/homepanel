import fs from "node:fs";
import path from "node:path";
import type { AgentManager } from "../mqtt/agents.js";
import type { DeviceStore } from "../devices.js";
import { DATA_EXAMPLE_DIR } from "../config.js";
import { copyDirMissing } from "../store.js";
import { DEMO_AGENT_KEYS } from "./fakeAgents.js";

const MARKER = ".homepanel-demo";

/**
 * Wipe DATA_DIR and fill it with the examples plus demo-only config.
 * Refuses to wipe a non-empty folder that wasn't created by demo mode (protects real data).
 */
export function prepareDemoDataDir(dataDir: string) {
  if (fs.existsSync(dataDir)) {
    const entries = fs.readdirSync(dataDir);
    if (entries.length && !entries.includes(MARKER)) {
      throw new Error(`DEMO refuses to wipe ${dataDir}: it is not a demo data dir. Point DATA_DIR at an empty folder.`);
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, MARKER), "created by HomePanel demo mode; wiped on every demo start\n");
  copyDirMissing(DATA_EXAMPLE_DIR, dataDir);
}

export const DEMO_DEVICES = [
  { token: "demo", id: "demo-desk", name: "Desk monitor (demo)", profileId: "desk-monitor" },
  { token: "ipad", id: "demo-ipad", name: "Kitchen iPad (demo)", profileId: "kitchen-ipad" },
  { token: "fire", id: "demo-fire", name: "Fire HD 8 (demo)", profileId: "fire-hd8" },
];

export function seedDemo(devices: DeviceStore, agents: AgentManager) {
  for (const d of DEMO_DEVICES) devices.add(d.name, d.profileId, d.token, d.id);
  agents.register("gaming-pc", "Gaming PC", "D8:5E:D3:12:34:56", DEMO_AGENT_KEYS["gaming-pc"]);
}
