import type { FastifyBaseLogger } from "fastify";
import type { HaEntityState, ServerConfigFile, Takeover } from "@homepanel/protocol";
import { parseDuration, randomId } from "./util.js";

export const RING_DEBOUNCE_MS = 10_000;

export interface TakeoverTarget {
  deviceId: string;
  profileId: string;
  send(msg: { type: "takeover"; takeover: Takeover } | { type: "takeover_end"; id: string }): void;
}

export interface TakeoverDeps {
  getConfig: () => ServerConfigFile;
  targets: () => Iterable<TakeoverTarget>;
  /** deviceId → profileId of a paired device (for Fully Kiosk wake filtering) */
  deviceProfile: (deviceId: string) => string | undefined;
  log: FastifyBaseLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** True when a state change of `entityId` means "the doorbell rang". */
export function isRing(entityId: string, next: HaEntityState | null, prev: HaEntityState | null): boolean {
  if (!next) return false;
  const bad = (s?: string) => !s || s === "unavailable" || s === "unknown";
  if (entityId.startsWith("event.")) {
    // event entities: state is the timestamp of the last event; any new value is a ring
    if (bad(next.state) || !prev) return false;
    return next.state !== prev.state;
  }
  // binary_sensor (and anything else): rising edge to "on"
  return next.state === "on" && prev?.state !== "on";
}

/** Doorbell takeovers: watch ring entities, broadcast overlays, wake screens. */
export class TakeoverManager {
  private lastRing = new Map<string, number>();
  private active = new Map<string, NodeJS.Timeout>();
  private now: () => number;

  constructor(private deps: TakeoverDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Feed every HA state change here. Returns the takeover if one was started. */
  onStateChange(entityId: string, next: HaEntityState | null, prev: HaEntityState | null): Takeover | undefined {
    const cfg = this.deps.getConfig();
    for (const [name, bell] of Object.entries(cfg.doorbells)) {
      if (bell.ring === entityId && isRing(entityId, next, prev)) return this.ring(name);
    }
    return undefined;
  }

  clearDebounce(name: string) {
    this.lastRing.delete(name);
  }

  /** Start the takeover for doorbell `name` (debounced). */
  ring(name: string): Takeover | undefined {
    const cfg = this.deps.getConfig();
    const bell = cfg.doorbells[name];
    if (!bell) return undefined;
    const t = this.now();
    const last = this.lastRing.get(name);
    if (last !== undefined && t - last < RING_DEBOUNCE_MS) {
      this.deps.log.debug({ doorbell: name }, "ring debounced");
      return undefined;
    }
    this.lastRing.set(name, t);
    const closeAfterMs = parseDuration(cfg.on_ring.close_after, 60_000);
    const cam = encodeURIComponent(bell.camera);
    const snapCam = encodeURIComponent(bell.snapshot ?? bell.camera);
    const takeover: Takeover = {
      id: randomId(8),
      kind: "doorbell",
      title: bell.name ?? `${name.charAt(0).toUpperCase()}${name.slice(1)} door`,
      camera: bell.camera,
      streamUrl: `/api/camera/${cam}/stream`,
      snapshotUrl: `/api/camera/${snapCam}/snapshot`,
      message: "Someone is at the door",
      closeAfterMs,
    };
    const showOn = cfg.on_ring.show_on;
    let count = 0;
    for (const target of this.deps.targets()) {
      if (showOn.length && !showOn.includes(target.profileId)) continue;
      target.send({ type: "takeover", takeover });
      count++;
    }
    this.deps.log.info({ doorbell: name, screens: count }, "doorbell ring → takeover");
    const timer = setTimeout(() => {
      this.active.delete(takeover.id);
      for (const target of this.deps.targets()) target.send({ type: "takeover_end", id: takeover.id });
    }, closeAfterMs + 1000);
    timer.unref?.();
    this.active.set(takeover.id, timer);
    if (cfg.on_ring.wake_screens) void this.wakeScreens(cfg);
    return takeover;
  }

  private async wakeScreens(cfg: ServerConfigFile) {
    const f = this.deps.fetchImpl ?? fetch;
    const showOn = cfg.on_ring.show_on;
    await Promise.all(
      Object.entries(cfg.fully_kiosk).map(async ([deviceId, fk]) => {
        const profile = this.deps.deviceProfile(deviceId);
        if (showOn.length && profile && !showOn.includes(profile)) return;
        const base = fk.url.replace(/\/+$/, "");
        for (const cmd of ["screenOn", "toForeground"]) {
          const url = `${base}/?cmd=${cmd}&type=json&password=${encodeURIComponent(fk.password)}`;
          try {
            await f(url, { signal: AbortSignal.timeout(3000) });
          } catch (e) {
            this.deps.log.warn({ device: deviceId, err: (e as Error).message }, "fully kiosk wake failed");
            return;
          }
        }
      }),
    );
  }

  stop() {
    for (const t of this.active.values()) clearTimeout(t);
    this.active.clear();
  }
}
