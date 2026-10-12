import type { AgentConfig } from "../config.js";
import { HwmonSource } from "./hwmon.js";
import { LhmSource } from "./lhm.js";
import { MockSource } from "./mock.js";
import type { SensorSource } from "./types.js";

export * from "./types.js";
export { parseLhm, LhmSource } from "./lhm.js";
export { readHwmon, HwmonSource } from "./hwmon.js";
export { MockSource } from "./mock.js";

export function createSensorSource(
  cfg: Pick<AgentConfig, "sensorSource" | "lhmUrl" | "lhmAuth">,
  opts: { mock?: boolean; platform?: NodeJS.Platform } = {},
): SensorSource {
  const platform = opts.platform ?? process.platform;
  const which = opts.mock ? "mock" : cfg.sensorSource;
  if (which === "mock") return new MockSource();
  if (which === "lhm") return new LhmSource(cfg.lhmUrl, cfg.lhmAuth);
  if (which === "hwmon") return new HwmonSource();
  // auto
  return platform === "win32" ? new LhmSource(cfg.lhmUrl, cfg.lhmAuth) : new HwmonSource();
}
