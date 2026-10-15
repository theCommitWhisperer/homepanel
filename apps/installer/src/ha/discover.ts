import { DEFAULT_HA_HOST, HA_PORT, MDNS_HA_HOST } from "../constants.js";
import { HaClient, alternateHaUrl, normalizeHaUrl, type OnboardingStatus } from "./client.js";

export interface FoundHa {
  url: string;
  source: "mdns" | "probe" | "user";
  name?: string;
  version?: string;
  status?: OnboardingStatus["state"];
}

/**
 * Browse mDNS for `_home-assistant._tcp` for `timeoutMs` (default 3 s). HA publishes TXT records
 * with internal_url / base_url, plus SRV + A records.
 */
export async function browseMdns(timeoutMs = 3000): Promise<FoundHa[]> {
  let mdnsFactory: typeof import("multicast-dns");
  try {
    mdnsFactory = (await import("multicast-dns")).default as any;
  } catch {
    return [];
  }
  return new Promise((resolve) => {
    const found = new Map<string, FoundHa>();
    let m: ReturnType<typeof mdnsFactory>;
    try {
      m = mdnsFactory();
    } catch {
      resolve([]);
      return;
    }
    const srv = new Map<string, { target: string; port: number }>();
    const addrs = new Map<string, string>();
    const txt = new Map<string, Record<string, string>>();

    m.on("response", (res: any) => {
      const records = [...(res.answers ?? []), ...(res.additionals ?? [])];
      for (const r of records) {
        if (r.type === "SRV" && /_home-assistant\._tcp/.test(r.name)) srv.set(r.name, { target: r.data.target, port: r.data.port });
        if (r.type === "A") addrs.set(r.name, r.data);
        if (r.type === "TXT" && /_home-assistant\._tcp/.test(r.name)) {
          const kv: Record<string, string> = {};
          for (const b of r.data as Buffer[]) {
            const s = b.toString();
            const i = s.indexOf("=");
            if (i > 0) kv[s.slice(0, i)] = s.slice(i + 1);
          }
          txt.set(r.name, kv);
        }
      }
      for (const [name, s] of srv) {
        const t = txt.get(name) ?? {};
        const ip = addrs.get(s.target);
        const url = t.internal_url || (ip ? `http://${ip}:${s.port}` : t.base_url) || "";
        if (!url) continue;
        try {
          const u = normalizeHaUrl(url);
          found.set(u, { url: u, source: "mdns", name: t.location_name, version: t.version });
        } catch {
          /* ignore bad url */
        }
      }
    });
    m.on("error", () => undefined);
    try {
      m.query({ questions: [{ name: "_home-assistant._tcp.local", type: "PTR" }] });
    } catch {
      /* no multicast-capable interface */
    }
    setTimeout(() => {
      try {
        m.destroy();
      } catch {
        /* ignore */
      }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/**
 * Find Home Assistant: any extra hosts the user gives + the default IP (DEFAULT_HA_HOST) + mDNS +
 * http://homeassistant.local:8123. Each candidate is checked with GET /api/onboarding.
 */
export async function findHomeAssistant(
  opts: { extra?: string[]; mdnsMs?: number; fetchImpl?: typeof fetch; skipMdns?: boolean } = {},
): Promise<FoundHa[]> {
  const candidates = new Map<string, FoundHa>();
  const add = (url: string, source: FoundHa["source"], extra: Partial<FoundHa> = {}) => {
    try {
      const u = normalizeHaUrl(url);
      if (!candidates.has(u)) candidates.set(u, { url: u, source, ...extra });
    } catch {
      /* ignore */
    }
  };
  // Each address is tried on :8123 and on plain http (port 80): newer Home Assistant OS answers on port 80.
  const addBoth = (url: string, source: FoundHa["source"], extra: Partial<FoundHa> = {}) => {
    add(url, source, extra);
    try {
      const alt = alternateHaUrl(normalizeHaUrl(url));
      if (alt) add(alt, source, extra);
    } catch {
      /* ignore */
    }
  };
  for (const e of opts.extra ?? []) if (e) addBoth(e, "user");
  addBoth(`http://${DEFAULT_HA_HOST}:${HA_PORT}`, "probe");
  const mdns = opts.skipMdns ? [] : await browseMdns(opts.mdnsMs ?? 3000);
  for (const f of mdns) add(f.url, "mdns", f);
  addBoth(`http://${MDNS_HA_HOST}:${HA_PORT}`, "probe");

  const checked = await Promise.all(
    [...candidates.values()].map(async (c) => {
      const s = await new HaClient(c.url, { fetchImpl: opts.fetchImpl }).onboardingStatus();
      return { ...c, status: s.state };
    }),
  );
  return checked.filter((c) => c.status !== "unreachable" || c.source === "user");
}

/**
 * Poll until Home Assistant Core answers (onboarding page or already set up). On HA OS the first boot
 * shows a "Preparing Home Assistant" landing page for 10–20 minutes while Core (~700 MB) downloads;
 * that counts as not ready yet. `onTick` gets the elapsed seconds, the state and (while preparing)
 * the Supervisor's progress text. Supports single URL or multiple candidates.
 */
export async function waitForHa(
  target: string | string[],
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    onTick?: (elapsedS: number, state: "unreachable" | "preparing", progress?: string) => void;
    onFound?: (url: string) => void;
  } = {},
): Promise<string | false> {
  const targets = Array.isArray(target) ? target : [target];
  const list: string[] = [];
  for (const t of targets) {
    if (!list.includes(t)) list.push(t);
    const alt = alternateHaUrl(t);
    if (alt && !list.includes(alt)) list.push(alt);
  }
  const clients = list.map((u) => ({ url: u, client: new HaClient(u, { fetchImpl: opts.fetchImpl }) }));
  const start = Date.now();
  const timeout = opts.timeoutMs ?? 20 * 60_000;
  for (;;) {
    let bestState: "unreachable" | "preparing" = "unreachable";
    let progressText: string | undefined;
    for (const c of clients) {
      const s = await c.client.onboardingStatus();
      if (s.state === "onboarding" || s.state === "onboarded") {
        opts.onFound?.(c.url);
        return c.url;
      }
      if (s.state === "preparing") {
        bestState = "preparing";
        progressText = await c.client.preparingProgress();
      }
    }
    const elapsed = Date.now() - start;
    if (elapsed > timeout) return false;
    opts.onTick?.(Math.round(elapsed / 1000), bestState, progressText);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 5000));
  }
}
