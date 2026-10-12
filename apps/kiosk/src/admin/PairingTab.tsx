import { useState } from "react";
import type { DeviceInfo, PendingPairing } from "@homepanel/protocol";
import { api } from "./api";
import { ago, ProfileRow, shortUA, useResource } from "./hooks";
import { toast } from "../lib/toast";
import { Sheet } from "../components";

function ApproveSheet({ p, profiles, onClose, onDone }: { p: PendingPairing; profiles: ProfileRow[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(shortUA(p.userAgent));
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    try {
      const d = await api<DeviceInfo>("POST", `/api/admin/pairings/${encodeURIComponent(p.pairingId)}/approve`, { name, profileId });
      toast(`Paired “${d?.name ?? name}”`, "ok");
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet onClose={onClose} label="Approve screen">
      <h2>Add this screen</h2>
      <p>Code <b className="num">{p.code}</b> · {shortUA(p.userAgent)} · {p.ip}</p>
      <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Kitchen iPad" /></label>
      <label className="field"><span>Profile</span>
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          {profiles.map((pr) => <option key={pr.id} value={pr.id}>{pr.name} ({pr.id})</option>)}
        </select>
      </label>
      <div className="row">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={approve} disabled={busy || !name || !profileId}>{busy && <span className="spinner" />} Approve</button>
      </div>
    </Sheet>
  );
}

export function PairingTab() {
  const { data, error, reload } = useResource<PendingPairing[]>("/api/admin/pairings", 3000);
  const { data: profiles } = useResource<ProfileRow[]>("/api/admin/profiles");
  const [code, setCode] = useState("");
  const [sel, setSel] = useState<PendingPairing | null>(null);
  const list = data ?? [];
  const match = (c: string) => list.find((p) => p.code === c.replace(/\D/g, ""));
  const onCode = (e: React.FormEvent) => {
    e.preventDefault();
    const m = match(code);
    if (m) setSel(m);
    else toast("No screen is showing that code right now.", "error");
  };
  const reject = async (p: PendingPairing) => {
    try {
      await api("POST", `/api/admin/pairings/${encodeURIComponent(p.pairingId)}/reject`);
      void reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="page">
      <div className="page-head">
        <h1>Pair a screen</h1>
        <p>Open HomePanel on the tablet or monitor. It shows a 6-digit code — enter it here.</p>
      </div>
      <form className="code-entry" onSubmit={onCode}>
        <input className="code-input num" inputMode="numeric" maxLength={7} placeholder="000 000" value={code}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "").slice(0, 6);
            setCode(v);
            const m = v.length === 6 && match(v);
            if (m) setSel(m);
          }} aria-label="Pairing code" />
        <button className="btn primary" disabled={code.length !== 6}>Find screen</button>
      </form>
      <h2 className="section">Waiting to pair</h2>
      {error && <div className="form-err">{error}</div>}
      {!list.length ? (
        <div className="empty-state">No screens are waiting. Open HomePanel on a screen to see it here.</div>
      ) : (
        <ul className="rows">
          {list.map((p) => (
            <li key={p.pairingId} className="row-item">
              <div className="row-main" onClick={() => setSel(p)} role="button" tabIndex={0}>
                <div className="row-title num big-code">{p.code.slice(0, 3)} {p.code.slice(3)}</div>
                <div className="row-sub">{shortUA(p.userAgent)} · {p.ip} · {ago(p.createdAt)}</div>
              </div>
              <button className="btn" onClick={() => reject(p)}>Reject</button>
              <button className="btn primary" onClick={() => setSel(p)}>Approve</button>
            </li>
          ))}
        </ul>
      )}
      {sel && <ApproveSheet p={sel} profiles={profiles ?? []} onClose={() => setSel(null)} onDone={() => { setSel(null); setCode(""); void reload(); }} />}
    </div>
  );
}
