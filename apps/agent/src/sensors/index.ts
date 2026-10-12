import type { AgentConfig } from "../config.js";
import { HwmonSource } from "./hwmon.js";
import { LhmSource } from "./lhm.js";
import { MockSource } from "./mock.js";
import { CombinedSource, OsSource } from "./os.js";
import type { SensorSource } from "./types.js";

export * from "./types.js";
export { parseLhm, LhmSource } from "./lhm.js";
export { readHwmon, readThermalZones, HwmonSource } from "./hwmon.js";
export { MockSource } from "./mock.js";
export { OsSource, CombinedSource } from "./os.js";

/**
 * Windows: LibreHardwareMonitor (lhmUrl) + built-in loads. Linux: hwmon/thermal + built-in.
 * macOS: built-in only. --mock: fixture data with drift.
 */
export function createSensorSource(
  cfg: Pick<AgentConfig, "lhmUrl" | "lhmAuth" | "sensorSource">,
  opts: { mock?: boolean; platform?: NodeJS.Platform } = {},
): CombinedSource {
  const platform = opts.platform ?? process.platform;
  let primary: SensorSource | undefined;
  const which = cfg.sensorSource === "auto" ? (platform === "win32" ? "lhm" : platform === "linux" ? "hwmon" : "builtin") : cfg.sensorSource;
  if (opts.mock) primary = new MockSource();
  else if (which === "lhm") primary = new LhmSource(cfg.lhmUrl, cfg.lhmAuth);
  else if (which === "hwmon") primary = new HwmonSource();
  return new CombinedSource(primary, new OsSource());
}
