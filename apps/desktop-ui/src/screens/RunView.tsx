import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Nav } from "../App";
import { MODE_TITLES } from "../App";
import { Icon } from "../icons";
import { api } from "../lib/api";
import { answerFor, confirmDefault, defaultChoiceIndex, initialText, layoutFor, shortcutIndex, splitChoice } from "../lib/questions";
import { doneCount, fmtDuration, INTRO, isStepHeading, type LogEntry, type PendingQuestion, type SetupRunState, type StepView } from "../lib/setup";
import type { StepState, SummaryItem } from "../lib/types";
import { Button, CopyButton, Dialog, Linkify, Spinner, StateIcon, type Tone } from "../ui";

const STEP_TONE: Record<StepState, Tone> = {
  checking: "running",
  running: "running",
  pending: "pending",
  done: "ok",
  skipped: "skipped",
  failed: "fail",
  manual: "manual",
};
const STEP_WORD: Record<StepState, string> = {
  checking: "Checking",
  running: "Working",
  pending: "Waiting",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
  manual: "Needs you",
};

/** Don't pull focus out of a field the user is typing in (e.g. the AI chat) when a question appears. */
function canSteal(): boolean {
  const a = document.activeElement;
  if (!a || a === document.body) return true;
  if (a.closest(".question")) return true;
  return !(a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement);
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function RunView({ nav, run, onLocalAi, aiRequested }: { nav: Nav; run: SetupRunState; onLocalAi: (t: string) => void; aiRequested?: boolean }) {
  const [pinned, setPinned] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const running = run.state === "running";
  const now = useNow(running);

  useEffect(() => {
    setPinned(null);
    setShowSteps(false);
  }, [run.runId]);

  if (!run.runId) {
    return (
      <div className="screen empty-screen">
        <div className="empty-card">
          <Icon name="wrench" size={28} />
          <h1>No setup is running</h1>
          <p>Start one from the System check (it suggests the next step) or pick a mode yourself.</p>
          <div className="row-gap">
            <Button variant="primary" icon="check" onClick={() => nav.go("check")}>
              System check
            </Button>
            <Button onClick={() => nav.go("modes")}>Choose a mode</Button>
          </div>
        </div>
      </div>
    );
  }

  const ended = !running && run.state !== undefined;
  if (ended && !showSteps) return <SummaryScreen nav={nav} run={run} onShowSteps={() => setShowSteps(true)} />;

  const viewing = pinned ?? (run.question?.at && run.question.at !== run.current ? run.question.at : run.current);
  const total = run.steps.length;
  const finished = doneCount(run);
  const curIdx = run.steps.findIndex((s) => s.id === run.current);
  const aiMode = !!aiRequested || run.ai.length > 0;
  const step = run.steps.find((s) => s.id === viewing);
  const hasIntro = (run.logs[INTRO]?.length ?? 0) > 0;

  return (
    <div className={"run" + (aiMode ? " with-ai" : "")}>
      <div className="run-head">
        <div className="run-title">
          <div className="eyebrow">{ended ? "Setup log" : "Setting up"}</div>
          <h1>{MODE_TITLES[run.mode ?? ""] ?? run.mode}</h1>
        </div>
        <div className="run-meter" aria-label={`${finished} of ${total} steps finished`}>
          <span className="num">
            <b>{finished}</b>/{total || "–"}
          </span>
          <div className="meter">
            <div className="meter-fill" style={{ width: total ? `${(finished / total) * 100}%` : 0 }} />
          </div>
        </div>
        {running ? (
          <Button variant="ghost" icon="stop" onClick={() => setConfirmCancel(true)}>
            Cancel
          </Button>
        ) : (
          <Button variant="secondary" icon="chevron" onClick={() => setShowSteps(false)}>
            Back to summary
          </Button>
        )}
      </div>

      <div className="run-body">
        <nav className="rail" aria-label="Steps">
          <ol>
            {hasIntro && (
              <li>
                <button type="button" className={"rail-step intro" + (viewing === INTRO ? " viewing" : "")} onClick={() => setPinned(INTRO)}>
                  <StateIcon tone={run.steps.some((s) => s.state !== "pending") ? "ok" : "running"} size={20} />
                  <span className="rail-text">
                    <span className="rail-title">Overview</span>
                  </span>
                </button>
              </li>
            )}
            {run.steps.map((s, i) => (
              <RailStep key={s.id} step={s} n={i + 1} current={s.id === run.current && running} viewing={s.id === viewing} now={now} onClick={() => setPinned(s.id === run.current ? null : s.id)} />
            ))}
          </ol>
        </nav>

        <section className="pane" aria-label="Step details">
          <div className="pane-head">
            {viewing === INTRO || !step ? (
              <>
                <div className="pane-kicker">Overview</div>
                <h2>{total ? `${total} steps, each checked before anything changes` : "Before we start"}</h2>
              </>
            ) : (
              <>
                <div className="pane-kicker num">
                  Step {run.steps.indexOf(step) + 1} of {total}
                  {step.state === "pending" && run.question?.at === step.id ? (
                    <span className="step-pill sp-running">Your answer</span>
                  ) : (
                    <span className={`step-pill sp-${step.state}`}>{STEP_WORD[step.state]}</span>
                  )}
                  {pinned && pinned !== run.current && running && (
                    <button type="button" className="link-btn small" onClick={() => setPinned(null)}>
                      Follow current step ({curIdx + 1})
                    </button>
                  )}
                </div>
                <h2>{step.title}</h2>
                {step.summary && <p className="pane-sub">{step.summary}</p>}
              </>
            )}
          </div>
          <LogPane entries={run.logs[viewing] ?? []} key={viewing} failed={step?.state === "failed"} skip={step?.summary} title={step?.title} />
          {run.progress[viewing] && <ProgressBar p={run.progress[viewing]!} />}
          {run.question && <QuestionCard q={run.question} key={run.question.id} failed={run.steps.find((s) => s.id === run.question!.at)?.state === "failed"} />}
          {running && !run.question && !run.progress[viewing] && viewing === run.current && step && (step.state === "running" || step.state === "checking") && (
            <div className="working">
              <Spinner size={14} /> {step.state === "checking" ? "Checking what's already there…" : "Working…"}
            </div>
          )}
        </section>

        {aiMode && <AiPanel messages={run.ai} onSend={onLocalAi} running={running} />}
      </div>

      {confirmCancel && (
        <Dialog
          title="Stop this setup?"
          confirmLabel="Stop setup"
          danger
          onCancel={() => setConfirmCancel(false)}
          onConfirm={() => {
            setConfirmCancel(false);
            void api.cancel().catch(() => undefined);
          }}
        >
          The step that is running finishes first. Everything done so far is kept, and running setup again continues where it stopped.
        </Dialog>
      )}
    </div>
  );
}

function RailStep({ step, n, current, viewing, now, onClick }: { step: StepView; n: number; current: boolean; viewing: boolean; now: number; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: "center" });
  }, [current]);
  const dur = step.startedAt ? (step.endedAt ?? (current ? now : undefined)) : undefined;
  const ms = dur !== undefined && step.startedAt ? Math.max(0, dur - step.startedAt) : undefined;
  return (
    <li>
      <button
        ref={ref}
        type="button"
        className={`rail-step rs-${step.state}` + (current ? " current" : "") + (viewing ? " viewing" : "")}
        onClick={onClick}
        aria-current={current ? "step" : undefined}
        title={step.detail ?? step.title}
      >
        <StateIcon tone={STEP_TONE[step.state]} size={20} label={STEP_WORD[step.state]} />
        <span className="rail-n num">{n}</span>
        <span className="rail-text">
          <span className="rail-title">{step.title}</span>
          {step.detail && (current || step.state === "failed" || step.state === "manual" || viewing) && <span className="rail-detail">{step.detail}</span>}
        </span>
        {ms !== undefined && ms >= 1000 && step.state !== "pending" && <span className="rail-dur num">{fmtDuration(ms)}</span>}
      </button>
    </li>
  );
}

function LogPane({ entries, failed, skip, title }: { entries: LogEntry[]; failed?: boolean; skip?: string; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  // the rail and the pane header already show "3/13 Title" and the step's why
  const same = (a: string, b?: string) => !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const kept = entries.filter(
    (e) => !(e.level === "heading" && (isStepHeading(e.text) || same(e.text, title))) && !(e.level === "info" && same(e.text, skip)),
  );
  // no blank lines at the top
  const first = kept.findIndex((e) => !(e.level === "line" && !e.text.trim()));
  const shown = first < 0 ? [] : kept.slice(first);
  return (
    <div
      className={"log" + (failed ? " failed" : "")}
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      role="log"
      aria-live="polite"
    >
      {shown.length === 0 && <div className="log-empty">Nothing here yet.</div>}
      {shown.map((e) => (
        <LogLine key={e.n} e={e} />
      ))}
    </div>
  );
}

function LogLine({ e }: { e: LogEntry }) {
  const text = e.text.replace(/^\s+/, "");
  switch (e.level) {
    case "heading":
      return <h3 className="log-h">{text}</h3>;
    case "ok":
      return (
        <div className="log-row lv-ok">
          <Icon name="check" size={15} stroke={2.6} />
          <span>
            <Linkify text={text} />
          </span>
        </div>
      );
    case "warn":
      return (
        <div className="log-row lv-warn">
          <span className="lv-glyph">!</span>
          <span>
            <Linkify text={text} />
          </span>
        </div>
      );
    case "err":
      return (
        <div className="log-row lv-err" role="alert">
          <Icon name="x" size={15} stroke={2.6} />
          <span>
            <Linkify text={text} />
          </span>
        </div>
      );
    case "info":
      return (
        <div className="log-row lv-info">
          <span className="lv-dot" />
          <span>
            <Linkify text={text} />
          </span>
        </div>
      );
    case "code":
      return (
        <div className="log-code">
          <pre>{e.text.split("\n").map((l) => l.replace(/^ {4}/, "")).join("\n")}</pre>
          <CopyButton iconOnly text={e.text.split("\n").map((l) => l.replace(/^ {4}/, "")).join("\n")} />
        </div>
      );
    case "steps":
      return (
        <ol className="log-steps">
          {(e.items ?? [text]).map((it, i) => (
            <li key={i}>
              <Linkify text={it} />
            </li>
          ))}
        </ol>
      );
    default:
      if (!text) return <div className="log-gap" />;
      return (
        <div className={"log-row lv-line" + (/:$/.test(text) ? " label" : "")}>
          <span>
            <Linkify text={text} />
          </span>
        </div>
      );
  }
}

function ProgressBar({ p }: { p: { label: string; pct?: number } }) {
  const det = typeof p.pct === "number";
  return (
    <div className="progress" role="progressbar" aria-label={p.label} aria-valuenow={det ? Math.round(p.pct!) : undefined} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-top">
        <span>{p.label}</span>
        {det && <span className="num">{Math.round(p.pct!)}%</span>}
      </div>
      <div className={"bar" + (det ? "" : " indeterminate")}>
        <div className="bar-fill" style={det ? { width: `${Math.max(2, Math.min(100, p.pct!))}%` } : undefined} />
      </div>
    </div>
  );
}

/* ---------------- questions ---------------- */

function QuestionCard({ q, failed }: { q: PendingQuestion; failed?: boolean }) {
  const layout = layoutFor(q);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  useEffect(() => setSending(false), [q.error]);

  const send = async (raw: string | boolean | number) => {
    const a = answerFor(q, raw);
    if ("error" in a) {
      setSendErr(a.error);
      return false;
    }
    setSending(true);
    setSendErr(null);
    try {
      await api.answer(q.id, a.value);
      return true;
    } catch (e) {
      setSendErr((e as Error).message);
      setSending(false);
      return false;
    }
  };

  const error = sendErr ?? q.error;
  return (
    <div className={"question" + (failed ? " q-failed" : "")} role="group" aria-labelledby={`q-${q.id}`}>
      <div className="q-head">
        <span className="q-icon">{failed ? <Icon name="alert" size={16} /> : <Icon name="chevron" size={16} stroke={2.4} />}</span>
        <h3 id={`q-${q.id}`}>{q.message}</h3>
        {sending && <Spinner size={14} />}
      </div>
      {layout === "buttons" && <ChoiceButtons q={q} disabled={sending} onPick={(i) => send(i)} />}
      {layout === "list" && <ChoiceList q={q} disabled={sending} onPick={(i) => send(i)} />}
      {(layout === "text" || layout === "password") && <TextAnswer q={q} secret={layout === "password"} disabled={sending} error={error} onSubmit={send} />}
      {layout === "confirm" && <ConfirmAnswer q={q} disabled={sending} onPick={(v) => send(v)} />}
      {error && layout !== "text" && layout !== "password" && (
        <div className="inline-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function ChoiceButtons({ q, disabled, onPick }: { q: PendingQuestion; disabled: boolean; onPick: (i: number) => void }) {
  const choices = q.choices ?? [];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const start = defaultChoiceIndex(q);
  useEffect(() => {
    if (canSteal()) refs.current[start]?.focus();
  }, [start]);
  return (
    <div
      className={"choices" + (choices.length <= 3 && choices.every((c) => splitChoice(c).title.length < 26 && !splitChoice(c).hint) ? " inline" : "")}
      onKeyDown={(e) => {
        const n = shortcutIndex(e.key, choices.length);
        if (n !== undefined && !disabled) {
          e.preventDefault();
          onPick(n);
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const cur = refs.current.findIndex((r) => r === document.activeElement);
          const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
          refs.current[(cur + d + choices.length) % choices.length]?.focus();
        }
      }}
    >
      {choices.map((c, i) => {
        const { title, hint } = splitChoice(c);
        return (
          <button key={c.value + i} ref={(el) => (refs.current[i] = el)} type="button" className={"choice" + (i === start ? " is-default" : "")} disabled={disabled} onClick={() => onPick(i)}>
            <span className="choice-key num">{i + 1}</span>
            <span className="choice-text">
              <span className="choice-title">{title}</span>
              {hint && <span className="choice-hint">{hint}</span>}
            </span>
            <Icon name="chevron" size={16} stroke={2.2} className="choice-go" />
          </button>
        );
      })}
    </div>
  );
}

function ChoiceList({ q, disabled, onPick }: { q: PendingQuestion; disabled: boolean; onPick: (i: number) => void }) {
  const choices = q.choices ?? [];
  const [sel, setSel] = useState(defaultChoiceIndex(q));
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const visible = useMemo(() => choices.map((c, i) => ({ c, i })).filter(({ c }) => !filter || (c.name + " " + (c.description ?? "")).toLowerCase().includes(filter.toLowerCase())), [choices, filter]);
  useEffect(() => {
    if (canSteal()) listRef.current?.focus();
  }, []);
  useEffect(() => {
    listRef.current?.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const move = (d: number) => {
    const pos = visible.findIndex((v) => v.i === sel);
    const next = visible[Math.max(0, Math.min(visible.length - 1, pos + d))];
    if (next) setSel(next.i);
  };
  return (
    <div className="choice-list-wrap">
      {choices.length > 8 && <input className="list-filter" type="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => (e.key === "ArrowDown" ? (e.preventDefault(), listRef.current?.focus()) : e.key === "Enter" ? (e.preventDefault(), visible[0] && onPick(visible[0].i)) : undefined)} />}
      <ul
        className="choice-list"
        role="listbox"
        tabIndex={0}
        ref={listRef}
        aria-activedescendant={`opt-${q.id}-${sel}`}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), move(1));
          else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
          else if (e.key === "Enter" && !disabled) (e.preventDefault(), onPick(sel));
        }}
      >
        {visible.map(({ c, i }) => {
          const { title, hint } = splitChoice(c);
          return (
            <li key={c.value + i} id={`opt-${q.id}-${i}`} role="option" aria-selected={sel === i} className={sel === i ? "selected" : ""} onClick={() => setSel(i)} onDoubleClick={() => !disabled && onPick(i)}>
              <span className="radio-dot" aria-hidden />
              <span className="choice-text">
                <span className="choice-title">{title}</span>
                {hint && <span className="choice-hint">{hint}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="q-actions">
        <span className="hint">↑ ↓ to move, Enter to choose</span>
        <Button variant="primary" disabled={disabled} onClick={() => onPick(sel)}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function TextAnswer({ q, secret, disabled, error, onSubmit }: { q: PendingQuestion; secret: boolean; disabled: boolean; error?: string | null; onSubmit: (v: string) => Promise<boolean> }) {
  const [v, setV] = useState(initialText(q));
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (q.error || canSteal()) ref.current?.focus();
    if (q.error && secret) setV("");
    if (q.error) ref.current?.select();
  }, [q.error, secret]);
  const submit = async () => {
    if (disabled) return;
    const ok = await onSubmit(v);
    if (ok && secret) setV("");
  };
  return (
    <form
      className="text-answer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className={"input-wrap" + (error ? " has-err" : "")}>
        <input
          ref={ref}
          type={secret && !show ? "password" : "text"}
          value={v}
          onChange={(e) => setV(e.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={error ? `qe-${q.id}` : undefined}
          placeholder={secret ? "Hidden as you type" : typeof q.default === "string" ? q.default : ""}
        />
        {secret && (
          <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide" : "Show"} title={show ? "Hide" : "Show"}>
            <Icon name={show ? "eyeoff" : "eye"} size={17} />
          </button>
        )}
      </div>
      <Button variant="primary" type="submit" disabled={disabled}>
        Continue
      </Button>
      {error && (
        <div className="inline-err field-err" id={`qe-${q.id}`} role="alert">
          {error}
        </div>
      )}
      {!error && <div className="hint field-hint">{secret ? "Press Enter to continue. It is never shown in the log." : "Press Enter to continue."}</div>}
    </form>
  );
}

function ConfirmAnswer({ q, disabled, onPick }: { q: PendingQuestion; disabled: boolean; onPick: (v: boolean) => void }) {
  const def = confirmDefault(q);
  const yes = useRef<HTMLButtonElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (canSteal()) (def ? yes : no).current?.focus();
  }, [def]);
  return (
    <div
      className="confirm"
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "y" || e.key === "Y") (e.preventDefault(), onPick(true));
        else if (e.key === "n" || e.key === "N") (e.preventDefault(), onPick(false));
        else if (e.key === "ArrowLeft" || e.key === "ArrowRight") (e.preventDefault(), (document.activeElement === yes.current ? no : yes).current?.focus());
      }}
    >
      <button ref={yes} type="button" className={"btn btn-lg " + (def ? "btn-primary" : "btn-secondary")} disabled={disabled} onClick={() => onPick(true)}>
        <Icon name="check" size={18} stroke={2.4} />
        <span>Yes</span>
        <kbd>Y</kbd>
      </button>
      <button ref={no} type="button" className={"btn btn-lg " + (!def ? "btn-primary" : "btn-secondary")} disabled={disabled} onClick={() => onPick(false)}>
        <Icon name="x" size={18} stroke={2.4} />
        <span>No</span>
        <kbd>N</kbd>
      </button>
      <span className="hint">Default: {def ? "Yes" : "No"}</span>
    </div>
  );
}

/* ---------------- AI guide ---------------- */

function AiPanel({ messages, onSend, running }: { messages: SetupRunState["ai"]; onSend: (t: string) => void; running: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages.length]);
  const last = messages[messages.length - 1];
  const waiting = last?.role === "user";
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setErr(null);
    try {
      await api.aiMessage(t);
      onSend(t);
      setText("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="ai-panel" aria-label="AI guide">
      <div className="ai-panel-head">
        <Icon name="spark" size={16} />
        <b>AI guide</b>
        <span className="muted small">can't see passwords</span>
      </div>
      <div className="ai-msgs" ref={ref}>
        {messages.length === 0 && <div className="log-empty">The guide comments on each step as it goes. Ask it anything.</div>}
        {messages.map((m, i) =>
          m.role === "tool" ? (
            <div key={i} className="ai-tool">
              <Icon name="gear" size={13} />
              <span>{m.text}</span>
            </div>
          ) : (
            <div key={i} className={"ai-msg " + m.role}>
              <Linkify text={m.text} />
            </div>
          ),
        )}
        {waiting && (
          <div className="ai-typing">
            <Spinner size={12} /> thinking…
          </div>
        )}
      </div>
      <form
        className="ai-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          rows={2}
          value={text}
          placeholder={running ? "Ask the guide…  (Enter to send)" : "The run has ended"}
          disabled={!running || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label="Message to the AI guide"
        />
        <Button variant="primary" type="submit" icon="send" disabled={!running || !text.trim()} busy={busy} aria-label="Send" />
        {err && <div className="inline-err">{err}</div>}
      </form>
    </aside>
  );
}

/* ---------------- summary ---------------- */

function SummaryScreen({ nav, run, onShowSteps }: { nav: Nav; run: SetupRunState; onShowSteps: () => void }) {
  const ok = run.state === "done" && !run.steps.some((s) => s.state === "failed");
  const counts = { done: 0, skipped: 0, failed: 0, manual: 0, pending: 0 };
  for (const s of run.steps) {
    if (s.state === "done") counts.done++;
    else if (s.state === "skipped") counts.skipped++;
    else if (s.state === "failed") counts.failed++;
    else if (s.state === "manual") counts.manual++;
    else counts.pending++;
  }
  const headline = run.state === "cancelled" ? "Setup stopped" : ok ? "All set" : "Finished, with something to look at";
  const sub =
    run.state === "cancelled"
      ? "Everything done so far is kept. Run setup again to continue where it stopped."
      : ok
        ? "Write down the password, then open the dashboard. Tablets show a 6-digit code to approve on the admin page."
        : "Run setup again to finish the remaining steps; finished ones are not repeated.";
  return (
    <div className="screen summary-screen">
      <div className={"summary-hero" + (ok ? " good" : run.state === "cancelled" ? " stopped" : " partial")}>
        <StateIcon tone={ok ? "ok" : run.state === "cancelled" ? "stopped" : "warn"} size={44} />
        <div>
          <div className="eyebrow">{MODE_TITLES[run.mode ?? ""] ?? run.mode}</div>
          <h1>{headline}</h1>
          <p className="lede">{sub}</p>
        </div>
      </div>

      {run.summary && run.summary.length > 0 && (
        <ul className="summary-list">
          {run.summary.map((it, i) => (
            <SummaryRow key={i} it={it} />
          ))}
        </ul>
      )}

      <div className="summary-steps">
        <div className="step-counts num">
          <span className="sc t-ok">
            <StateIcon tone="ok" size={16} /> {counts.done} done
          </span>
          {counts.skipped > 0 && (
            <span className="sc">
              <StateIcon tone="skipped" size={16} /> {counts.skipped} skipped
            </span>
          )}
          {counts.manual > 0 && (
            <span className="sc">
              <StateIcon tone="manual" size={16} /> {counts.manual} need you
            </span>
          )}
          {counts.failed > 0 && (
            <span className="sc t-fail">
              <StateIcon tone="fail" size={16} /> {counts.failed} failed
            </span>
          )}
          {counts.pending > 0 && <span className="sc muted">{counts.pending} not reached</span>}
        </div>
        <div className="row-gap">
          <Button variant="ghost" icon="list" onClick={onShowSteps}>
            Show steps and log
          </Button>
          <Button icon="check" onClick={() => nav.go("check")}>
            Check again
          </Button>
          <Button variant="primary" icon="sliders" onClick={() => nav.go("control")}>
            Open Control
          </Button>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ it }: { it: SummaryItem }) {
  const [reveal, setReveal] = useState(false);
  const hidden = it.secret && !reveal;
  return (
    <li className={"summary-row" + (it.secret ? " secret" : "")}>
      <div className="sr-label">{it.label}</div>
      <div className={"sr-value num" + (hidden ? " masked" : "")} aria-label={hidden ? `${it.label} (hidden)` : undefined}>
        {hidden ? "•".repeat(Math.min(16, Math.max(8, it.value.length))) : it.value}
      </div>
      <div className="sr-actions">
        {it.secret && (
          <Button size="sm" variant="ghost" icon={reveal ? "eyeoff" : "eye"} onClick={() => setReveal((r) => !r)}>
            {reveal ? "Hide" : "Reveal"}
          </Button>
        )}
        <CopyButton text={it.value} />
        {it.href && (
          <Button size="sm" variant="secondary" icon="external" onClick={() => window.open(it.href, "_blank", "noopener")}>
            Open
          </Button>
        )}
      </div>
    </li>
  );
}
