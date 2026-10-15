import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { api } from "../lib/api";
import type { StatusItem } from "../lib/types";
import { Button, CopyButton, Switch, usePoll } from "../ui";

const DEFAULT_ITEMS = [
  { id: "server", label: "Server" },
  { id: "agent", label: "PC agent" },
  { id: "sensors", label: "Sensors" },
  { id: "mosquitto", label: "Mosquitto" },
  { id: "tray", label: "Tray" },
];

function lineClass(l: string): string {
  if (/\b(error|err|fatal|failed|refused)\b/i.test(l)) return "ll-err";
  if (/\b(warn|warning)\b/i.test(l)) return "ll-warn";
  return "";
}

export function LogsTab({ items }: { items: StatusItem[] }) {
  const list = (items.length ? items.filter((i) => i.state !== "missing" && i.id !== "ha") : DEFAULT_ITEMS).map((i) => ({ id: String(i.id), label: i.label }));
  const [item, setItem] = useState<string>(list[0]?.id ?? "server");
  const [lines, setLines] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  usePoll(
    async () => {
      if (!live && lines) return;
      try {
        const r = await api.logs(item, 200);
        setLines(r.lines);
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    3000,
    [item, live],
  );
  useLayoutEffect(() => {
    if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  return (
    <div className="logs-tab">
      <div className="logs-bar">
        <div className="seg" role="tablist" aria-label="Log">
          {list.map((i) => (
            <button key={i.id} type="button" role="tab" aria-selected={item === i.id} className={"seg-btn" + (item === i.id ? " active" : "")} onClick={() => (setItem(i.id), setLines(null), (stick.current = true))}>
              {i.label}
            </button>
          ))}
        </div>
        <div className="logs-tools">
          <Switch id="live" checked={live} onChange={setLive} label="Live" />
          <CopyButton text={(lines ?? []).join("\n")} label="Copy" />
          <Button size="sm" variant="ghost" icon="folder" onClick={() => void api.open("logs-folder")}>
            Folder
          </Button>
        </div>
      </div>
      {err && (
        <div className="callout callout-crit">
          <Icon name="alert" size={16} />
          <span>{err}</span>
        </div>
      )}
      <pre
        className="logbox"
        ref={box}
        tabIndex={0}
        aria-label={`${item} log`}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
      >
        {lines === null ? <span className="muted">Loading…</span> : lines.length === 0 ? <span className="muted">This log is empty.</span> : lines.map((l, i) => (
          <span key={i} className={"ll " + lineClass(l)}>
            {l}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}
