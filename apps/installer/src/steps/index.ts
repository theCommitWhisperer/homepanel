import type { HostType } from "../state.js";
import { detectStep } from "./detect.js";
import { doorbellStep, remoteStep, screensStep, zigbeeStep } from "./extras.js";
import { envStep, healthStep } from "./finish.js";
import { hostStep } from "./host.js";
import { mqttStep } from "./mqtt.js";
import { onboardStep, tokenStep } from "./onboard.js";
import { pcsStep } from "./pcs.js";
import { serverStep } from "./server.js";
import { staticIpStep } from "./static-ip.js";
import type { Step } from "./types.js";

export const ALL_STEPS: Step[] = [
  detectStep,
  hostStep,
  onboardStep,
  tokenStep,
  staticIpStep,
  mqttStep,
  serverStep,
  envStep,
  zigbeeStep,
  doorbellStep,
  remoteStep,
  screensStep,
  pcsStep,
  healthStep,
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
        return ["host", "onboard", "token", "staticip", "mqtt", "server", "zigbee", "doorbells", "remote", "screens", "pcs", "health"];
      case "vm-windows":
      case "nas-proxmox":
      case "proxmox":
      case "x86-bare-metal":
      case "raspberry-pi":
      case "ha-green":
        return ["detect", "host", "onboard", "token", "staticip", "mqtt", "server", "env", "zigbee", "doorbells", "remote", "screens", "pcs", "health"];
      default:
        return STEP_IDS;
    }
  })();
  return ids.map((id) => getStep(id)!);
}

/** Steps that change something (need approval in AI mode). */
export const READ_ONLY_STEPS = new Set(["detect", "screens", "health"]);

export type { Step, StepContext } from "./types.js";
