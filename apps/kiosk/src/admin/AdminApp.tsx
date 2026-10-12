import { useEffect, useState } from "react";
import "./admin.css";
import { Icon } from "../icons";
import { Toasts } from "../components";
import { api, ApiError, adminSession, setUnauthorizedHandler } from "./api";
import { PairingTab } from "./PairingTab";
import { ScreensTab } from "./ScreensTab";
import { ProfilesTab } from "./ProfilesTab";
import { ComputersTab } from "./ComputersTab";
import { ConfigTab } from "./ConfigTab";
import { AssistantTab } from "./AssistantTab";
import { applyTheme } from "../kiosk/KioskApp";

const TABS = [
  { id: "pairing", label: "Pairing", icon: "plus" },
  { id: "screens", label: "Screens", icon: "monitor" },
  { id: "profiles", label: "Profiles", icon: "sliders" },
  { id: "computers", label: "Computers", icon: "terminal" },
  { id: "config", label: "Doorbells & config", icon: "bell" },
  { id: "assistant", label: "Assistant", icon: "send" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ session: string }>("POST", "/api/admin/login", { password: pw });
      adminSession.set(r.session);
      onDone();
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 401 ? "Wrong password." : (x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="admin-login">
      <form onSubmit={submit} className="login-card">
        <div className="brand"><Icon name="logo" size={30} /> HomePanel admin</div>
        <label className="field">
          <span>Admin password</span>
          <input type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </label>
        {err && <div className="form-err">{err}</div>}
        <button className="btn primary" disabled={busy || !pw}>{busy ? <span className="spinner" /> : null} Sign in</button>
        <p className="hint">The password is in the server's config. In demo mode it's <code>demo</code>.</p>
      </form>
    </div>
  );
}

function readTab(): TabId {
  const h = location.hash.replace(/^#/, "");
  return (TABS.find((t) => t.id === h)?.id ?? "pairing") as TabId;
}

export function AdminApp() {
  const [authed, setAuthed] = useState(!!adminSession.get());
  const [tab, setTab] = useState<TabId>(readTab);

  useEffect(() => {
    applyTheme("auto", false);
    document.title = "HomePanel admin";
    setUnauthorizedHandler(() => setAuthed(false));
    const onHash = () => setTab(readTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (!authed) return <><Login onDone={() => setAuthed(true)} /><Toasts /></>;

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="brand"><Icon name="logo" size={26} /> HomePanel</div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <a key={t.id} href={"#" + t.id} role="tab" aria-selected={tab === t.id} className={"tab" + (tab === t.id ? " active" : "")}>
              <Icon name={t.icon} size={18} /> <span>{t.label}</span>
            </a>
          ))}
        </nav>
        <button className="btn ghost signout" onClick={() => { adminSession.set(null); setAuthed(false); }}>Sign out</button>
      </header>
      <main className="admin-main">
        {tab === "pairing" && <PairingTab />}
        {tab === "screens" && <ScreensTab />}
        {tab === "profiles" && <ProfilesTab />}
        {tab === "computers" && <ComputersTab />}
        {tab === "config" && <ConfigTab />}
        {tab === "assistant" && <AssistantTab />}
      </main>
      <Toasts />
    </div>
  );
}
