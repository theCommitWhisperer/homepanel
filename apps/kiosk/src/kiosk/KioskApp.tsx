import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Profile } from "@homepanel/protocol";
import { connection } from "../lib/connection";
import { collectKeys, WidgetEnvContext } from "../sdk";
import type { WidgetEnv } from "../sdk";
import { registry } from "../widgets";
import { Toasts } from "../components";
import { Icon } from "../icons";
import { Pairing } from "./Pairing";
import { Dashboard } from "./Dashboard";
import { primeAudio, Takeover } from "./Takeover";

export function applyTheme(theme: Profile["theme"] | undefined, lite: boolean) {
  const root = document.documentElement;
  let t = theme ?? "dark";
  if (t === "auto") {
    try {
      t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {
      t = "dark";
    }
  }
  root.setAttribute("data-theme", t);
  root.classList.toggle("lite", lite);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "light" ? "#e9ecee" : "#08090b");
}

function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const nav = navigator as any;
    if (!nav.wakeLock?.request) return;
    let lock: any = null;
    let alive = true;
    const req = async () => {
      try {
        lock = await nav.wakeLock.request("screen");
      } catch {
        /* not allowed (no gesture / low battery) — ignore */
      }
    };
    const onVis = () => alive && document.visibilityState === "visible" && void req();
    void req();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pointerdown", onVis, { once: true });
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVis);
      try { void lock?.release(); } catch { /* ignore */ }
    };
  }, [active]);
}

/** iOS ignores user-scalable=no; block pinch + double-tap zoom on the kiosk explicitly. */
function useNoZoom() {
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    const multi = (e: TouchEvent) => { if (e.touches.length > 1) e.preventDefault(); };
    document.addEventListener("gesturestart", stop);
    document.addEventListener("touchmove", multi, { passive: false });
    return () => {
      document.removeEventListener("gesturestart", stop);
      document.removeEventListener("touchmove", multi);
    };
  }, []);
}

export function KioskApp() {
  const snap = useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
  const profile = snap.profile;

  useEffect(() => {
    connection.start();
    primeAudio();
    return () => connection.stop();
  }, []);

  useEffect(() => {
    applyTheme(profile?.theme, !!profile?.lite);
    if (profile?.theme !== "auto") return;
    let mq: MediaQueryList | null = null;
    try { mq = window.matchMedia("(prefers-color-scheme: light)"); } catch { return; }
    const on = () => applyTheme("auto", !!profile?.lite);
    const m = mq as any;
    if (m.addEventListener) m.addEventListener("change", on);
    else m.addListener(on);
    return () => (m.removeEventListener ? m.removeEventListener("change", on) : m.removeListener(on));
  }, [profile?.theme, profile?.lite]);

  // subscribe to the union of keys every visible widget needs; re-sent when the profile changes
  useEffect(() => {
    if (profile) connection.setKeys(collectKeys(registry, profile.widgets));
  }, [profile]);

  useWakeLock(!!profile);
  useNoZoom();

  const env: WidgetEnv = useMemo(
    () => ({ connection, token: snap.token, lite: !!profile?.lite, device: snap.device }),
    [snap.token, profile?.lite, snap.device],
  );

  if (snap.status === "no-token") {
    return <Pairing reason={snap.lastError} onPaired={(t) => connection.setToken(t)} />;
  }

  return (
    <WidgetEnvContext.Provider value={env}>
      <div className="kiosk">
        {profile ? (
          <Dashboard profile={profile} registry={registry} />
        ) : (
          <div className="center-screen">
            <div className="brand"><Icon name="logo" size={30} /> HomePanel</div>
            <div className="pair-meta"><span className="spinner" /> Connecting to the server…</div>
          </div>
        )}
        {snap.status === "reconnecting" && (
          <div className="pill-status" role="status"><span className="dot" /> Reconnecting</div>
        )}
        {snap.takeover && <Takeover key={snap.takeover.id} t={snap.takeover} onClose={() => connection.dismissTakeover()} />}
        <Toasts />
      </div>
    </WidgetEnvContext.Provider>
  );
}
