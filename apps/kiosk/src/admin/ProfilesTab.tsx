import { useEffect, useMemo, useState } from "react";
import { parse as parseYaml } from "yaml";
import { ProfileSchema } from "@homepanel/protocol";
import type { Profile } from "@homepanel/protocol";
import { api, ApiError } from "./api";
import { ProfileRow, useResource } from "./hooks";
import { toast } from "../lib/toast";
import { parseWidget } from "../sdk";
import { registry } from "../widgets";
import { ConfirmSheet } from "../components";
import { Icon } from "../icons";

const TEMPLATE = (id: string) => `id: ${id}
name: New screen
grid: { cols: 6, rows: 4 }
theme: dark
lite: false
widgets:
  - type: clock
    at: [0, 0, 3, 2]
    showDate: true
  - type: text
    at: [3, 0, 3, 2]
    text: Hello from HomePanel
    size: l
  - type: lights
    at: [0, 2, 6, 2]
    entities: [light.living_room]
`;

/** Validate YAML locally: syntax, profile schema, each widget's own config schema. */
export function validateProfileYaml(text: string): { profile: Profile | null; errors: string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return { profile: null, errors: ["YAML: " + (e as Error).message.split("\n")[0]] };
  }
  const r = ProfileSchema.safeParse(raw);
  if (!r.success) return { profile: null, errors: r.error.issues.map((i) => (i.path.join(".") || "profile") + ": " + i.message) };
  const errors: string[] = [];
  r.data.widgets.forEach((w, i) => {
    const pw = parseWidget(registry, w);
    const where = `widgets[${i}] (${w.type}${w.id ? " #" + w.id : ""})`;
    if (!pw.ok && pw.reason === "unknown") errors.push(`${where}: unknown widget type`);
    if (!pw.ok && pw.reason === "invalid") pw.errors.forEach((e) => errors.push(`${where}: ${e}`));
    const [c, row, cw, rh] = w.at;
    if (c + cw > r.data.grid.cols || row + rh > r.data.grid.rows) errors.push(`${where}: at ${JSON.stringify(w.at)} runs off the ${r.data.grid.cols}×${r.data.grid.rows} grid`);
  });
  if (r.data.idle?.show && !r.data.widgets.some((w) => w.id === r.data.idle!.show)) errors.push(`idle.show: no widget has id "${r.data.idle.show}"`);
  return { profile: r.data, errors };
}

/** The one config value that identifies a widget in the schematic. */
function detail(w: Record<string, unknown>): string {
  for (const k of ["entity", "pc", "src", "text"]) if (typeof w[k] === "string") return String(w[k]);
  if (Array.isArray(w.entities)) return (w.entities as string[]).join(", ");
  if (Array.isArray(w.buttons)) return (w.buttons as unknown[]).length + " buttons";
  if (w.type === "lights") return "all lights";
  return "";
}

function Preview({ profile }: { profile: Profile | null }) {
  if (!profile) return <div className="preview empty-state">Fix the errors to see a preview.</div>;
  const { cols, rows } = profile.grid;
  return (
    <div className="preview-wrap">
      <div className={"preview theme-" + profile.theme} style={{ aspectRatio: `${cols * 1.25} / ${rows}`, gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
        {profile.widgets.map((w, i) => {
          const pw = parseWidget(registry, w);
          return (
            <div key={i} className={"pv-cell" + (pw.ok ? "" : " bad")} style={{ gridColumn: `${w.at[0] + 1} / span ${w.at[2]}`, gridRow: `${w.at[1] + 1} / span ${w.at[3]}` }}>
              <span className="pv-line" title={w.type}><b>{w.title ?? w.type}</b>{w.title ? " · " + w.type : ""}{w.id ? " #" + w.id : ""}</span>
              {detail(w) && <span className="pv-line pv-detail">{detail(w)}</span>}
            </div>
          );
        })}
      </div>
      <div className="pv-meta">{cols}×{rows} grid · {profile.theme} theme{profile.lite ? " · lite" : ""}{profile.idle?.show ? ` · idle → #${profile.idle.show} after ${profile.idle.after}` : ""}</div>
    </div>
  );
}

function Editor({ row, isNew, onSaved, onDeleted }: { row: ProfileRow; isNew: boolean; onSaved: (id: string) => void; onDeleted: () => void }) {
  const [text, setText] = useState(row.yaml);
  const [serverErrors, setServerErrors] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  useEffect(() => { setText(row.yaml); setServerErrors(null); }, [row.id, row.yaml]);
  const v = useMemo(() => validateProfileYaml(text), [text]);
  const dirty = text !== row.yaml || isNew;

  const save = async () => {
    if (!v.profile) return;
    setBusy(true);
    setServerErrors(null);
    try {
      const r = await api<{ ok: boolean; errors?: string[] }>("PUT", `/api/admin/profiles/${encodeURIComponent(v.profile.id)}`, text, "text/yaml");
      if (r && r.ok === false) setServerErrors(r.errors ?? ["Server rejected the profile"]);
      else { toast("Saved " + v.profile.name, "ok"); onSaved(v.profile.id); }
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as any) : null;
      setServerErrors(body?.errors ?? [(e as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  const errors = serverErrors ?? v.errors;
  return (
    <div className="editor-split">
      <div className="editor-col">
        <textarea className="code" spellCheck={false} value={text} onChange={(e) => { setText(e.target.value); setServerErrors(null); }}
          aria-label="Profile YAML" autoCapitalize="off" autoCorrect="off" />
        <div className={"validate " + (errors.length ? "bad" : "good")}>
          {errors.length ? (
            <><b>{errors.length} problem{errors.length > 1 ? "s" : ""}</b><ul>{errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}</ul></>
          ) : (
            <><Icon name="check" size={18} /> Looks good{dirty ? " — not saved yet" : ""}</>
          )}
        </div>
        <div className="actions-row">
          {!isNew && <button className="btn ghost" onClick={() => setDel(true)}><Icon name="trash" size={18} /> Delete</button>}
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={!dirty} onClick={() => setText(row.yaml)}>Revert</button>
          <button className="btn primary" disabled={busy || !v.profile || v.errors.length > 0 || !dirty} onClick={save}>{busy && <span className="spinner" />} Save</button>
        </div>
      </div>
      <div className="preview-col">
        <h3>Preview</h3>
        <Preview profile={v.profile} />
      </div>
      {del && (
        <ConfirmSheet title={`Delete “${row.name}”?`} body="Screens using it will need another profile." confirmLabel="Delete" danger onCancel={() => setDel(false)}
          onConfirm={async () => {
            setDel(false);
            try { await api("DELETE", `/api/admin/profiles/${encodeURIComponent(row.id)}`); toast("Deleted " + row.name, "ok"); onDeleted(); }
            catch (e) { toast((e as Error).message, "error"); }
          }} />
      )}
    </div>
  );
}

export function ProfilesTab() {
  const { data, error, reload } = useResource<ProfileRow[]>("/api/admin/profiles");
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProfileRow | null>(null);
  const list = data ?? [];
  const sel = draft ?? list.find((p) => p.id === selId) ?? list[0] ?? null;

  const newProfile = () => {
    let n = 1;
    while (list.some((p) => p.id === "screen-" + n)) n++;
    setDraft({ id: "screen-" + n, name: "New screen", yaml: TEMPLATE("screen-" + n) });
  };

  return (
    <div className="page wide">
      <div className="page-head">
        <h1>Profiles</h1>
        <p>A profile is a layout. Screens that share a profile show the same widgets.</p>
      </div>
      {error && <div className="form-err">{error}</div>}
      <div className="chips">
        {list.map((p) => (
          <button key={p.id} className={"chip" + (!draft && sel?.id === p.id ? " active" : "")} onClick={() => { setDraft(null); setSelId(p.id); }}>{p.name}</button>
        ))}
        {draft && <button className="chip active">{draft.name} (new)</button>}
        <button className="chip add" onClick={newProfile}><Icon name="plus" size={16} /> New profile</button>
      </div>
      {sel ? (
        <Editor key={sel.id + (draft ? ":new" : "")} row={sel} isNew={!!draft}
          onSaved={(id) => { setDraft(null); setSelId(id); void reload(); }}
          onDeleted={() => { setSelId(null); void reload(); }} />
      ) : (
        <div className="empty-state">No profiles yet. Create one to get started.</div>
      )}
    </div>
  );
}
