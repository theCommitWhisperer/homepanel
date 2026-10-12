import { z } from "zod";
import type { AgentActionsPayload, AgentDrive, AgentDrivesPayload } from "@homepanel/protocol";
import { defineWidget, useKey } from "../sdk";
import { useRunAction, useSize } from "../components";
import { fitGrid } from "../lib/store";
import { Icon } from "../icons";

/** openActions optionally maps a drive letter to an action id; otherwise `open-drive-<letter>` is used when the PC offers it. */
export const schema = z.object({ pc: z.string(), openActions: z.record(z.string()).optional() });

function fmt(gb: number) {
  return gb >= 1000 ? (gb / 1000).toFixed(gb >= 10000 ? 0 : 1) + " TB" : Math.round(gb) + " GB";
}

/** Match a drive to an action: config.openActions["C:"] or ["C"] or an advertised action "open-c". */
export function actionFor(d: AgentDrive, cfg: z.infer<typeof schema>, adv?: AgentActionsPayload): string | undefined {
  const map = cfg.openActions ?? {};
  const bare = d.letter.replace(/[:\\/]+$/, "");
  const explicit = map[d.letter] ?? map[bare] ?? map[bare.toLowerCase()] ?? map[bare.toUpperCase()];
  if (explicit) return explicit;
  if (cfg.openActions) return undefined;
  const slug = bare.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const ids = ["open-drive-" + slug, "open-" + slug, "open_" + slug, "drive-" + slug];
  const guess = adv?.actions.find((a) => ids.indexOf(a.id) >= 0);
  return guess?.id;
}

function Drive({ d, pc, actionId, label, guard, dense }: { d: AgentDrive; pc: string; actionId?: string; label: string; guard?: string; dense: boolean }) {
  const { run, state, sheet } = useRunAction();
  const used = Math.max(0, d.totalGB - d.freeGB);
  const frac = d.totalGB > 0 ? used / d.totalGB : 0;
  const lv = frac > 0.95 ? "crit" : frac > 0.85 ? "warn" : "ok";
  const Tag = actionId ? "button" : "div";
  return (
    <Tag
      className={"drive" + (actionId ? " tappable" : "") + (state === "pending" ? " pending" : "") + (dense ? " dense" : "")}
      onClick={actionId ? () => run({ kind: "agent", pc, action: actionId }, label, !!guard && guard.indexOf("confirm") >= 0) : undefined}
    >
      <div className="drive-top">
        <span className="drive-letter">{d.letter}</span>
        <span className="drive-label">{d.label}</span>
        {actionId && (state === "pending" ? <span className="spinner small" /> : <Icon name="folder" size={20} style={{ color: "var(--accent)", flex: "none" }} />)}
      </div>
      <div className="drive-bar"><span className={"lv-bg-" + lv} style={{ width: (frac * 100).toFixed(1) + "%" }} /></div>
      <div className="drive-meta num">
        <span><b>{fmt(d.freeGB)}</b> free</span>
        <span>{fmt(d.totalGB)}</span>
      </div>
      {sheet}
    </Tag>
  );
}

export default defineWidget({
  type: "pc-drives",
  name: "PC drives",
  configSchema: schema,
  keys: (c) => [`agent:${c.pc}:drives`, `agent:${c.pc}:actions`],
  Component: ({ config }) => {
    const data = useKey<AgentDrivesPayload>(`agent:${config.pc}:drives`);
    const actions = useKey<AgentActionsPayload>(`agent:${config.pc}:actions`);
    const [ref, { w, h }] = useSize<HTMLDivElement>();
    const drives = data?.drives ?? [];
    const { cols, rows, scroll } = fitGrid(Math.max(1, drives.length), w, h, 150, 74);
    const dense = scroll || h / rows < 110;
    return (
      <div ref={ref} className={"drives" + (scroll ? " scroll" : "")} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gridTemplateRows: scroll ? `repeat(${rows}, 80px)` : `repeat(${rows}, minmax(0,1fr))` }}>
        {!data && <div className="empty">Waiting for drives…</div>}
        {data && !drives.length && <div className="empty">No drives reported.</div>}
        {drives.map((d) => {
          const id = actionFor(d, config, actions);
          const info = actions?.actions.find((a) => a.id === id);
          return <Drive key={d.letter} d={d} pc={config.pc} actionId={id} label={info?.label ?? "Open " + d.letter} guard={info?.guard} dense={dense} />;
        })}
      </div>
    );
  },
});
