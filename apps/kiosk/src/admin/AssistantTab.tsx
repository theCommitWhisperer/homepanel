import { useEffect, useRef, useState } from "react";
import type { AssistantReply, ChatMessage, PendingApproval } from "@homepanel/protocol";
import { api } from "./api";
import { session } from "../lib/storage";
import { Icon } from "../icons";

const KEY = "homepanel.assistant";
const SUGGESTIONS = [
  "Add my gaming PC's temperatures to the desk monitor",
  "Show the front door camera on the kitchen iPad",
  "Which lights do I have?",
];

const PROVIDERS: { name: string; how: string; yaml: string }[] = [
  { name: "Google Gemini · free tier", how: "Key from aistudio.google.com → Get API key.", yaml: "assistant:\n  provider: gemini\n  apiKey: YOUR_KEY" },
  { name: "Groq · free tier, very fast", how: "Key from console.groq.com → API Keys.", yaml: "assistant:\n  provider: groq\n  apiKey: gsk_YOUR_KEY" },
  { name: "OpenRouter · free models", how: "Key from openrouter.ai/keys; pick a model ending in :free.", yaml: "assistant:\n  provider: openrouter\n  apiKey: sk-or-YOUR_KEY\n  model: meta-llama/llama-3.3-70b-instruct:free" },
  { name: "Ollama · runs on your own PC", how: "Install Ollama, run: ollama pull llama3.1", yaml: "assistant:\n  provider: ollama\n  baseUrl: http://192.168.1.20:11434/v1\n  model: llama3.1" },
];

function NoProvider({ unavailable }: { unavailable?: boolean }) {
  return (
    <div className="no-provider">
      <h3>{unavailable ? "The AI provider isn't answering" : "Connect a free AI provider"}</h3>
      <p>
        {unavailable
          ? "Check the assistant: settings (key, model, address) and that the service is reachable from the server."
          : "The assistant needs a model to talk to. Add an assistant: section to config.yaml in the Doorbells & config tab, save, and ask again. Any one of these works:"}
      </p>
      <div className="np-grid">
        {PROVIDERS.map((p) => (
          <div key={p.name}>
            <b>{p.name}</b>
            <p>{p.how}</p>
            <pre className="snippet">{p.yaml}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AssistantTab() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try { return JSON.parse(session.get(KEY) ?? "[]"); } catch { return []; }
  });
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { session.set(KEY, JSON.stringify(messages.slice(-60))); }, [messages]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages, pending, busy]);

  const handle = (r: AssistantReply, fallback: ChatMessage[]) => {
    if (r.error) setError(r.error);
    else setError(null);
    setMessages(r.messages && r.messages.length ? r.messages : fallback);
    setPending(r.pending ?? null);
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    const next = messages.concat({ role: "user", content: t });
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      handle(await api<AssistantReply>("POST", "/api/admin/assistant", { messages: next }), next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approve: boolean) => {
    if (!pending) return;
    setBusy(true);
    try {
      handle(await api<AssistantReply>("POST", `/api/admin/assistant/${approve ? "approve" : "reject"}`, { callId: pending.callId }), messages);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page chat-page">
      <div className="page-head with-action">
        <div>
          <h1>Assistant</h1>
          <p>Describe what you want on a screen. Nothing changes until you approve it.</p>
        </div>
        {messages.length > 0 && <button className="btn ghost" onClick={() => { setMessages([]); setPending(null); setError(null); }}>New chat</button>}
      </div>
      <div className="chat">
        {!messages.length && (
          <div className="suggest">
            {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"msg " + m.role}><div className="bubble">{m.content}</div></div>
        ))}
        {busy && <div className="msg assistant"><div className="bubble typing"><span className="spinner" /> Thinking…</div></div>}
        {pending && (
          <div className="approval" role="group" aria-label="Approval needed">
            <div className="ap-head"><Icon name="lock" size={20} /> Approval needed · <code>{pending.tool}</code></div>
            <p>{pending.summary}</p>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void decide(false)}>Reject</button>
              <button className="btn primary" disabled={busy} onClick={() => void decide(true)}><Icon name="check" size={18} /> Approve</button>
            </div>
          </div>
        )}
        {error === "no-provider" || error === "assistant-unavailable" ? <NoProvider unavailable={error === "assistant-unavailable"} /> : error ? <div className="form-err">{error}</div> : null}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <textarea value={input} rows={2} placeholder="e.g. Put a big clock and the living room lights on the Fire tablet"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
        <button className="btn primary" disabled={busy || !input.trim()} aria-label="Send"><Icon name="send" size={20} /> Send</button>
      </form>
    </div>
  );
}
