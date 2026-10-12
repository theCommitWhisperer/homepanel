import { useEffect, useState } from "react";
import type { Takeover as T } from "@homepanel/protocol";
import { useEnv } from "../sdk";
import { useNow, useRunAction } from "../components";
import { LiveImage, RefreshingImage } from "../widgets/camera";
import { Icon } from "../icons";

let audioCtx: AudioContext | null = null;
/** Two-note doorbell chime generated with WebAudio (no asset needed). */
export function chime() {
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    const ctx = audioCtx!;
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const notes: [number, number][] = [[659.25, 0], [523.25, 0.42]];
    for (const [f, at] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t0 = ctx.currentTime + at;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 1.3);
    }
  } catch {
    /* autoplay blocked or no audio */
  }
}

/** Unlock audio on first touch so the chime can play later (iOS/Android autoplay rules). */
export function primeAudio() {
  const unlock = () => {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (AC && !audioCtx) audioCtx = new AC();
      void audioCtx?.resume().catch(() => undefined);
    } catch {
      /* ignore */
    }
    window.removeEventListener("pointerdown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
}

function TakeoverAction({ label, action }: { label: string; action: NonNullable<T["actions"]>[number]["action"] }) {
  const { run, state, sheet } = useRunAction();
  return (
    <>
      <button className="btn big" onClick={() => run(action, label)} disabled={state === "pending"}>
        {state === "pending" ? <span className="spinner" /> : state === "ok" ? <Icon name="check" /> : null} {label}
      </button>
      {sheet}
    </>
  );
}

export function Takeover({ t, onClose }: { t: T; onClose: () => void }) {
  const env = useEnv();
  const [shownAt] = useState(Date.now());
  const now = useNow(1000);
  useEffect(() => {
    chime();
  }, [t.id]);
  useEffect(() => {
    if (!t.closeAfterMs) return;
    const timer = setTimeout(onClose, t.closeAfterMs);
    return () => clearTimeout(timer);
  }, [t.id, t.closeAfterMs]);

  const snap = t.snapshotUrl ?? (t.camera ? `/api/camera/${encodeURIComponent(t.camera)}/snapshot` : undefined);
  const stream = t.streamUrl ?? (t.camera ? `/api/camera/${encodeURIComponent(t.camera)}/stream` : undefined);
  const left = t.closeAfterMs ? Math.max(0, Math.ceil((shownAt + t.closeAfterMs - now) / 1000)) : null;
  const time = new Date(shownAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <div className={"takeover kind-" + t.kind} role="alertdialog" aria-label={t.title}>
      <div className="to-media">
        {env.lite || !stream ? (
          snap ? <RefreshingImage url={snap} everyMs={env.lite ? 10_000 : 2_000} token={env.token} alt={t.title} fit="contain" /> : <div className="to-noimg"><Icon name={t.kind === "doorbell" ? "bell" : "alert"} size={96} /></div>
        ) : (
          <LiveImage url={stream} token={env.token} alt={t.title} />
        )}
      </div>
      <div className="to-panel">
        <div className="to-head">
          <span className="to-icon"><Icon name={t.kind === "doorbell" ? "bell" : "alert"} size={30} /></span>
          <div>
            <h1>{t.title}</h1>
            <div className="to-sub num">{time}{left != null ? ` · closes in ${left}s` : ""}</div>
          </div>
        </div>
        {t.message && <p className="to-msg">{t.message}</p>}
        <div className="to-actions">
          {(t.actions ?? []).map((a, i) => <TakeoverAction key={i} label={a.label} action={a.action} />)}
          <button className="btn big primary" onClick={onClose}><Icon name="x" size={22} /> Dismiss</button>
        </div>
      </div>
    </div>
  );
}
