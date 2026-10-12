/**
 * Runs before anything else is imported (first import in main.tsx): `?token=<deviceToken>` is stored
 * and stripped from the URL so the connection sees it on construction. Handy for Fully Kiosk setup:
 * set the start URL to http://<server>/?token=... once.
 */
import { local, TOKEN_KEY } from "./storage";

export function takeTokenFromUrl(loc: { search: string; pathname: string; hash: string }, replace: (url: string) => void): string | null {
  const params = new URLSearchParams(loc.search);
  const t = params.get("token");
  if (!t) return null;
  local.set(TOKEN_KEY, t);
  params.delete("token");
  const q = params.toString();
  replace(loc.pathname + (q ? "?" + q : "") + loc.hash);
  return t;
}

try {
  if (typeof location !== "undefined") takeTokenFromUrl(location, (u) => history.replaceState(null, "", u));
} catch {
  /* ignore */
}
