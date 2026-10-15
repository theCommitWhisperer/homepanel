import { useEffect, useState } from "react";
import type { Nav } from "../App";
import { Icon } from "../icons";
import type { AiProvider, AiSettings, ModeId, ModeInfo, ModesResponse } from "../lib/types";
import { Badge, Button, Spinner, Switch } from "../ui";

const MODE_ICON: Record<ModeId, string> = { host: "monitor", join: "plug", ha: "house", move: "send" };
const MODE_FALLBACK: ModeInfo[] = [
  { id: "host", title: "Host on this PC", summary: "Server, MQTT broker and this PC's agent, all on this PC.", available: true },
  { id: "join", title: "Join this PC to my HomePanel", summary: "Temperatures and buttons for this PC, reporting to an existing server.", available: true },
  { id: "ha", title: "Set up Home Assistant", summary: "Find or install Home Assistant, create the token, add Mosquitto and the HomePanel app.", available: true },
  { id: "move", title: "Move the server to Home Assistant", summary: "Hand this PC's server, layouts and agent over to the HomePanel app on HA.", available: true },
];

export const PROVIDERS: { id: AiProvider; name: string; tag: string; needsKey: boolean; keyUrl: string; baseUrl?: string; note: string }[] = [
  { id: "gemini", name: "Gemini", tag: "Free tier · Google", needsKey: true, keyUrl: "https://aistudio.google.com/apikey", note: "Free key with a Google account." },
  { id: "groq", name: "Groq", tag: "Free tier · very fast", needsKey: true, keyUrl: "https://console.groq.com/keys", note: "Free key, per-minute limits." },
  { id: "openrouter", name: "OpenRouter", tag: "Free models", needsKey: true, keyUrl: "https://openrouter.ai/keys", note: "About 50 free requests a day." },
  { id: "ollama", name: "Ollama", tag: "Local · private", needsKey: false, keyUrl: "https://ollama.com/download", baseUrl: "http://localhost:11434/v1", note: "Runs on this PC: ollama pull qwen3:8b first." },
];

const PREF_KEY = "hp.ai.provider";

export function ModePicker({
  nav,
  modes,
  reload,
  preselect,
  error,
  running,
}: {
  nav: Nav;
  modes: ModesResponse | null;
  reload: () => void;
  preselect?: ModeId;
  error?: string | null;
  running: boolean;
}) {
  const list = modes?.modes ?? MODE_FALLBACK;
  const firstPick = preselect ?? list.find((m) => m.recommended && m.available)?.id ?? list.find((m) => m.available)?.id;
  const [mode, setMode] = useState<ModeId | undefined>(firstPick);
  const [aiOn, setAiOn] = useState(false);
  const [provider, setProvider] = useState<AiProvider>(() => {
    try {
      return (localStorage.getItem(PREF_KEY) as AiProvider) || "gemini";
    } catch {
      return "gemini";
    }
  });
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyErr, setKeyErr] = useState<string | null>(null);

  useEffect(() => {
    if (!modes) reload();
  }, [modes, reload]);
  useEffect(() => {
    if (!mode && firstPick) setMode(firstPick);
  }, [firstPick, mode]);

  const p = PROVIDERS.find((x) => x.id === provider)!;
  const start = async () => {
    if (!mode) return;
    let ai: AiSettings | undefined;
    if (aiOn) {
      if (p.needsKey && !apiKey.trim()) {
        setKeyErr(`Paste your ${p.name} API key, or turn the AI guide off.`);
        document.getElementById("ai-key")?.focus();
        return;
      }
      ai = { provider, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(baseUrl.trim() || p.baseUrl ? { baseUrl: baseUrl.trim() || p.baseUrl } : {}) };
      try {
        localStorage.setItem(PREF_KEY, provider);
      } catch {
        /* ignore */
      }
    }
    setBusy(true);
    try {
      await nav.startMode(mode, { ai });
    } finally {
      setBusy(false);
    }
  };

  const selected = list.find((m) => m.id === mode);

  return (
    <div className="screen modes-screen">
      <div className="page-head">
        <div>
          <h1>What do you want to set up?</h1>
          <p className="lede">Every step is checked first and skipped when it's already done, so running a mode again is safe.</p>
        </div>
        <div className="head-actions">
          <Button variant="ghost" icon="check" onClick={() => nav.go("check")}>
            Back to System check
          </Button>
        </div>
      </div>

      {!modes && (
        <div className="muted-row">
          <Spinner /> Loading…
        </div>
      )}

      <div className="mode-grid" role="radiogroup" aria-label="Setup mode">
        {list.map((m, i) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            disabled={!m.available}
            className={"mode-card" + (mode === m.id ? " selected" : "") + (m.available ? "" : " unavailable")}
            onClick={() => setMode(m.id)}
            onDoubleClick={() => m.available && (setMode(m.id), void start())}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowLeft") {
                e.preventDefault();
                const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
                for (let k = 1; k <= list.length; k++) {
                  const n = list[(i + dir * k + list.length * 2) % list.length]!;
                  if (n.available) {
                    setMode(n.id);
                    (document.querySelector(`[data-mode="${n.id}"]`) as HTMLElement | null)?.focus();
                    break;
                  }
                }
              }
            }}
            data-mode={m.id}
            tabIndex={mode === m.id || (!mode && i === 0) ? 0 : -1}
          >
            <span className="mode-num num">{i + 1}</span>
            <span className="mode-icon">
              <Icon name={MODE_ICON[m.id] ?? "gear"} size={22} />
            </span>
            <span className="mode-body">
              <span className="mode-title">
                {m.title}
                {m.recommended && <Badge>Recommended</Badge>}
              </span>
              <span className="mode-summary">{m.summary}</span>
              {m.why && <span className={"mode-why" + (m.available ? "" : " off")}>{m.why}</span>}
            </span>
            <span className="radio-dot" aria-hidden />
          </button>
        ))}
      </div>

      <section className={"ai-box" + (aiOn ? " open" : "")}>
        <div className="ai-head">
          <Switch id="ai-toggle" checked={aiOn} onChange={setAiOn} label={<><b>Use the AI guide</b><span className="sub">Chat alongside the steps: it explains, reads the logs and suggests fixes. Every change still needs your OK.</span></>} />
        </div>
        {aiOn && (
          <div className="ai-body">
            <div className="provider-row" role="radiogroup" aria-label="AI provider">
              {PROVIDERS.map((x) => (
                <button key={x.id} type="button" role="radio" aria-checked={provider === x.id} className={"provider" + (provider === x.id ? " selected" : "")} onClick={() => (setProvider(x.id), setKeyErr(null))}>
                  <span className="provider-name">{x.name}</span>
                  <span className="provider-tag">{x.tag}</span>
                </button>
              ))}
            </div>
            <div className="ai-fields">
              {p.needsKey ? (
                <label className="field grow">
                  <span>
                    {p.name} API key
                    <a href={p.keyUrl} target="_blank" rel="noreferrer" className="field-link">
                      Get a free key <Icon name="external" size={12} />
                    </a>
                  </span>
                  <input id="ai-key" type="password" autoComplete="off" spellCheck={false} placeholder="Paste the key" value={apiKey} onChange={(e) => (setApiKey(e.target.value), setKeyErr(null))} aria-invalid={!!keyErr} />
                  {keyErr ? <em className="inline-err">{keyErr}</em> : <em className="hint">{p.note} Used for this run only, never saved.</em>}
                </label>
              ) : (
                <label className="field grow">
                  <span>
                    Ollama address
                    <a href={p.keyUrl} target="_blank" rel="noreferrer" className="field-link">
                      Download Ollama <Icon name="external" size={12} />
                    </a>
                  </span>
                  <input type="text" spellCheck={false} placeholder={p.baseUrl} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                  <em className="hint">{p.note}</em>
                </label>
              )}
              <label className="field model-field">
                <span>Model</span>
                <input type="text" spellCheck={false} placeholder="default" value={model} onChange={(e) => setModel(e.target.value)} />
              </label>
            </div>
            <p className="privacy">
              <Icon name="lock" size={15} />
              <span>
                The guide sees step names and log lines, never your passwords or tokens. <b>Free cloud tiers may use your prompts to improve their models;</b> Ollama keeps everything on your PC.
              </span>
            </p>
          </div>
        )}
      </section>

      {error && (
        <div className="callout callout-crit" role="alert">
          <Icon name="alert" size={18} />
          <span>{error}</span>
        </div>
      )}

      <div className="start-bar">
        <div className="start-what">
          {selected ? (
            <>
              <span className="muted">Ready:</span> <b>{selected.title}</b>
              {aiOn && <span className="muted"> · with the {p.name} guide</span>}
            </>
          ) : (
            <span className="muted">Pick a mode above.</span>
          )}
        </div>
        <Button variant="primary" size="lg" icon="play" onClick={start} busy={busy} disabled={!mode || running}>
          {running ? "A setup is already running" : "Start"}
        </Button>
      </div>
    </div>
  );
}
