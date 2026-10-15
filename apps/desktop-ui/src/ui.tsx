import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./icons";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "quiet";
export function Button({
  variant = "secondary",
  size,
  icon,
  busy,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "lg"; icon?: string; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={["btn", `btn-${variant}`, size ? `btn-${size}` : "", busy ? "is-busy" : "", className ?? ""].join(" ").trim()}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} size={size === "lg" ? 20 : size === "sm" ? 15 : 17} /> : null}
      {children !== undefined && children !== null && <span>{children}</span>}
    </button>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden />;
}

export type Tone = "ok" | "warn" | "fail" | "info" | "running" | "pending" | "skipped" | "manual" | "stopped" | "missing" | "unknown";

/** One glyph per state, used by checks, steps and status tiles. */
export function StateIcon({ tone, size = 22, label }: { tone: Tone; size?: number; label?: string }) {
  const inner = (() => {
    switch (tone) {
      case "ok":
        return <Icon name="check" size={size * 0.62} stroke={2.6} />;
      case "warn":
        return <span className="glyph">!</span>;
      case "fail":
        return <Icon name="x" size={size * 0.56} stroke={2.6} />;
      case "info":
        return <span className="glyph">i</span>;
      case "running":
        return <span className="ring" />;
      case "skipped":
        return <Icon name="chevron" size={size * 0.6} stroke={2.4} />;
      case "manual":
        return <Icon name="pencil" size={size * 0.52} stroke={2.4} />;
      case "stopped":
        return <span className="sq" />;
      case "missing":
        return <Icon name="minus" size={size * 0.56} stroke={2.6} />;
      default:
        return null;
    }
  })();
  return (
    <span className={`state-icon st-${tone}`} style={{ width: size, height: size }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {inner}
    </span>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallback for http://127.0.0.1 without clipboard permission
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label = "Copy", size = "sm", variant = "ghost", iconOnly }: { text: string; label?: string; size?: "sm" | "lg"; variant?: Variant; iconOnly?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <Button variant={variant} size={size} icon={done ? "check" : "copy"} onClick={async () => setDone(await copyText(text))} aria-label={`${label}: ${text.length > 40 ? text.slice(0, 40) + "…" : text}`} title={done ? "Copied" : label}>
      {iconOnly ? null : done ? "Copied" : label}
    </Button>
  );
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; id?: string }) {
  return (
    <label className="switch" htmlFor={id}>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden>
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">{label}</span>
    </label>
  );
}

/** Small modal: Escape cancels, focus starts on the safe button. */
export function Dialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Keep going",
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
        <h2 id="dlg-title">{title}</h2>
        {children && <div className="dialog-body">{children}</div>}
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={onCancel}>
            <span>{cancelLabel}</span>
          </button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Badge({ tone = "accent", children }: { tone?: "accent" | "warn" | "crit" | "muted"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Plain links inside messages: http(s) URLs become clickable. */
export function Linkify({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function usePoll(fn: () => void | Promise<void>, ms: number, deps: unknown[] = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await ref.current();
      } finally {
        if (alive) t = setTimeout(tick, ms);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}
