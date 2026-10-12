import { useEffect, useState } from "react";
import { z } from "zod";
import { defineWidget, useEnv } from "../sdk";
import { withToken } from "../lib/url";

const schema = z
  .object({
    src: z.string().optional(),
    fit: z.enum(["cover", "contain"]).default("cover"),
    folder: z.string().optional(),
    intervalSec: z.number().positive().default(10),
  })
  .refine((c) => !!c.src || c.folder != null, { message: "Set either src or folder" });

const VIDEO = /\.(mp4|webm|m4v|mov)(\?|#|$)/i;
const MEDIA = /\.(gif|png|jpe?g|webp|svg|avif|mp4|webm|m4v|mov)(\?|#|$)/i;

/** "gifs/cat.gif" → "/media/gifs/cat.gif" */
export function mediaPath(p: string) {
  if (/^(https?:|data:|blob:)/i.test(p) || p.startsWith("/")) return p;
  return "/media/" + p.split("/").map(encodeURIComponent).join("/");
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

function Media({ config }: { config: z.infer<typeof schema> }) {
  const env = useEnv();
  const [list, setList] = useState<string[] | null>(config.src ? [config.src] : null);
  const [i, setI] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (config.src) { setList([config.src]); return; }
    let alive = true;
    const load = () =>
      fetch("/api/media", { headers: env.token ? { Authorization: "Bearer " + env.token } : {} })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
        .then((paths: string[]) => { if (alive) { setList(filterFolder(paths, config.folder ?? "")); setErr(null); } })
        .catch((e) => alive && setErr(String(e.message || e)));
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [config.src, config.folder, env.token]);

  useEffect(() => {
    if (!list || list.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % list.length), config.intervalSec * 1000);
    return () => clearInterval(t);
  }, [list, config.intervalSec]);

  if (err) return <div className="empty">Couldn't load media ({err})</div>;
  if (!list) return <div className="empty">Loading…</div>;
  if (!list.length) return <div className="empty">No pictures in “{config.folder}”. Add files to the media folder.</div>;
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
