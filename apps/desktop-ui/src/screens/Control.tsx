import { useCallback, useEffect, useState } from "react";
import type { Nav } from "../App";
import { MODE_TITLES } from "../App";
import { Icon } from "../icons";
import { api } from "../lib/api";
import type { ControlStatus, ModeId, ModeInfo, ModesResponse, Sensor, StatusItem, UpdateCheck } from "../lib/types";
import { Badge, Button, Spinner, StateIcon, usePoll, type Tone } from "../ui";
import { ButtonsEditor } from "./ButtonsEditor";
import { LogsTab } from "./LogsTab";

type Tab = "buttons" | "logs" | "setup" | "about";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "buttons", label: "Buttons", icon: "grid" },
  { id: "logs", label: "Logs", icon: "doc" },
  { id: "setup", label: "Setup", icon: "wrench" },
  { id: "about", label: "About", icon: "info" },
];

const ROLE: Record<ControlStatus["role"], string> = {
  host: "Host · server on this PC",
  agent: "Agent · joined to a server",
  "ha-client": "Home Assistant client",
  none: "Not set up yet",
};
const ITEM_ICON: Record<string, string> = { server: "monitor", agent: "chip", sensors: "thermo", mosquitto: "send", tray: "list", ha: "house" };
const ITEM_TONE: Record<StatusItem["state"], Tone> = { running: "ok", stopped: "stopped", missing: "missing", error: "fail", unknown: "unknown" };
const ITEM_WORD: Record<StatusItem["state"], string> = { running: "Running", stopped: "Stopped", missing: "Not installed", error: "Error", unknown: "Unknown" };

export function tempTone(s: Sensor): "" | "warm" | "hot" {
  const u = s.unit.trim();
  if (u !== "°C" && u !== "C") return "";
  return s.value >= 90 ? "hot" : s.value >= 80 ? "warm" : "";
}

export function Control({ nav, modes, onQuit }: { nav: Nav; modes: ModesResponse | null; onQuit?: () => void }) {
  const [status, setStatus] = useState<ControlStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (sessionStorage.getItem("hp.tab") as Tab) || "buttons";
    } catch {
      return "buttons";
    }
  });
  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  usePoll(refresh, 5000);
  useEffect(() => {
    try {
      sessionStorage.setItem("hp.tab", tab);
    } catch {
      /* ignore */
    }
  }, [tab]);

  return (
    <div className="screen control-screen">
      <div className="control-head">
        <div>
          <div className="eyebrow">{status ? ROLE[status.role] : "Loading…"}</div>
          <h1>
            {status?.pcId ?? "This PC"}
            {status?.agentOnline !== undefined && (
              <span className={"online " + (status.agentOnline ? "yes" : "no")}>
                <span className="dot" />
                {status.agentOnline ? "online" : "offline"}
              </span>
            )}
          </h1>
          {status?.serverUrl && <div className="sub num">Server {status.serverUrl}</div>}
        </div>
        <div className="head-actions">
          {status?.adminUrl && (
            <Button icon="gear" onClick={() => void api.open("admin")}>
              Admin
            </Button>
          )}
          <Button variant="primary" icon="external" onClick={() => void api.open("dashboard")} disabled={!status || status.role === "none"}>
            Open dashboard
          </Button>
        </div>
      </div>

      {err && (
        <div className="callout callout-crit" role="alert">
          <Icon name="alert" size={18} />
          <span>{err}</span>
        </div>
      )}

      {!status && !err && (
        <div className="muted-row">
          <Spinner /> Loading status…
        </div>
      )}

      {status && (
        <>
          <div className="tiles">
            {status.items.map((it) => (
              <StatusTile key={it.id} item={it} onChanged={refresh} />
            ))}
          </div>
          <SensorsStrip s={status.sensors} />
        </>
      )}

      <div className="tabs" role="tablist" aria-label="Control">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={"tab" + (tab === t.id ? " active" : "")}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const i = TABS.findIndex((x) => x.id === tab);
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                const n = TABS[(i + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length]!;
                setTab(n.id);
                document.getElementById(`tab-${n.id}`)?.focus();
              }
            }}
          >
            <Icon name={t.icon} size={16} />
            {t.label}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "buttons" && <ButtonsEditor />}
        {tab === "logs" && <LogsTab items={status?.items ?? []} />}
        {tab === "setup" && <SetupTab nav={nav} modes={modes} />}
        {tab === "about" && <AboutTab status={status} modes={modes} onQuit={onQuit} />}
      </div>
    </div>
  );
}

function StatusTile({ item, onChanged }: { item: StatusItem; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (verb: "start" | "stop" | "restart") => {
    setBusy(verb);
    setErr(null);
    try {
      const r = await api.itemAction(item.id, verb);
      if (!r.ok) setErr(r.error ?? `Could not ${verb}.`);
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={`tile ts-${item.state}`}>
      <div className="tile-top">
        <span className="tile-icon">
          <Icon name={ITEM_ICON[item.id] ?? "box"} size={18} />
        </span>
        <span className="tile-label">{item.label}</span>
        <span className={`tile-state ts-word-${item.state}`}>
          <StateIcon tone={ITEM_TONE[item.state]} size={14} />
          {ITEM_WORD[item.state]}
        </span>
      </div>
      <div className="tile-detail" title={item.detail}>
        {item.detail ?? " "}
      </div>
      {err && <div className="inline-err small">{err}</div>}
      <div className="tile-actions">
        {item.canStart && item.state !== "running" && (
          <Button size="sm" variant="secondary" icon="play" busy={busy === "start"} disabled={!!busy} onClick={() => act("start")}>
            Start
          </Button>
        )}
        {item.canRestart && item.state === "running" && (
          <Button size="sm" variant="secondary" icon="restart" busy={busy === "restart"} disabled={!!busy} onClick={() => act("restart")}>
            Restart
          </Button>
        )}
        {item.canStop && item.state === "running" && (
          <Button size="sm" variant="ghost" icon="stop" busy={busy === "stop"} disabled={!!busy} onClick={() => act("stop")}>
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

function SensorsStrip({ s }: { s?: ControlStatus["sensors"] }) {
  if (!s) return null;
  return (
    <div className={"sensors" + (s.ok ? "" : " bad")} aria-label="Sensors">
      <div className="sensors-head">
        <Icon name="thermo" size={16} />
        <span>
          <b className="num">{s.count}</b> sensors
        </span>
        {!s.ok && <Badge tone="warn">not reporting</Badge>}
      </div>
      <div className="sensor-list">
        {s.top.map((x) => (
          <div key={x.name} className={"sensor " + tempTone(x)}>
            <span className="sensor-name">{x.name}</span>
            <span className="sensor-val num">
              {Number.isInteger(x.value) ? x.value : x.value.toFixed(1)}
              <small>{x.unit}</small>
            </span>
          </div>
        ))}
        {s.top.length === 0 && <span className="muted">No readings yet. Is LibreHardwareMonitor running?</span>}
      </div>
    </div>
  );
}

function SetupTab({ nav, modes }: { nav: Nav; modes: ModesResponse | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const list: ModeInfo[] = modes?.modes ?? (Object.keys(MODE_TITLES) as ModeId[]).map((id) => ({ id, title: MODE_TITLES[id]!, summary: "", available: true }));
  return (
    <div className="setup-tab">
      <p className="lede">Run any setup mode again. Every step is checked first; finished ones are skipped, so this is safe.</p>
      <div className="mini-modes">
        {list.map((m) => (
          <div key={m.id} className={"mini-mode" + (m.available ? "" : " unavailable")}>
            <div>
              <div className="mini-title">
                {m.title} {m.recommended && <Badge>Recommended</Badge>}
              </div>
              <div className="mini-sub">{m.available ? m.summary : m.why ?? m.summary}</div>
            </div>
            <Button
              size="sm"
              variant={m.recommended ? "primary" : "secondary"}
              disabled={!m.available || !!busy}
              busy={busy === m.id}
              icon="play"
              onClick={async () => {
                setBusy(m.id);
                try {
                  await nav.startMode(m.id);
                } finally {
                  setBusy(null);
                }
              }}
            >
              Run
            </Button>
          </div>
        ))}
      </div>
      <div className="row-gap">
        <Button icon="check" onClick={() => nav.go("check")}>
          Run the system check
        </Button>
        <Button variant="ghost" onClick={() => nav.go("modes")}>
          Setup with the AI guide…
        </Button>
      </div>
    </div>
  );
}

function AboutTab({ status, modes, onQuit }: { status: ControlStatus | null; modes: ModesResponse | null; onQuit?: () => void }) {
  const [upd, setUpd] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const version = status?.version ?? modes?.version ?? "?";
  const check = async () => {
    setBusy(true);
    setErr(null);
    try {
      setUpd(await api.updateCheck());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const newer = upd?.latest && upd.latest !== upd.current;
  return (
    <div className="about">
      <div className="about-card">
        <span className="about-logo">
          <Icon name="logo" size={34} stroke={2} />
        </span>
        <div>
          <h2>HomePanel</h2>
          <div className="num muted">Version {version}</div>
        </div>
        <div className="about-update">
          {upd && !newer && (
            <span className="ok-text">
              <Icon name="check" size={15} stroke={2.6} /> Up to date
            </span>
          )}
          {newer && (
            <span className="warn-text">
              <b className="num">{upd!.latest}</b> is available
            </span>
          )}
          {err && <span className="inline-err">{err}</span>}
          {newer && upd?.url ? (
            <Button variant="primary" icon="external" onClick={() => window.open(upd.url, "_blank", "noopener")}>
              Download {upd.latest}
            </Button>
          ) : (
            <Button icon="refresh" busy={busy} onClick={check}>
              Check for updates
            </Button>
          )}
        </div>
      </div>
      <dl className="facts">
        <dt>Role</dt>
        <dd>{status ? ROLE[status.role] : "–"}</dd>
        <dt>This PC</dt>
        <dd>{status?.pcId ?? "–"}</dd>
        <dt>Server</dt>
        <dd className="num">{status?.serverUrl ?? "–"}</dd>
        <dt>Dashboard</dt>
        <dd className="num">{status?.dashboardUrl ?? "–"}</dd>
      </dl>
      <div className="row-gap">
        <Button icon="folder" onClick={() => void api.open("logs-folder")}>
          Open logs folder
        </Button>
        <Button icon="house" onClick={() => void api.open("ha")}>
          Open Home Assistant
        </Button>
        <Button variant="ghost" icon="external" onClick={() => window.open("https://github.com/theCommitWhisperer/homepanel#readme", "_blank", "noopener")}>
          Guides
        </Button>
        <Button variant="ghost" icon="external" onClick={() => window.open("https://github.com/theCommitWhisperer/homepanel/releases", "_blank", "noopener")}>
          Release notes
        </Button>
        {onQuit && (
          <Button variant="ghost" icon="power" className="danger-hover push-right" onClick={onQuit}>
            Quit HomePanel window
          </Button>
        )}
      </div>
    </div>
  );
}
