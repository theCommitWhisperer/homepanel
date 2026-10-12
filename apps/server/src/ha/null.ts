import { EventEmitter } from "node:events";
import type { CameraFetchResult, HaSource } from "./types.js";

/** Used when HA_URL/HA_TOKEN are not configured. */
export class NullHa extends EventEmitter implements HaSource {
  readonly status = "disconnected" as const;
  start() {}
  stop() {}
  states() {
    return [];
  }
  getState() {
    return undefined;
  }
  async callService(): Promise<void> {
    throw new Error("home-assistant-not-configured");
  }
  async camera(): Promise<CameraFetchResult> {
    return { status: 503, contentType: "application/json", body: Buffer.from('{"error":"ha-unavailable"}') };
  }
}
