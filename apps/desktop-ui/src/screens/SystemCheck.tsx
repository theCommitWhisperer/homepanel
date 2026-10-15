import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Nav } from "../App";
import { MODE_TITLES } from "../App";
import { Icon } from "../icons";
import { api, streamPrecheck } from "../lib/api";
import { counts, grouped, initialPrecheck, parseFixAction, precheckReducer } from "../lib/precheck";
import type { Check, CheckFix, ModeId, Recommendation } from "../lib/types";
import { Button, Spinner, StateIcon } from "../ui";

export function SystemCheck({ nav, onChooseMode }: { nav: Nav; onChooseMode: (m?: ModeId) => void }) {
  const [s, dispatch] = useReducer(precheckReducer, initialPrecheck);
  const abort = useRef<AbortController | null>(null);
  const [round, setRound] = useState(0);

  const run = useCallback(() => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    dispatch({ type: "reset", at: Date.now() });
    streamPrecheck((data) => dispatch({ type: "data", data }), ac.signal).catch((e) => {
      if (!ac.signal.aborted) dispatch({ type: "error", error: (e as Error).message });
    });
  }, []);

  useEffect(() => {
    run();
    return () => abort.current?.abort();
  }, [run, round]);

  const c = counts(s.checks);
  const groups = grouped(s.checks);
  const attention = c.fail + c.warn;

  return (
    <div className="screen check-screen">
      <div className="page-head">
        <div>
          <h1>System check</h1>
          <p className="lede">
            {s.done
              ? attention
                ? `${s.checks.length} checks · ${attention} need${attention === 1 ? "s" : ""} attention. Nothing was changed.`
                : `${s.checks.length} checks, all good. Nothing was changed.`
              : "Looking at this PC, Home Assistant and HomePanel. Read-only, nothing is changed."}
          </p>
        </div>
        <div className="head-actions">
          <div className="tally num" aria-label="Results">
            <Tally tone="ok" n={c.ok} label="ok" />
            <Tally tone="warn" n={c.warn} label="warnings" />
            <Tally tone="fail" n={c.fail} label="problems" />
          </div>
          <Button icon="refresh" onClick={() => setRound((r) => r + 1)} busy={!s.done} aria-label="Check again">
            {s.done ? "Check again" : "Checking"}
          </Button>
        </div>
      </div>

      <div className="check-layout">
        <div className="check-groups" aria-live="polite">
          {s.error && (
            <div className="callout callout-crit" role="alert">
              <Icon name="alert" size={18} />
              <span>{s.error}</span>
            </div>
          )}
          {groups.map((g) => (
            <section key={g.id} className="check-group" aria-labelledby={`g-${g.id}`}>
              <h2 id={`g-${g.id}`} className="group-title">
                {g.title}
                <GroupSummary checks={g.checks} done={s.done} />
              </h2>
              <ul className="check-list">
                {g.checks.map((ch) => (
                  <CheckRow key={ch.id} check={ch} nav={nav} onDone={() => setRound((r) => r + 1)} />
                ))}
                {!s.done && g.checks.length === 0 && (
                  <li className="check-row skeleton" aria-hidden>
                    <StateIcon tone="running" />
                    <span className="sk-line" />
                  </li>
                )}
                {s.done && g.checks.length === 0 && <li className="check-row empty">Nothing to check here.</li>}
              </ul>
            </section>
          ))}
        </div>
        <aside className="check-side">
          <RecommendationCard rec={s.recommendation} done={s.done} nav={nav} onChoose={() => onChooseMode()} />
        </aside>
      </div>
    </div>
  );
}

function Tally({ tone, n, label }: { tone: "ok" | "warn" | "fail"; n: number; label: string }) {
  return (
    <span className={`tally-item t-${tone}` + (n === 0 ? " zero" : "")} title={`${n} ${label}`}>
      <StateIcon tone={tone} size={16} />
      {n}
    </span>
  );
}

function GroupSummary({ checks, done }: { checks: Check[]; done: boolean }) {
  if (!checks.length) return null;
  const c = counts(checks);
  const bad = c.fail + c.warn;
  if (c.running || !done) return <span className="group-meta">checking…</span>;
  if (!bad) return <span className="group-meta ok">all good</span>;
  return <span className={"group-meta " + (c.fail ? "crit" : "warn")}>{bad} to look at</span>;
}

function CheckRow({ check, nav, onDone }: { check: Check; nav: Nav; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const runFix = async (fix: CheckFix) => {
    setErr(null);
    if (fix.href) {
      window.open(fix.href, "_blank", "noopener");
      return;
    }
    if (fix.mode) {
      await nav.startMode(fix.mode, { fromStep: fix.fromStep ?? fix.step });
      return;
    }
    if (fix.action) {
      setBusy(true);
      try {
        const a = parseFixAction(fix.action);
        if (a.kind !== "control") {
          setErr(`This HomePanel version doesn't know the fix “${a.action}”.`);
          return;
        }
        const r = await api.itemAction(a.item, a.verb);
        if (r && r.ok === false) setErr(r.error ?? "That did not work.");
        else onDone();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    }
  };
  const tone = check.state === "running" ? "running" : check.state;
  return (
    <li className={`check-row cs-${check.state}`}>
      <StateIcon tone={tone} label={check.state} />
      <div className="check-text">
        <div className="check-label">{check.label}</div>
        {check.detail && <div className="check-detail">{check.detail}</div>}
        {err && <div className="inline-err">{err}</div>}
      </div>
      {check.fix && check.state !== "ok" && (
        <Button size="sm" variant={check.state === "fail" ? "primary" : "secondary"} icon={check.fix.href ? "external" : "wrench"} busy={busy} onClick={() => runFix(check.fix!)}>
          {check.fix.label}
        </Button>
      )}
    </li>
  );
}

const CTA: Record<string, string> = {
  host: "Set up this PC",
  join: "Join this PC",
  ha: "Continue Home Assistant setup",
  move: "Move the server",
  control: "Open Control",
  done: "Open dashboard",
};

function RecommendationCard({ rec, done, nav, onChoose }: { rec?: Recommendation; done: boolean; nav: Nav; onChoose: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!rec) return;
    if (rec.mode === "control") return nav.go("control");
    if (rec.mode === "done") {
      await api.open("dashboard").catch(() => undefined);
      return;
    }
    setBusy(true);
    try {
      await nav.startMode(rec.mode, { fromStep: rec.fromStep });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={"rec-card" + (rec ? " ready" : "")}>
      <div className="eyebrow">
        <Icon name="spark" size={14} />
        Recommended next step
      </div>
      {rec ? (
        <>
          <h2 className="rec-title">{rec.title}</h2>
          <p className="rec-why">{rec.why}</p>
          {rec.then && (
            <p className="rec-then">
              <span className="then-label">Then</span>
              {rec.then}
            </p>
          )}
          <Button variant="primary" size="lg" className="rec-go" onClick={go} busy={busy} autoFocus>
            {CTA[rec.mode] ?? "Start"}
            <Icon name="chevron" size={18} stroke={2.4} />
          </Button>
          {MODE_TITLES[rec.mode] && <div className="rec-mode">Runs “{MODE_TITLES[rec.mode]}”. Finished steps are skipped.</div>}
        </>
      ) : (
        <div className="rec-wait">
          {done ? (
            <span>No recommendation. Pick what you want to do below.</span>
          ) : (
            <>
              <Spinner />
              <span>Working out the next step…</span>
            </>
          )}
        </div>
      )}
      <button type="button" className="link-btn" onClick={onChoose}>
        Choose something else
        <Icon name="chevron" size={14} stroke={2.4} />
      </button>
    </div>
  );
}
