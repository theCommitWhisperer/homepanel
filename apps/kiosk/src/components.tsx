import { Component, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { ActionRequest } from "@homepanel/protocol";
import { Icon } from "./icons";
import { toast, toastStore } from "./lib/toast";
import { useAction } from "./sdk";

/* ---------------- error boundary per widget ---------------- */
export class WidgetBoundary extends Component<{ type: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[widget ${this.props.type}]`, error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="placeholder err">
          <strong>{this.props.type}</strong>
          <span className="muted">This widget crashed.</span>
          <ul><li>{String(this.state.error.message || this.state.error)}</li></ul>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ---------------- size hook (callback ref: works for elements that mount later) ---------------- */
export function useSize<T extends HTMLElement>(): [(el: T | null) => void, { w: number; h: number }] {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: r.width, h: r.height }));
    };
    measure();
    const RO = (window as any).ResizeObserver;
    if (RO) {
      const ro = new RO(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [el]);
  return [setEl, size];
}

export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/* ---------------- sheet ---------------- */
export function Sheet({ children, onClose, label }: { children: ReactNode; onClose: () => void; label: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="sheet-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()} role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

export function ConfirmSheet(props: { title: string; body?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Sheet onClose={props.onCancel} label={props.title}>
      <h2>{props.title}</h2>
      <p>{props.body ?? "This runs right away."}</p>
      <div className="row">
        <button className="btn" onClick={props.onCancel}>Cancel</button>
        <button className={"btn " + (props.danger ? "danger" : "primary")} onClick={props.onConfirm}>{props.confirmLabel ?? "Run it"}</button>
      </div>
    </Sheet>
  );
}

/* ---------------- toasts ---------------- */
export function Toasts() {
  const list = useSyncExternalStore(toastStore.subscribe, toastStore.get, toastStore.get);
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={"toast " + t.kind}>
          {t.kind === "ok" ? <Icon name="check" size={20} /> : t.kind === "error" ? <Icon name="alert" size={20} /> : null}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- run an action with confirm + feedback ---------------- */
export type RunState = "idle" | "pending" | "ok" | "error";

const FRIENDLY: Record<string, string> = {
  "home-only": "Only works from a screen at home",
  "not-connected": "Not connected",
  "Not connected": "Not connected to HomePanel",
  disconnected: "Connection dropped, try again",
  offline: "That PC is offline",
  "agent-offline": "That PC is offline",
  "invalid-action": "This button is set up wrong",
  "unknown-action": "The PC doesn't offer that action",
};

/** Server errors that mean "ask the user, then resend with confirmed:true". */
export const isConfirmError = (e?: string) => e === "needs-confirm" || e === "confirm-required";
export const friendlyError = (e?: string) => (e ? FRIENDLY[e] ?? e.replace(/-/g, " ") : "Failed");

/**
 * Runs an action: optional pre-confirm, spinner state, ✓/error toast, and the server's
 * "confirm-required" handshake (show sheet, resend with confirmed:true).
 */
export function useRunAction() {
  const send = useAction();
  const [state, setState] = useState<RunState>("idle");
  const [confirm, setConfirm] = useState<{ action: ActionRequest; label: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const exec = async (action: ActionRequest, label: string, confirmed?: boolean) => {
    setState("pending");
    const r = await send(action, confirmed);
    if (!mounted.current) return;
    if (r.ok) {
      setState("ok");
      toast(label + " — done", "ok", 2500);
    } else if (isConfirmError(r.error) && !confirmed) {
      setState("idle");
      setConfirm({ action, label });
      return;
    } else {
      setState("error");
      toast(label + ": " + friendlyError(r.error), "error", 4500);
    }
    setTimeout(() => mounted.current && setState("idle"), 1600);
  };

  const run = (action: ActionRequest, label: string, needsConfirm?: boolean) => {
    if (state === "pending") return;
    if (needsConfirm) setConfirm({ action, label });
    else void exec(action, label);
  };

  const sheet = confirm ? (
    <ConfirmSheet
      title={confirm.label + "?"}
      body={
        confirm.action.kind === "agent"
          ? `This runs “${confirm.label}” on ${confirm.action.pc} right away.`
          : confirm.action.kind === "wol"
            ? `This wakes ${confirm.action.pc}.`
            : "This runs right away."
      }
      confirmLabel={confirm.label}
      danger={confirm.action.kind === "agent" && /shut|restart|reboot|sleep|power/i.test(confirm.label + (confirm.action as any).action)}
      onCancel={() => setConfirm(null)}
      onConfirm={() => {
        const c = confirm;
        setConfirm(null);
        void exec(c.action, c.label, true);
      }}
    />
  ) : null;

  return { run, state, sheet };
}

/* ---------------- long press ---------------- */
export function usePress(onTap: () => void, onLong?: () => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      if (onLong) timer.current = setTimeout(() => { fired.current = true; onLong(); }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start.current && Math.abs(e.clientX - start.current.x) + Math.abs(e.clientY - start.current.y) > 14) clear();
    },
    onPointerUp: () => clear(),
    onPointerCancel: () => { clear(); fired.current = true; },
    onPointerLeave: () => clear(),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClick: () => {
      if (fired.current) { fired.current = false; return; }
      onTap();
    },
  };
}

/* ---------------- sparkline ---------------- */
export function Sparkline({ points, w, h, color = "var(--accent)", min, max }: { points: { t: number; v: number }[]; w: number; h: number; color?: string; min?: number; max?: number }) {
  if (points.length < 2 || w < 10 || h < 6) return <svg width={w} height={h} aria-hidden />;
  const t0 = points[0].t;
  const t1 = Math.max(points[points.length - 1].t, t0 + 1);
  let lo = min ?? Infinity, hi = max ?? -Infinity;
  if (min == null || max == null) for (const p of points) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
  if (hi - lo < 16) { const mid = (hi + lo) / 2; lo = mid - 8; hi = mid + 8; }
  const pad = 3;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * (w - pad * 2) + pad;
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);
  const d = points.map((p, i) => (i ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.v).toFixed(1)).join(" ");
  const last = points[points.length - 1];
  return (
    <svg width={w} height={h} aria-hidden style={{ display: "block", overflow: "visible" }}>
      <path d={d + ` L${x(last.t).toFixed(1)} ${h} L${x(t0).toFixed(1)} ${h} Z`} fill={color} opacity={0.1} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.t)} cy={y(last.v)} r={3.5} fill={color} />
    </svg>
  );
}
