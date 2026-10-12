import { useEffect, useMemo, useState } from "react";
import { parse as parseYaml, stringify } from "yaml";
import { ServerConfigFileSchema } from "@homepanel/protocol";
import { api, ApiError } from "./api";
import { toast } from "../lib/toast";
import { Icon } from "../icons";

const HELP = `# Doorbells: when "ring" turns on, screens show the camera full-screen.
# doorbells:
#   front:
#     provider: reolink
#     name: Front door
#     ring: binary_sensor.front_door_visitor
#     camera: camera.front_door
`;

export function ConfigTab() {
  const [orig, setOrig] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api<unknown>("GET", "/api/admin/config");
      const y = typeof r === "string" ? r : stringify(r ?? {});
      setOrig(y);
      setText(y);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => void load(), []);

  const local = useMemo(() => {
    try {
      const raw = parseYaml(text) ?? {};
      const r = ServerConfigFileSchema.safeParse(raw);
      return r.success ? [] : r.error.issues.map((i) => (i.path.join(".") || "config") + ": " + i.message);
    } catch (e) {
      return ["YAML: " + (e as Error).message.split("\n")[0]];
    }
  }, [text]);
  const errors = serverErrors ?? local;
  const dirty = orig != null && text !== orig;

  const save = async () => {
    setBusy(true);
    setServerErrors(null);
    try {
      const r = await api<{ ok: boolean; errors?: string[] }>("PUT", "/api/admin/config", text, "text/yaml");
      if (r && r.ok === false) setServerErrors(r.errors ?? ["Rejected"]);
      else { toast("Config saved", "ok"); setOrig(text); }
    } catch (e) {
      setServerErrors(((e instanceof ApiError && (e.body as any)?.errors) as string[]) ?? [(e as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Doorbells & config</h1>
        <p>Server settings: doorbells, what happens on a ring, Fully Kiosk wake-up and the assistant's AI provider. Secrets show as redacted — leave them as they are to keep them.</p>
      </div>
      {err && <div className="form-err">{err}</div>}
      <textarea className="code tall" spellCheck={false} value={text} placeholder={HELP} onChange={(e) => { setText(e.target.value); setServerErrors(null); }} aria-label="config.yaml" />
      <div className={"validate " + (errors.length ? "bad" : "good")}>
        {errors.length ? <><b>{errors.length} problem{errors.length > 1 ? "s" : ""}</b><ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></> : <><Icon name="check" size={18} /> Valid{dirty ? " — not saved yet" : ""}</>}
      </div>
      <div className="actions-row">
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={!dirty} onClick={() => orig != null && setText(orig)}>Revert</button>
        <button className="btn primary" disabled={busy || !dirty || local.length > 0} onClick={save}>{busy && <span className="spinner" />} Save</button>
      </div>
      <details className="help">
        <summary>Example doorbell</summary>
        <pre className="snippet">{HELP.replace(/^# ?/gm, "")}</pre>
      </details>
    </div>
  );
}
