import type { HostType } from "../state.js";
import { detectStep } from "./detect.js";
import { doorbellStep, remoteStep, screensStep, zigbeeStep } from "./extras.js";
import { hostStep } from "./host.js";
import { mqttStep } from "./mqtt.js";
import { onboardStep, tokenStep } from "./onboard.js";
import { pcsStep } from "./pcs.js";
import { serverStep } from "./server.js";
import type { Step } from "./types.js";

export const ALL_STEPS: Step[] = [
  detectStep,
  hostStep,
  onboardStep,
  tokenStep,
  mqttStep,
  serverStep,
  zigbeeStep,
  doorbellStep,
  remoteStep,
  screensStep,
  pcsStep,
];

export const STEP_IDS = ALL_STEPS.map((s) => s.id);

export function getStep(id: string): Step | undefined {
  return ALL_STEPS.find((s) => s.id === id);
}

/** Ordered steps for a host type. */
export function stepsFor(host: HostType | undefined): Step[] {
  const ids = (() => {
    switch (host) {
      case "linux-docker":
        // the installer creates HA on this machine, so there is nothing to discover first
        return ["host", "onboard", "token", "mqtt", "server", "zigbee", "doorbells", "remote", "screens", "pcs"];
      case "vm-windows":
      case "nas-proxmox":
      case "x86-bare-metal":
      case "raspberry-pi":
      case "ha-green":
        return ["detect", "host", "onboard", "token", "mqtt", "server", "zigbee", "doorbells", "remote", "screens", "pcs"];
      default:
        return STEP_IDS;
    }
  })();
  return ids.map((id) => getStep(id)!);
}

/** Steps that change something (need approval in AI mode). */
export const READ_ONLY_STEPS = new Set(["detect", "screens"]);

export type { Step, StepContext } from "./types.js";
