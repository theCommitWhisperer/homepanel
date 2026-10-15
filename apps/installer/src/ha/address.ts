import { DEFAULT_HA_HOST, HA_PORT, MDNS_HA_HOST, SERVER_PORT } from "../constants.js";
import type { StateStore } from "../state.js";
import { HaClient, normalizeHaUrl } from "./client.js";

/** Host used to build URLs when the user hasn't given one: the saved host, else the default IP. */
export function haHost(store: StateStore): string {
  return store.state.host ?? DEFAULT_HA_HOST;
}

/** HA URLs to try, in order: the saved one, the default IP, then the mDNS name. */
export function haCandidates(saved?: string): string[] {
  const out: string[] = [];
  for (const c of [saved, `http://${DEFAULT_HA_HOST}:${HA_PORT}`, `http://${MDNS_HA_HOST}:${HA_PORT}`]) {
    if (!c) continue;
    try {
      const u = normalizeHaUrl(c);
      if (!out.includes(u)) out.push(u);
    } catch {
      /* ignore a bad saved value */
    }
  }
  return out;
}

/** First candidate that answers HTTP (any onboarding state), or undefined. Tried in parallel. */
export async function findReachableHa(fetchImpl: typeof fetch, saved?: string, timeoutMs = 2000): Promise<string | undefined> {
  const list = haCandidates(saved);
  const res = await Promise.all(list.map((u) => new HaClient(u, { fetchImpl }).onboardingStatus(timeoutMs)));
  return list.find((_, i) => res[i]!.state !== "unreachable");
}

/** Same URL with another host name, keeping protocol and port. */
export function withHost(url: string, host: string): string {
  const u = new URL(url);
  u.hostname = host;
  return `${u.protocol}//${u.host}`;
}

/**
 * Save a new Home Assistant address. HomePanel and Mosquitto run on the HA box, so the server URL and
 * the MQTT host follow when they pointed at the old host — one change updates everything.
 * Returns human-readable lines describing what changed.
 */
export function setHaAddress(store: StateStore, input: string): string[] {
  const haUrl = normalizeHaUrl(input);
  const host = new URL(haUrl).hostname;
  const old = store.state.host;
  const changed: string[] = [];
  if (store.state.haUrl !== haUrl) changed.push(`Home Assistant: ${store.state.haUrl ?? "(none)"} → ${haUrl}`);
  const patch: Parameters<StateStore["update"]>[0] = { haUrl, host };

  const s = store.state.serverUrl;
  if (!s) patch.serverUrl = `http://${host}:${SERVER_PORT}`;
  else if (old && old !== host) {
    try {
      if (new URL(s).hostname === old) {
        patch.serverUrl = withHost(s, host);
        changed.push(`HomePanel server: ${s} → ${patch.serverUrl}`);
      }
    } catch {
      patch.serverUrl = `http://${host}:${SERVER_PORT}`;
    }
  }
  const m = store.state.mqtt;
  if (m && old && m.host === old && old !== host) {
    patch.mqtt = { ...m, host };
    changed.push(`MQTT broker: ${m.host} → ${host}`);
  }
  store.update(patch);
  return changed;
}
