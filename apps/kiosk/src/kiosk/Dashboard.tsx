import { useEffect, useMemo, useState } from "react";
import type { Profile, WidgetPlacement } from "@homepanel/protocol";
import { parseWidget } from "../sdk";
import type { Registry } from "../sdk";
import { WidgetBoundary } from "../components";
import { parseDuration } from "../lib/duration";

export function WidgetFrame({ p, registry, fullscreen, style }: { p: WidgetPlacement; registry: Registry; fullscreen?: boolean; style?: React.CSSProperties }) {
  const parsed = useMemo(() => parseWidget(registry, p), [registry, p]);
  const bleed = parsed.ok && parsed.def.bleed;
  return (
    <section
      className={"tile w-" + p.type + (bleed ? " bleed" : "") + (fullscreen ? " fullscreen" : "")}
      style={style}
      aria-label={p.title ?? p.type}
    >
      <div className="tile-body">
        {p.title && !(parsed.ok && parsed.def.ownsTitle) && <h2 className="tile-title">{p.title}</h2>}
        <WidgetBoundary type={p.type}>
          {parsed.ok ? (
            <parsed.def.Component config={parsed.config} placement={p} fullscreen={fullscreen} />
          ) : parsed.reason === "unknown" ? (
            <div className="placeholder">
              <strong>{parsed.type}</strong>
              <span className="muted">Unknown widget. Check the type name in this profile.</span>
            </div>
          ) : (
            <div className="placeholder err">
              <strong>{p.type}</strong>
              <span className="muted">This widget's settings need fixing:</span>
              <ul>{parsed.errors.slice(0, 4).map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
        </WidgetBoundary>
      </div>
    </section>
  );
}

export function gridStyle(p: Profile): React.CSSProperties {
  return {
    gridTemplateColumns: `repeat(${p.grid.cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${p.grid.rows}, minmax(0, 1fr))`,
  };
}

export function placeStyle(w: WidgetPlacement, p: Profile): React.CSSProperties {
  const [c, r, cw, rh] = w.at;
  const col = Math.min(c, p.grid.cols - 1);
  const row = Math.min(r, p.grid.rows - 1);
  const span = Math.max(1, Math.min(rh, p.grid.rows - row));
  return {
    gridColumn: `${col + 1} / span ${Math.max(1, Math.min(cw, p.grid.cols - col))}`,
    gridRow: `${row + 1} / span ${span}`,
    // used by the stacked phone layout: reading order + a height proportional to the row span
    order: row * 100 + col,
    ["--rows" as any]: span,
  };
}

/** Returns true while the screen has been untouched for `after`. */
export function useIdle(after: string | undefined, enabled: boolean): [boolean, () => void] {
  const ms = parseDuration(after ?? "") ?? null;
  const [idle, setIdle] = useState(false);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (!enabled || !ms) { setIdle(false); return; }
    let timer = setTimeout(() => setIdle(true), ms);
    const reset = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), ms);
    };
    const evs = ["pointerdown", "touchstart", "keydown", "wheel"];
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true, capture: true } as any));
    return () => {
      clearTimeout(timer);
      evs.forEach((e) => window.removeEventListener(e, reset, { capture: true } as any));
    };
  }, [ms, enabled, bump]);
  return [idle, () => { setIdle(false); setBump((b) => b + 1); }];
}

export function Dashboard({ profile, registry }: { profile: Profile; registry: Registry }) {
  const idleWidget = profile.idle?.show ? profile.widgets.find((w) => w.id === profile.idle!.show) : undefined;
  const [idle, wake] = useIdle(profile.idle?.after, !!idleWidget);
  return (
    <>
      <main className="grid" style={gridStyle(profile)}>
        {profile.widgets.map((w, i) => (
          <WidgetFrame key={(w.id ?? "") + ":" + i + ":" + w.type} p={w} registry={registry} style={placeStyle(w, profile)} />
        ))}
      </main>
      {idle && idleWidget && (
        <div className="idle-layer" onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); wake(); }}>
          <WidgetFrame p={{ ...idleWidget, title: undefined }} registry={registry} fullscreen />
        </div>
      )}
    </>
  );
}
