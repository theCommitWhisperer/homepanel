import { useEffect, useState } from "react";
import { z } from "zod";
import type { HaEntityState } from "@homepanel/protocol";
import { defineWidget, useEnv, useKey } from "../sdk";
import { withToken } from "../lib/url";
import { Icon } from "../icons";
import { friendly } from "./ha-util";

const schema = z.object({ entity: z.string(), refreshSec: z.number().positive().default(10) });

export const snapshotUrl = (entity: string) => `/api/camera/${encodeURIComponent(entity)}/snapshot`;
export const streamUrl = (entity: string) => `/api/camera/${encodeURIComponent(entity)}/stream`;

/** Image that refreshes every `everyMs`, swapping only once the next frame has loaded (no flashing). */
export function RefreshingImage({ url, everyMs, token, alt, fit = "cover" }: { url: string; everyMs: number; token: string | null; alt: string; fit?: "cover" | "contain" }) {
  const [src, setSrc] = useState(() => withToken(url, token, { _: Date.now() }));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const next = withToken(url, token, { _: Date.now() });
      const img = new Image();
      img.onload = () => { if (alive) { setSrc(next); setFailed(false); } };
      img.onerror = () => alive && setFailed(true);
      img.src = next;
    };
    load();
    const t = setInterval(() => { if (document.visibilityState !== "hidden") load(); }, everyMs);
    return () => { alive = false; clearInterval(t); };
  }, [url, everyMs, token]);
  return (
    <>
      <img className="cam-img" src={src} alt={alt} style={{ objectFit: fit }} draggable={false} onError={() => setFailed(true)} />
      {failed && <div className="cam-failed"><Icon name="wifioff" size={28} /><span>No picture from camera</span></div>}
    </>
  );
}

export function LiveImage({ url, token, alt }: { url: string; token: string | null; alt: string }) {
  // a fresh query param per mount forces the browser to open a new MJPEG stream
  const [src] = useState(() => withToken(url, token, { _: Date.now() }));
  return <img className="cam-img" src={src} alt={alt} style={{ objectFit: "contain" }} draggable={false} />;
}

function Camera({ config, title }: { config: z.infer<typeof schema>; title?: string }) {
  const env = useEnv();
  const e = useKey<HaEntityState>("ha:" + config.entity);
  const [full, setFull] = useState(false);
  const name = title ?? friendly(e, config.entity);
  const every = Math.max(env.lite ? 10 : 1, config.refreshSec) * 1000;
  return (
    <>
      <button className="cam" onClick={() => !env.lite && setFull(true)} aria-label={"Open " + name + " live"}>
        <RefreshingImage url={snapshotUrl(config.entity)} everyMs={every} token={env.token} alt={name} />
        {!env.lite && <span className="cam-live-hint"><Icon name="play" size={14} /> Live</span>}
      </button>
      {full && (
        <div className="cam-full" onClick={() => setFull(false)} role="dialog" aria-label={name + " live"}>
          <LiveImage url={streamUrl(config.entity)} token={env.token} alt={name + " live"} />
          <div className="cam-full-bar">
            <span className="live-dot" /> <span>{name}</span>
            <button className="btn" onClick={() => setFull(false)}><Icon name="x" size={20} /> Close</button>
          </div>
        </div>
      )}
    </>
  );
}

export default defineWidget({
  type: "camera",
  name: "Camera",
  configSchema: schema,
  keys: (c) => ["ha:" + c.entity],
  bleed: true,
  Component: ({ config, placement }) => <Camera config={config} title={placement.title} />,
});
