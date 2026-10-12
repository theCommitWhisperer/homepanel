import { useEffect, useState } from "react";
import { z } from "zod";
import { defineWidget, useEnv } from "../sdk";
import { withToken } from "../lib/url";
import { parseDuration } from "../lib/duration";

/**
 * src: "media/<file>" (or "/media/<file>", or "<file>" relative to the media folder) | absolute URL | "folder:<dir>" (slideshow).
 * interval: slideshow step as a duration ("10s", "1m"). `folder` / `intervalSec` are accepted as aliases.
 */
export const schema = z
  .object({
    src: z.string().optional(),
    fit: z.enum(["cover", "contain"]).default("cover"),
    interval: z.string().optional().refine((v) => v == null || parseDuration(v) != null, { message: 'Use a duration like "10s" or "2m"' }),
    folder: z.string().optional(),
    intervalSec: z.number().positive().optional(),
  })
  .refine((c) => !!c.src || c.folder != null, { message: "Set src (a file, URL or folder:<dir>)" });

export type MediaConfig = z.infer<typeof schema>;

/** Resolve config → either a single file/URL or a folder to slideshow, plus the step in ms. */
export function resolveMedia(c: MediaConfig): { single?: string; folder?: string; stepMs: number } {
  const stepMs = (c.interval ? parseDuration(c.interval) : null) ?? (c.intervalSec ? c.intervalSec * 1000 : 10_000);
  if (c.src && /^folder:/i.test(c.src)) return { folder: c.src.slice(7).trim(), stepMs: Math.max(1000, stepMs) };
  if (c.src) return { single: c.src, stepMs };
  return { folder: c.folder ?? "", stepMs: Math.max(1000, stepMs) };
}

const VIDEO = /\.(mp4|webm|m4v|mov)(\?|#|$)/i;
const MEDIA = /\.(gif|png|jpe?g|webp|svg|avif|mp4|webm|m4v|mov)(\?|#|$)/i;

/** "gifs/cat.gif" → "/media/gifs/cat.gif" */
export function mediaPath(p: string) {
  if (/^(https?:|data:|blob:)/i.test(p) || p.startsWith("/")) return p;
  const rel = p.replace(/^media\//, "");
  return "/media/" + rel.split("/").map(encodeURIComponent).join("/");
}

export function filterFolder(paths: string[], folder: string): string[] {
  const f = folder.replace(/^\/+/, "").replace(/^media\//, "").replace(/\/+$/, "");
  return paths
    .map((p) => p.replace(/^\/+/, "").replace(/^media\//, ""))
    .filter((p) => (f ? p === f || p.startsWith(f + "/") : true) && MEDIA.test(p))
    .sort();
}

function MediaItem({ src, fit, token }: { src: string; fit: "cover" | "contain"; token: string | null }) {
  const url = withToken(mediaPath(src), token);
  if (VIDEO.test(src)) return <video className="media-el" src={url} style={{ objectFit: fit }} muted loop autoPlay playsInline />;
  return <img className="media-el" src={url} style={{ objectFit: fit }} alt="" draggable={false} />;
}

function Media({ config }: { config: MediaConfig }) {
  const env = useEnv();
  const { single, folder, stepMs } = resolveMedia(config);
  const [list, setList] = useState<string[] | null>(single ? [single] : null);
  const [i, setI] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (single) { setList([single]); return; }
    let alive = true;
    const load = () =>
      fetch("/api/media", { headers: env.token ? { Authorization: "Bearer " + env.token } : {} })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
        .then((paths: string[]) => { if (alive) { setList(filterFolder(paths, folder ?? "")); setErr(null); } })
        .catch((e) => alive && setErr(String(e.message || e)));
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [single, folder, env.token]);

  useEffect(() => {
    if (!list || list.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % list.length), stepMs);
    return () => clearInterval(t);
  }, [list, stepMs]);

  if (err) return <div className="empty">Couldn't load media ({err})</div>;
  if (!list) return <div className="empty">Loading…</div>;
  if (!list.length) return <div className="empty">No pictures in “{folder}”. Add files to the media folder.</div>;
  const cur = list[i % list.length];
  return (
    <div className={"media" + (config.fit === "contain" ? " contain" : "")}>
      <MediaItem key={cur} src={cur} fit={config.fit} token={env.token} />
    </div>
  );
}

export default defineWidget({
  type: "media",
  name: "Media",
  configSchema: schema,
  keys: () => [],
  bleed: true,
  Component: ({ config }) => <Media config={config} />,
});
