import { HaClient, normalizeHaUrl, type OnboardingStatus } from "./client.js";

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
 * Find Home Assistant: mDNS + http://homeassistant.local:8123 + any extra hosts the user gives.
 * Each candidate is checked with GET /api/onboarding.
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
  for (const e of opts.extra ?? []) if (e) add(e, "user");
  const mdns = opts.skipMdns ? [] : await browseMdns(opts.mdnsMs ?? 3000);
  for (const f of mdns) add(f.url, "mdns", f);
  add("http://homeassistant.local:8123", "probe");

  const checked = await Promise.all(
    [...candidates.values()].map(async (c) => {
      const s = await new HaClient(c.url, { fetchImpl: opts.fetchImpl }).onboardingStatus();
      return { ...c, status: s.state };
    }),
  );
  return checked.filter((c) => c.status !== "unreachable" || c.source === "user");
}

/** Poll until HA answers HTTP (after first boot HA OS can take 5–20 minutes). */
export async function waitForHa(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch; onTick?: (elapsedS: number) => void } = {},
): Promise<boolean> {
  const client = new HaClient(url, { fetchImpl: opts.fetchImpl });
  const start = Date.now();
  const timeout = opts.timeoutMs ?? 20 * 60_000;
  for (;;) {
    const s = await client.onboardingStatus();
    if (s.state !== "unreachable") return true;
    const elapsed = Date.now() - start;
    if (elapsed > timeout) return false;
    opts.onTick?.(Math.round(elapsed / 1000));
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 5000));
  }
}
