import { useState } from "react";
import type { DeviceInfo } from "@homepanel/protocol";
import { api } from "./api";
import { ProfileRow, useResource } from "./hooks";
import { toast } from "../lib/toast";
import { ConfirmSheet } from "../components";
import { Icon } from "../icons";

function ScreenRow({ d, profiles, onChange }: { d: DeviceInfo; profiles: ProfileRow[]; onChange: () => void }) {
  const [name, setName] = useState(d.name);
  const [revoking, setRevoking] = useState(false);
  const patch = async (body: Partial<DeviceInfo>) => {
    try {
      await api("PATCH", `/api/admin/devices/${encodeURIComponent(d.id)}`, body);
      toast("Saved", "ok", 1800);
      onChange();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <li className="row-item">
      <Icon name="monitor" size={26} style={{ color: "var(--ink-3)", flex: "none" }} />
      <div className="row-main">
        <input className="inline-input" value={name} onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== d.name && name.trim() && patch({ name: name.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} aria-label="Screen name" />
        <div className="row-sub">{d.id}{d.remote ? " · outside home" : ""}</div>
      </div>
      <select value={d.profileId} onChange={(e) => patch({ profileId: e.target.value })} aria-label="Profile">
        {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        {!profiles.some((p) => p.id === d.profileId) && <option value={d.profileId}>{d.profileId}</option>}
      </select>
      <button className="btn" onClick={() => setRevoking(true)}><Icon name="trash" size={18} /> Remove</button>
      {revoking && (
        <ConfirmSheet title={`Remove “${d.name}”?`} body="The screen goes back to the pairing code and needs to be paired again." confirmLabel="Remove" danger
          onCancel={() => setRevoking(false)}
          onConfirm={async () => {
            setRevoking(false);
            try { await api("DELETE", `/api/admin/devices/${encodeURIComponent(d.id)}`); toast("Removed " + d.name, "ok"); onChange(); }
            catch (e) { toast((e as Error).message, "error"); }
          }} />
      )}
    </li>
  );
}

export function ScreensTab() {
  const { data, error, reload } = useResource<DeviceInfo[]>("/api/admin/devices", 10_000);
  const { data: profiles } = useResource<ProfileRow[]>("/api/admin/profiles");
  return (
    <div className="page">
      <div className="page-head">
        <h1>Screens</h1>
        <p>Every paired tablet and monitor. Change a profile and the screen updates right away.</p>
      </div>
      {error && <div className="form-err">{error}</div>}
      {data && !data.length && <div className="empty-state">No screens yet. Pair one from the Pairing tab.</div>}
      <ul className="rows">
        {(data ?? []).map((d) => <ScreenRow key={d.id + d.name + d.profileId} d={d} profiles={profiles ?? []} onChange={reload} />)}
      </ul>
    </div>
  );
}
