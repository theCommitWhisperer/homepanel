import { useState } from "react";
import type { AgentSummary } from "@homepanel/protocol";
import { api } from "./api";
import { ago, useResource } from "./hooks";
import { toast } from "../lib/toast";
import { ConfirmSheet, Sheet } from "../components";
import { Icon } from "../icons";

function copy(text: string) {
  const done = () => toast("Copied", "ok", 1500);
  try {
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).then(done, () => fallback()); return; }
  } catch { /* fall through */ }
  fallback();
  function fallback() {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch { toast("Select the text and copy it manually", "error"); }
    document.body.removeChild(ta);
  }
}

export function agentYaml(pcId: string, name: string, key: string, host: string) {
  return `# agent.yaml for ${name}
pcId: ${pcId}
name: ${name}
key: ${key}
mqtt:
  url: mqtt://${host}:1883
`;
}

function AddSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("Gaming PC");
  const [pcId, setPcId] = useState("gaming-pc");
  const [touched, setTouched] = useState(false);
  const [mac, setMac] = useState("");
  const [result, setResult] = useState<{ pcId: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const host = location.hostname || "homepanel.local";
  const add = async () => {
    setBusy(true);
    try {
      const r = await api<{ pcId: string; key: string }>("POST", "/api/admin/agents", { pcId, name, ...(mac.trim() ? { mac: mac.trim() } : {}) });
      setResult(r);
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  if (result) {
    const y = agentYaml(result.pcId, name, result.key, host);
    return (
      <Sheet onClose={onClose} label="Computer added">
        <h2>{name} is registered</h2>
        <p>Save this as <code>agent.yaml</code> next to the agent on that PC, then start the agent. The key is shown only once.</p>
        <pre className="snippet">{y}</pre>
        <div className="row">
          <button className="btn" onClick={() => copy(y)}><Icon name="copy" size={18} /> Copy</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet onClose={onClose} label="Add computer">
      <h2>Add a computer</h2>
      <p>Registers a PC so its agent can send temperatures, drives and buttons.</p>
      <label className="field"><span>Name</span><input value={name} onChange={(e) => { setName(e.target.value); if (!touched) setPcId(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} /></label>
      <label className="field"><span>ID (used in profiles)</span><input value={pcId} onChange={(e) => { setTouched(true); setPcId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); }} /></label>
      <label className="field"><span>MAC address for Wake-on-LAN (optional)</span><input value={mac} placeholder="AA:BB:CC:DD:EE:FF" onChange={(e) => setMac(e.target.value)} /></label>
      <div className="row">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !pcId || !name} onClick={add}>{busy && <span className="spinner" />} Add computer</button>
      </div>
    </Sheet>
  );
}

export function ComputersTab() {
  const { data, error, reload } = useResource<AgentSummary[]>("/api/admin/agents", 5000);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AgentSummary | null>(null);
  return (
    <div className="page">
      <div className="page-head with-action">
        <div>
          <h1>Computers</h1>
          <p>PCs running the HomePanel agent. Their sensors, drives and buttons become widgets.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={18} /> Add computer</button>
      </div>
      {error && <div className="form-err">{error}</div>}
      {data && !data.length && <div className="empty-state">No computers yet. Add one, then install the agent on it.</div>}
      <ul className="rows">
        {(data ?? []).map((a) => (
          <li key={a.pcId} className="row-item">
            <span className={"dot" + (a.status === "online" ? " on" : "")} />
            <div className="row-main">
              <div className="row-title">{a.name}</div>
              <div className="row-sub">{a.pcId}{a.hostname ? " · " + a.hostname : ""} · {a.status === "online" ? "online" : a.status === "never-seen" ? "never connected" : "last seen " + ago(a.lastSeen)}{a.hasMac ? " · Wake-on-LAN" : ""}</div>
            </div>
            <button className="btn" onClick={() => setRemoving(a)}><Icon name="trash" size={18} /> Remove</button>
          </li>
        ))}
      </ul>
      {adding && <AddSheet onClose={() => setAdding(false)} onDone={reload} />}
      {removing && (
        <ConfirmSheet title={`Remove ${removing.name}?`} body="Its key stops working. Widgets for this PC will show it as asleep." confirmLabel="Remove" danger onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const a = removing; setRemoving(null);
            try { await api("DELETE", `/api/admin/agents/${encodeURIComponent(a.pcId)}`); toast("Removed " + a.name, "ok"); void reload(); }
            catch (e) { toast((e as Error).message, "error"); }
          }} />
      )}
    </div>
  );
}
