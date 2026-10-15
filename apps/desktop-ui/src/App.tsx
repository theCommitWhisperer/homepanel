import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, subscribeLive, subscribeSetup } from "./lib/api";
import { viewFrom, type View } from "./lib/view";
import { emptyRun, setupReducer } from "./lib/setup";
import type { AiSettings, ModeId, ModesResponse, UiInfo } from "./lib/types";
import { Icon } from "./icons";
import { Dialog } from "./ui";
import { SystemCheck } from "./screens/SystemCheck";
import { ModePicker } from "./screens/ModePicker";
import { RunView } from "./screens/RunView";
import { Control } from "./screens/Control";

export type { View };

export const MODE_TITLES: Record<string, string> = {
  host: "Host on this PC",
  join: "Join this PC to my HomePanel",
  ha: "Set up Home Assistant",
  move: "Move the server to Home Assistant",
};

export interface Nav {
  go(v: View): void;
  startMode(mode: ModeId, o?: { ai?: AiSettings; fromStep?: string }): Promise<void>;
}

export function App({ initialView }: { initialView?: View }) {
  const [view, setView] = useState<View>(initialView ?? "check");
  const [run, dispatch] = useReducer(setupReducer, emptyRun);
  const [modes, setModes] = useState<ModesResponse | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [preselect, setPreselect] = useState<ModeId | undefined>();
  const sawRun = useRef<string | undefined>(undefined);
  const [aiRun, setAiRun] = useState(false);
  const [info, setInfo] = useState<UiInfo | null>(null);
  const [quit, setQuit] = useState<"no" | "asking" | "done">("no");
  const touched = useRef(!!initialView);

  // the window's lifeline: the process exits ~30 s after the last /api/ui/live stream closes
  useEffect(
    () =>
      subscribeLive((e) => {
        if (e.type !== "show") return;
        const v = viewFrom(e.view);
        if (v) {
          touched.current = true;
          setView(v);
        }
        window.focus();
      }),
    [],
  );

  // where to start when the opener didn't say: installed → Control, else the system check
  useEffect(() => {
    api.info().then(
      (i) => {
        setInfo(i);
        if (!touched.current) {
          const v = viewFrom(i.view);
          if (v) setView((cur) => (cur === "run" ? cur : v));
        }
      },
      () => undefined,
    );
  }, []);

  useEffect(
    () =>
      subscribeSetup(
        (event) => dispatch({ type: "event", event, at: Date.now() }),
        () => dispatch({ type: "reset" }),
      ),
    [],
  );

  // a run that is already going (window reopened) or just started elsewhere (tray → Run setup) takes the window
  useEffect(() => {
    if (run.runId && run.state === "running" && sawRun.current !== run.runId) {
      sawRun.current = run.runId;
      setView("run");
    }
  }, [run.runId, run.state]);

  const loadModes = useCallback(() => {
    api.modes().then(setModes, () => setModes(null));
  }, []);
  useEffect(loadModes, [loadModes]);

  const nav: Nav = {
    go: (v) => {
      touched.current = true;
      setStartError(null);
      setView(v);
    },
    async startMode(mode, o = {}) {
      touched.current = true;
      setStartError(null);
      try {
        dispatch({ type: "reset" });
        setAiRun(!!o.ai);
        await api.start(mode, o);
        setView("run");
      } catch (e) {
        setStartError((e as Error).message);
        setPreselect(mode);
        setView("modes");
      }
    },
  };

  const running = run.state === "running";
  const version = info?.version ?? modes?.version;
  const doQuit = async () => {
    try {
      await api.quit();
    } catch {
      /* already gone */
    }
    setQuit("done");
    setTimeout(() => window.close(), 300);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <Icon name="logo" size={20} stroke={2.2} />
          </span>
          <span className="brand-name">HomePanel</span>
        </div>
        <nav className="nav" aria-label="Sections">
          <NavTab active={view === "check"} onClick={() => nav.go("check")} icon="check">
            System check
          </NavTab>
          <NavTab active={view === "modes" || view === "run"} onClick={() => nav.go(running || run.summary ? "run" : "modes")} icon="wrench">
            Setup
            {running && <span className="live-dot" title="Setup is running" />}
          </NavTab>
          <NavTab active={view === "control"} onClick={() => nav.go("control")} icon="sliders">
            Control
          </NavTab>
        </nav>
        <div className="topbar-right">
          {running && view !== "run" && (
            <button type="button" className="run-chip" onClick={() => nav.go("run")}>
              <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden />
              {MODE_TITLES[run.mode ?? ""] ?? "Setup"} is running
            </button>
          )}
          {info?.fake && (
            <span className="demo-badge" title={info.fake}>
              Demo data
            </span>
          )}
          {version && <span className="version num">v{version}</span>}
          <button type="button" className="icon-btn quit-btn" onClick={() => setQuit("asking")} title="Quit HomePanel window" aria-label="Quit HomePanel window">
            <Icon name="power" size={16} />
          </button>
        </div>
      </header>
      <main className="main">
        {view === "check" && <SystemCheck nav={nav} onChooseMode={(m) => (setPreselect(m), nav.go("modes"))} />}
        {view === "modes" && <ModePicker nav={nav} modes={modes} reload={loadModes} preselect={preselect} error={startError} running={running} />}
        {view === "run" && <RunView nav={nav} run={run} aiRequested={aiRun} onLocalAi={(text) => dispatch({ type: "local-ai", text })} />}
        {view === "control" && <Control nav={nav} modes={modes} onQuit={() => setQuit("asking")} />}
      </main>
      {quit === "asking" && (
        <Dialog
          title="Quit HomePanel?"
          confirmLabel="Quit"
          cancelLabel="Stay"
          onCancel={() => setQuit("no")}
          onConfirm={() => void doQuit()}
        >
          {running
            ? "A setup is still running; it keeps going in the background until it finishes. The dashboard, agent and sensors keep running."
            : "This closes the window. The dashboard, agent and sensors keep running in the background."}
        </Dialog>
      )}
      {quit === "done" && (
        <div className="scrim">
          <div className="dialog">
            <h2>HomePanel closed</h2>
            <div className="dialog-body">You can close this window. Open HomePanel again from the Start menu or the tray.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function NavTab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: string; children: React.ReactNode }) {
  return (
    <button type="button" className={"nav-tab" + (active ? " active" : "")} aria-current={active ? "page" : undefined} onClick={onClick}>
      <Icon name={icon} size={16} />
      <span>{children}</span>
    </button>
  );
}
