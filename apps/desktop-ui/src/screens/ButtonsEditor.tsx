import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { api, describeTestResult } from "../lib/api";
import {
  ACTION_TYPES,
  GUARDS,
  SYSTEM_COMMANDS,
  TYPE_INFO,
  deleteAction,
  describeAction,
  emptyDraft,
  errorsByAction,
  listActions,
  moveAction,
  parseAgentYaml,
  stringify,
  suggestId,
  upsertAction,
  validateDraft,
  type ActionDraft,
  type ActionType,
  type Guard,
} from "../lib/agentConfig";
import { Badge, Button, Dialog, Spinner } from "../ui";

const TYPE_ICON: Record<ActionType, string> = { open: "folder", launch: "play", keys: "keyboard", script: "terminal", url: "globe", system: "power" };
const GUARD_TEXT: Record<Guard, string> = { confirm: "Ask first", "home-only": "Home only", "confirm+home-only": "Ask first · home only" };
const EMOJI = ["💽", "💾", "📁", "📥", "🎮", "🧱", "💬", "🎵", "⏯️", "⏭️", "🔊", "🔉", "🎙️", "🎧", "🖥️", "🔒", "😴", "🔄", "⏻", "🌐", "⚡", "🛠️"];
const KEY_PRESETS = ["media_play_pause", "media_next", "media_prev", "volume_up", "volume_down", "volume_mute", "ctrl+shift+m", "win+d"];
const SYS_TEXT: Record<string, string> = { lock: "Lock", sleep: "Sleep", restart: "Restart", shutdown: "Shut down", "monitors-off": "Screens off" };

export function ButtonsEditor() {
  const [path, setPath] = useState<string>("");
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState<string>("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"visual" | "yaml">("visual");
  const [drawer, setDrawer] = useState<{ draft: ActionDraft; prevId?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<{ byId: Record<string, string[]>; general: string[] } | null>(null);
  const [savedMsg, setSavedMsg] = useState<false | string>(false);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { busy?: boolean; ok?: boolean; text?: string }>>({});
  const [yamlErr, setYamlErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.agentConfig();
      setPath(r.path);
      setSaved(r.yaml);
      setText(r.yaml);
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const parsed = useMemo(() => parseAgentYaml(text), [text]);
  const actions = useMemo(() => (parsed.error ? [] : listActions(parsed.doc)), [parsed]);
  const dirty = saved !== null && text !== saved;

  const edit = (fn: (doc: ReturnType<typeof parseAgentYaml>["doc"]) => void) => {
    const { doc, error } = parseAgentYaml(text);
    if (error) return;
    fn(doc);
    setText(stringify(doc));
    setSaveErr(null);
    setSavedMsg(false);
  };

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await api.saveAgentConfig(text);
      if (r.ok) {
        setSaved(text);
        setSavedMsg(r.warning ?? (r.restarted === false ? "Saved. Restart the agent to use the new buttons." : "Saved. The agent restarted with the new buttons."));
        setTimeout(() => setSavedMsg(false), r.warning ? 9000 : 4000);
      } else setSaveErr(errorsByAction(r.errors));
    } catch (e) {
      setSaveErr({ byId: {}, general: [(e as Error).message] });
    } finally {
      setSaving(false);
    }
  };

  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: { busy: true } }));
    try {
      const r = describeTestResult(await api.testAction(id, false));
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, text: (e as Error).message } }));
    }
  };

  if (loadErr)
    return (
      <div className="callout callout-crit">
        <Icon name="alert" size={18} />
        <span>
          Could not read agent.yaml: {loadErr}{" "}
          <button type="button" className="link-btn" onClick={() => void load()}>
            Try again
          </button>
        </span>
      </div>
    );
  if (saved === null)
    return (
      <div className="muted-row">
        <Spinner /> Loading buttons…
      </div>
    );

  const savedIds = saved ? (parseAgentYaml(saved).error ? [] : listActions(parseAgentYaml(saved).doc).map((a) => a.id)) : [];

  return (
    <div className="buttons-editor">
      <div className="be-bar">
        <div className="be-path">
          <span className="muted">Buttons this PC can run, from</span> <code className="num">{path}</code>
        </div>
        <div className="be-tools">
          <div className="seg small" role="tablist" aria-label="Editor">
            <button type="button" role="tab" aria-selected={mode === "visual"} className={"seg-btn" + (mode === "visual" ? " active" : "")} onClick={() => (parsed.error ? setYamlErr(parsed.error) : (setYamlErr(null), setMode("visual")))}>
              <Icon name="grid" size={14} /> Visual
            </button>
            <button type="button" role="tab" aria-selected={mode === "yaml"} className={"seg-btn" + (mode === "yaml" ? " active" : "")} onClick={() => setMode("yaml")}>
              <Icon name="code" size={14} /> Edit YAML
            </button>
          </div>
          {mode === "visual" && (
            <Button variant="primary" size="sm" icon="plus" onClick={() => setDrawer({ draft: emptyDraft("open") })}>
              Add button
            </Button>
          )}
        </div>
      </div>

      {mode === "visual" ? (
        <ul className="action-list" aria-label="Buttons">
          {actions.length === 0 && <li className="empty-state">No buttons yet. Add one: open a drive, start Steam, mute the mic…</li>}
          {actions.map((a, i) => {
            const errs = saveErr?.byId[a.id];
            const t = tests[a.id];
            const unsaved = !savedIds.includes(a.id);
            return (
              <li key={a.id} className={"action-row" + (errs ? " has-err" : "")}>
                <div className="order">
                  <button type="button" className="icon-btn" aria-label={`Move ${a.label ?? a.id} up`} disabled={i === 0} onClick={() => edit((d) => moveAction(d, a.id, -1))}>
                    <Icon name="up" size={14} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Move ${a.label ?? a.id} down`} disabled={i === actions.length - 1} onClick={() => edit((d) => moveAction(d, a.id, 1))}>
                    <Icon name="down" size={14} />
                  </button>
                </div>
                <span className="action-icon">{a.icon ? <span className="emoji">{a.icon}</span> : <Icon name={TYPE_ICON[a.type] ?? "box"} size={18} />}</span>
                <button type="button" className="action-main" onClick={() => setDrawer({ draft: { ...a }, prevId: a.id })}>
                  <span className="action-title">
                    {a.label ?? a.id}
                    {a.label && <span className="action-id">{a.id}</span>}
                    {unsaved && <Badge tone="muted">unsaved</Badge>}
                  </span>
                  <span className="action-desc">
                    <span className="type-tag">{a.type}</span>
                    {describeAction(a)}
                  </span>
                  {errs && <span className="inline-err small">{errs.join(" · ")}</span>}
                  {t && !t.busy && <span className={"test-out " + (t.ok ? "ok" : "bad")}>{t.text}</span>}
                </button>
                {a.guard && <Badge tone={a.guard.includes("confirm") ? "warn" : "muted"}>{GUARD_TEXT[a.guard] ?? a.guard}</Badge>}
                <div className="row-actions">
                  <Button size="sm" variant="ghost" icon="play" busy={t?.busy} disabled={unsaved} title={unsaved ? "Save first: the agent tests the saved file" : "Dry run: shows what it would do"} onClick={() => test(a.id)}>
                    Test
                  </Button>
                  <Button size="sm" variant="ghost" icon="pencil" aria-label={`Edit ${a.label ?? a.id}`} onClick={() => setDrawer({ draft: { ...a }, prevId: a.id })} />
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${a.label ?? a.id}`} className="danger-hover" onClick={() => setToDelete(a.id)} />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="yaml-mode">
          <textarea className="yaml-text" spellCheck={false} value={text} onChange={(e) => (setText(e.target.value), setYamlErr(null))} aria-label="agent.yaml" />
          {(parsed.error || yamlErr) && (
            <div className="inline-err" role="alert">
              YAML: {parsed.error ?? yamlErr}
            </div>
          )}
        </div>
      )}

      {(dirty || saveErr || savedMsg) && (
        <div className={"save-bar" + (saveErr ? " bad" : savedMsg && !dirty ? " good" : "")} role="status">
          <div className="save-msg">
            {saveErr ? (
              <>
                <b>Not saved.</b> {saveErr.general.length ? saveErr.general.join(" · ") : "Fix the highlighted buttons."}
              </>
            ) : dirty ? (
              <>
                <b>Unsaved changes.</b> Saving checks the file and restarts the agent.
              </>
            ) : (
              <>
                <Icon name="check" size={15} stroke={2.6} /> {savedMsg}
              </>
            )}
          </div>
          {dirty && (
            <>
              <Button variant="ghost" size="sm" onClick={() => (setText(saved!), setSaveErr(null))} disabled={saving}>
                Discard
              </Button>
              <Button variant="primary" size="sm" icon="check" busy={saving} disabled={!!parsed.error} onClick={save}>
                Save and restart agent
              </Button>
            </>
          )}
        </div>
      )}

      {drawer && (
        <ActionDrawer
          initial={drawer.draft}
          prevId={drawer.prevId}
          otherIds={actions.map((a) => a.id).filter((id) => id !== drawer.prevId)}
          onClose={() => setDrawer(null)}
          onApply={(d) => {
            edit((doc) => upsertAction(doc, d, drawer.prevId));
            setDrawer(null);
          }}
        />
      )}
      {toDelete && (
        <Dialog
          title={`Delete “${actions.find((a) => a.id === toDelete)?.label ?? toDelete}”?`}
          confirmLabel="Delete"
          cancelLabel="Keep it"
          danger
          onCancel={() => setToDelete(null)}
          onConfirm={() => {
            edit((d) => deleteAction(d, toDelete));
            setToDelete(null);
          }}
        >
          Dashboards with this button show it as unavailable until you add it again. Nothing changes until you save.
        </Dialog>
      )}
    </div>
  );
}

function ActionDrawer({ initial, prevId, otherIds, onClose, onApply }: { initial: ActionDraft; prevId?: string; otherIds: string[]; onClose: () => void; onApply: (d: ActionDraft) => void }) {
  const [d, setD] = useState<ActionDraft>(initial);
  const [idTouched, setIdTouched] = useState(!!prevId);
  const [showErr, setShowErr] = useState(false);
  const [argsText, setArgsText] = useState((initial.args ?? []).join("\n"));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<ActionDraft>) => setD((x) => ({ ...x, ...patch }));
  const errs = validateDraft(d, otherIds);
  const apply = () => {
    if (Object.keys(errs).length) {
      setShowErr(true);
      return;
    }
    onApply({ ...d, label: d.label?.trim() || undefined, icon: d.icon?.trim() || undefined });
  };
  const E = (k: keyof ActionDraft) => (showErr && errs[k] ? <em className="inline-err">{errs[k]}</em> : null);
  const setArgs = (t: string) => {
    setArgsText(t);
    set({ args: t.split("\n").map((s) => s.trim()).filter(Boolean) });
  };

  return (
    <div className="scrim drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="drawer-head">
          <h2 id="drawer-title">{prevId ? "Edit button" : "Add a button"}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="field-row">
            <label className="field icon-field">
              <span>Icon</span>
              <input value={d.icon ?? ""} onChange={(e) => set({ icon: e.target.value })} placeholder="🎮" maxLength={8} />
            </label>
            <label className="field grow">
              <span>Label</span>
              <input
                ref={first}
                value={d.label ?? ""}
                placeholder="e.g. Games drive"
                onChange={(e) => {
                  const label = e.target.value;
                  set({ label, ...(!idTouched ? { id: label ? suggestId(label, otherIds) : "" } : {}) });
                }}
              />
            </label>
          </div>
          <div className="emoji-row" aria-label="Quick icons">
            {EMOJI.map((em) => (
              <button key={em} type="button" className={"emoji-pick" + (d.icon === em ? " on" : "")} onClick={() => set({ icon: em })} aria-label={`Icon ${em}`}>
                {em}
              </button>
            ))}
          </div>

          <div className="field">
            <span>What it does</span>
            <div className="type-grid" role="radiogroup" aria-label="Type">
              {ACTION_TYPES.map((t) => (
                <button key={t} type="button" role="radio" aria-checked={d.type === t} className={"type-opt" + (d.type === t ? " on" : "")} onClick={() => set({ type: t, ...(t === "system" && !d.command ? { command: "lock" } : {}) })}>
                  <Icon name={TYPE_ICON[t]} size={17} />
                  <span>
                    <b>{TYPE_INFO[t].title}</b>
                    <small>{TYPE_INFO[t].hint}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {d.type === "open" && (
            <label className="field">
              <span>Folder or file</span>
              <input className="mono" value={d.path ?? ""} onChange={(e) => set({ path: e.target.value })} placeholder="D:\Games" spellCheck={false} />
              {E("path") ?? <em className="hint">%USERPROFILE%\Downloads and other %VARS% work.</em>}
            </label>
          )}
          {d.type === "launch" && (
            <>
              <label className="field">
                <span>Program</span>
                <input className="mono" value={d.exe ?? ""} onChange={(e) => set({ exe: e.target.value })} placeholder="steam://open/main  or  C:\Program Files\…\app.exe" spellCheck={false} />
                {E("exe") ?? <em className="hint">Full path (* wildcards pick the newest), a program name, or an app link.</em>}
              </label>
              <label className="field">
                <span>Arguments (one per line)</span>
                <textarea className="mono" rows={2} value={argsText} onChange={(e) => setArgs(e.target.value)} spellCheck={false} />
                {E("args")}
              </label>
            </>
          )}
          {d.type === "keys" && (
            <label className="field">
              <span>Keys</span>
              <input className="mono" value={d.keys ?? ""} onChange={(e) => set({ keys: e.target.value })} placeholder="media_play_pause" spellCheck={false} />
              <span className="chip-row">
                {KEY_PRESETS.map((k) => (
                  <button key={k} type="button" className={"mini-chip" + (d.keys === k ? " on" : "")} onClick={() => set({ keys: k })}>
                    {k}
                  </button>
                ))}
              </span>
              {E("keys")}
            </label>
          )}
          {d.type === "script" && (
            <>
              <label className="field">
                <span>Script</span>
                <input className="mono" value={d.script ?? ""} onChange={(e) => set({ script: e.target.value })} placeholder="scripts\mic-mute.ps1" spellCheck={false} />
                {E("script") ?? <em className="hint">.ps1, .cmd or .bat; relative paths are next to agent.yaml.</em>}
              </label>
              <div className="field-row">
                <label className="field grow">
                  <span>Arguments (one per line)</span>
                  <textarea className="mono" rows={2} value={argsText} onChange={(e) => setArgs(e.target.value)} spellCheck={false} />
                </label>
                <label className="field timeout-field">
                  <span>Timeout (s)</span>
                  <input
                    type="number"
                    min={1}
                    max={600}
                    value={d.timeoutMs ? d.timeoutMs / 1000 : ""}
                    placeholder="30"
                    onChange={(e) => set({ timeoutMs: e.target.value ? Math.round(Number(e.target.value) * 1000) : undefined })}
                  />
                  {E("timeoutMs")}
                </label>
              </div>
            </>
          )}
          {d.type === "url" && (
            <label className="field">
              <span>Link</span>
              <input className="mono" value={d.url ?? ""} onChange={(e) => set({ url: e.target.value })} placeholder="https://… or spotify:…" spellCheck={false} />
              {E("url")}
            </label>
          )}
          {d.type === "system" && (
            <div className="field">
              <span>Command</span>
              <div className="chip-row big" role="radiogroup" aria-label="Command">
                {SYSTEM_COMMANDS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={d.command === c} className={"mini-chip" + (d.command === c ? " on" : "")} onClick={() => set({ command: c, ...(c === "restart" || c === "shutdown" ? { guard: d.guard ?? "confirm+home-only" } : {}) })}>
                    {SYS_TEXT[c]}
                  </button>
                ))}
              </div>
              {E("command")}
            </div>
          )}

          <label className="field">
            <span>Safety</span>
            <select value={d.guard ?? ""} onChange={(e) => set({ guard: (e.target.value || undefined) as Guard | undefined })}>
              <option value="">None: runs on tap</option>
              {GUARDS.map((g) => (
                <option key={g} value={g}>
                  {g === "confirm" ? "Ask to confirm on the screen" : g === "home-only" ? "Only from the home network" : "Confirm, and home network only"}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Id</span>
            <input
              className="mono"
              value={d.id}
              onChange={(e) => {
                setIdTouched(true);
                set({ id: e.target.value });
              }}
              placeholder="open-games"
              spellCheck={false}
            />
            {E("id") ?? <em className="hint">What dashboards send. {prevId && prevId !== d.id ? "Renaming breaks buttons that use the old id." : "Lowercase, digits, - and _."}</em>}
          </label>
        </div>
        <div className="drawer-foot">
          <span className="drawer-preview">
            {d.icon && <span className="emoji">{d.icon}</span>}
            {describeAction(d)}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" icon="check">
            {prevId ? "Apply" : "Add"}
          </Button>
        </div>
      </form>
    </div>
  );
}
