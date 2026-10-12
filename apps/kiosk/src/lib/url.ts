/** Append ?t=<token> (or &t=) to a same-origin relative URL so <img>/<video> can authenticate. */
export function withToken(url: string, token: string | null | undefined, extra?: Record<string, string | number>): string {
  if (!url) return url;
  const isRelative = url.startsWith("/") && !url.startsWith("//");
  const params: string[] = [];
  if (isRelative && token) params.push("t=" + encodeURIComponent(token));
  if (extra) for (const k of Object.keys(extra)) params.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(extra[k])));
  if (!params.length) return url;
  const hashIdx = url.indexOf("#");
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
  return base + (base.indexOf("?") >= 0 ? "&" : "?") + params.join("&") + hash;
}

export function wsUrl(path = "/ws"): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + path;
}
