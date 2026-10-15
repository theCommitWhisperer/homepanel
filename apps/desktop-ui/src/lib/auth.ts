// The window opens at http://127.0.0.1:<port>/#k=<secret>. Move the secret into a cookie (so
// EventSource and plain links carry it), keep it in memory for the x-hp-ui header, and strip the
// hash so it never shows up in history or screenshots.

export const COOKIE = "hpui";
export const HEADER = "x-hp-ui";

export interface AuthEnv {
  location: { hash: string; pathname: string; search: string };
  document: { cookie: string };
  history?: { replaceState(data: unknown, unused: string, url?: string): void };
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
}

/** Secret from `#k=…` (also accepts `#k=…&view=control`). */
export function secretFromHash(hash: string): string | undefined {
  const h = hash.replace(/^#/, "");
  if (!h) return undefined;
  const params = new URLSearchParams(h);
  const k = params.get("k");
  return k && /^[A-Za-z0-9._~-]{1,512}$/.test(k) ? k : undefined;
}

/** Other hash parameters the opener may pass (e.g. view=control), kept after the secret is stripped. */
export function hashParams(hash: string): Record<string, string> {
  const out: Record<string, string> = {};
  new URLSearchParams(hash.replace(/^#/, "")).forEach((v, k) => {
    if (k !== "k") out[k] = v;
  });
  return out;
}

export function readCookie(cookie: string, name = COOKIE): string | undefined {
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function bootstrapAuth(env: AuthEnv): { secret?: string; params: Record<string, string> } {
  const fromHash = secretFromHash(env.location.hash);
  const params = hashParams(env.location.hash);
  let secret = fromHash;
  if (fromHash) {
    env.document.cookie = `${COOKIE}=${encodeURIComponent(fromHash)}; SameSite=Strict; path=/`;
    try {
      env.storage?.setItem(COOKIE, fromHash);
    } catch {
      /* private mode */
    }
    if (env.history) {
      const rest = Object.keys(params).length ? "#" + new URLSearchParams(params).toString() : "";
      env.history.replaceState(null, "", env.location.pathname + env.location.search + rest);
    }
  } else {
    secret = readCookie(env.document.cookie);
    if (!secret) {
      try {
        secret = env.storage?.getItem(COOKIE) ?? undefined;
      } catch {
        secret = undefined;
      }
    }
  }
  return { secret, params };
}

let current: string | undefined;
export function setSecret(s: string | undefined) {
  current = s;
}
export function authHeaders(): Record<string, string> {
  return current ? { [HEADER]: current } : {};
}
