import type { AgentActionInfo } from "@homepanel/protocol";
import { defaultLabel, type ActionDef } from "../config.js";
import { runChecked, type Spawner } from "../exec.js";
import { log } from "../util.js";
import { ActionError, planAction, type PlanContext } from "./plan.js";

export interface ActionOutcome {
  ok: boolean;
  error?: string;
  output?: string;
}

const DEFAULT_ICON: Record<string, string> = {
  open: "📁",
  launch: "🚀",
  keys: "🎵",
  script: "📜",
  url: "🌐",
  system: "⚙️",
  echo: "🧪",
};
const SYSTEM_ICON: Record<string, string> = {
  lock: "🔒",
  sleep: "😴",
  restart: "🔄",
  shutdown: "⏻",
  monitors_off: "🖥️",
  mute_mic: "🎙️",
};
/** Guards applied when the config doesn't say: destructive things need a tap to confirm. */
const DEFAULT_GUARD: Record<string, AgentActionInfo["guard"]> = {
  restart: "confirm+home-only",
  shutdown: "confirm+home-only",
  sleep: "confirm",
};

export class ActionDispatcher {
  constructor(
    private actions: Record<string, ActionDef>,
    private spawner: Spawner,
    private ctx: PlanContext,
    private opts: { mock?: boolean } = {},
  ) {}

  /** What the dashboard sees. `echo` test actions are only advertised in --mock mode. */
  list(): AgentActionInfo[] {
    return Object.entries(this.actions)
      .filter(([, a]) => a.type !== "echo" || this.opts.mock)
      .map(([id, a]) => {
        const info: AgentActionInfo = {
          id,
          label: a.label ?? defaultLabel(id),
          // the protocol enum has no "echo"; advertise it as "url" (harmless, mock-only)
          type: a.type === "echo" ? "url" : a.type,
          icon: a.icon ?? (a.type === "system" ? SYSTEM_ICON[a.op] : DEFAULT_ICON[a.type]),
        };
        const guard = a.guard ?? (a.type === "system" ? DEFAULT_GUARD[a.op] : undefined);
        if (guard) info.guard = guard;
        return info;
      });
  }

  has(id: string): boolean {
    // own properties only: "__proto__", "constructor" etc. must never resolve to something
    if (!Object.prototype.hasOwnProperty.call(this.actions, id)) return false;
    const a = this.actions[id];
    return !!a && typeof a === "object" && (a.type !== "echo" || !!this.opts.mock);
  }

  get(id: string): ActionDef | undefined {
    return this.has(id) ? this.actions[id] : undefined;
  }

  async run(id: string): Promise<ActionOutcome> {
    const def = this.get(id);
    if (!def) return { ok: false, error: `unknown action "${id}"` };
    if (this.opts.mock && def.type !== "echo") {
      // --mock never touches the machine
      log.info(`[mock] would run action ${id} (${def.type})`);
      return { ok: true, output: "mock" };
    }
    let plan;
    try {
      plan = planAction(def, this.ctx);
    } catch (e) {
      return { ok: false, error: e instanceof ActionError ? e.message : String(e) };
    }
    if (plan.steps.length === 0) return { ok: true, output: "echo" };
    log.info(`action ${id}: ${plan.describe}`);
    const errors: string[] = [];
    let output = "";
    for (const step of plan.steps) {
      try {
        const r = await runChecked(this.spawner, step);
        output = r.stdout.trim();
        if (plan.mode === "first-success") return { ok: true, output };
      } catch (e) {
        const msg = (e as NodeJS.ErrnoException).code === "ENOENT" ? `${step.cmd} not found` : (e as Error).message;
        errors.push(msg);
        if (plan.mode === "all") return { ok: false, error: msg };
      }
    }
    if (plan.mode === "first-success") return { ok: false, error: errors.join("; ") };
    return { ok: true, output };
  }
}
