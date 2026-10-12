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
  keys: "⌨️",
  script: "📜",
  url: "🌐",
  system: "⚙️",
};
const SYSTEM_ICON: Record<string, string> = {
  lock: "🔒",
  sleep: "😴",
  restart: "🔄",
  shutdown: "⏻",
  "monitors-off": "🖥️",
};
/** Guards applied when the config doesn't say: destructive things need a tap to confirm. */
const DEFAULT_GUARD: Record<string, AgentActionInfo["guard"]> = {
  restart: "confirm+home-only",
  shutdown: "confirm+home-only",
  sleep: "confirm",
};

/**
 * The allowlist. Only ids present in agent.yaml can run; the id from MQTT is used purely as a
 * lookup key and never interpreted. Execution goes through the injected Spawner (real, or
 * DryRunSpawner for tests / --mock / non-Windows).
 */
export class ActionDispatcher {
  constructor(
    private actions: Record<string, ActionDef>,
    private spawner: Spawner,
    private ctx: PlanContext,
  ) {}

  /** What the dashboard sees. */
  list(): AgentActionInfo[] {
    return Object.entries(this.actions).map(([id, a]) => {
      const info: AgentActionInfo = {
        id,
        label: a.label ?? defaultLabel(id),
        type: a.type,
        icon: a.icon ?? (a.type === "system" ? SYSTEM_ICON[a.command] : DEFAULT_ICON[a.type]),
      };
      const guard = a.guard ?? (a.type === "system" ? DEFAULT_GUARD[a.command] : undefined);
      if (guard) info.guard = guard;
      return info;
    });
  }

  has(id: string): boolean {
    // own properties only: "__proto__", "constructor" etc. must never resolve to something
    return Object.prototype.hasOwnProperty.call(this.actions, id) && typeof this.actions[id] === "object";
  }

  async run(id: string): Promise<ActionOutcome> {
    if (!this.has(id)) return { ok: false, error: "unknown-action" };
    const def = this.actions[id]!;
    let plan;
    try {
      plan = planAction(def, this.ctx);
    } catch (e) {
      return { ok: false, error: e instanceof ActionError || e instanceof Error ? e.message : String(e) };
    }
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
