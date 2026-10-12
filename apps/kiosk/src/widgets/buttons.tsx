import { z } from "zod";
import { ActionRequestSchema } from "@homepanel/protocol";
import type { ActionRequest, AgentActionsPayload, AgentActionType } from "@homepanel/protocol";
import { defineWidget, useEnv, useKey } from "../sdk";
import { useRunAction, useSize } from "../components";
import { fitGrid } from "../lib/store";
import { Icon } from "../icons";

const ButtonSchema = z.object({
  label: z.string(),
  icon: z.string().optional(),
  action: ActionRequestSchema,
  confirm: z.boolean().optional(),
});
const schema = z.object({ buttons: z.array(ButtonSchema).optional(), pc: z.string().optional() });

const TYPE_ICON: Record<AgentActionType, string> = { open: "folder", launch: "play", keys: "keyboard", script: "terminal", url: "globe", system: "power" };

interface Btn { label: string; icon?: string; action: ActionRequest; confirm?: boolean; homeOnly?: boolean }

function ActionButton({ b, dense, remote }: { b: Btn; dense: boolean; remote: boolean }) {
  const { run, state, sheet } = useRunAction();
  const disabled = b.homeOnly && remote;
  return (
    <>
      <button
        className={"act " + state + (dense ? " dense" : "")}
        onClick={() => run(b.action, b.label, b.confirm)}
        disabled={disabled}
        aria-busy={state === "pending"}
      >
        <span className="act-icon">
          {state === "pending" ? <span className="spinner" /> : state === "ok" ? <Icon name="check" size={26} /> : state === "error" ? <Icon name="alert" size={26} /> : <Icon name={b.icon || "play"} size={26} />}
        </span>
        <span className="act-label">{b.label}</span>
        {b.homeOnly && <span className="home-badge" title="Only from home"><Icon name="house" size={14} stroke={2.2} /></span>}
      </button>
      {sheet}
    </>
  );
}

export default defineWidget({
  type: "buttons",
  name: "Buttons",
  configSchema: schema,
  keys: (c) => (c.pc && !(c.buttons && c.buttons.length) ? [`agent:${c.pc}:actions`] : []),
  Component: ({ config }) => {
    const env = useEnv();
    const adv = useKey<AgentActionsPayload>(config.pc && !(config.buttons && config.buttons.length) ? `agent:${config.pc}:actions` : null);
    const [ref, { w, h }] = useSize<HTMLDivElement>();
    let list: Btn[] = [];
    if (config.buttons && config.buttons.length) {
      list = config.buttons.map((b) => ({ label: b.label, icon: b.icon, action: b.action, confirm: b.confirm }));
    } else if (config.pc && adv) {
      list = adv.actions.map((a) => ({
        label: a.label,
        icon: a.icon || TYPE_ICON[a.type],
        action: { kind: "agent", pc: config.pc!, action: a.id },
        confirm: !!a.guard && a.guard.indexOf("confirm") >= 0,
        homeOnly: !!a.guard && a.guard.indexOf("home-only") >= 0,
      }));
    }
    const { cols, rows, scroll } = fitGrid(list.length, w, h, 150, 58);
    const dense = scroll || h / rows < 96;
    return (
      <div ref={ref} className={"acts" + (scroll ? " scroll" : "")} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gridTemplateRows: scroll ? `repeat(${rows}, 60px)` : `repeat(${rows}, minmax(0,1fr))` }}>
        {!list.length && <div className="empty">{config.pc ? "Waiting for " + config.pc + "…" : "No buttons configured."}</div>}
        {list.map((b, i) => <ActionButton key={i + b.label} b={b} dense={dense} remote={!!env.device?.remote} />)}
      </div>
    );
  },
});
