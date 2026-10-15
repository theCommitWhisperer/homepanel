import type { Check, CheckState, Recommendation } from "./types";

export type GroupId = "pc" | "ha" | "homepanel" | "sensors";
export const GROUPS: { id: GroupId; title: string }[] = [
  { id: "pc", title: "This PC" },
  { id: "ha", title: "Home Assistant" },
  { id: "homepanel", title: "HomePanel" },
  { id: "sensors", title: "Sensors" },
];

export interface PrecheckState {
  /** in arrival order */
  checks: Check[];
  recommendation?: Recommendation;
  done: boolean;
  error?: string;
  startedAt?: number;
}

export const initialPrecheck: PrecheckState = { checks: [], done: false };

export type PrecheckAction =
  | { type: "reset"; at?: number }
  | { type: "data"; data: unknown }
  | { type: "error"; error: string };

const STATES: CheckState[] = ["ok", "warn", "fail", "info", "running"];
function isCheck(x: any): x is Check {
  return x && typeof x === "object" && typeof x.id === "string" && typeof x.label === "string" && STATES.includes(x.state);
}
function isRecommendation(x: any): x is Recommendation {
  return x && typeof x === "object" && typeof x.mode === "string" && typeof x.title === "string";
}

function upsert(list: Check[], c: Check): Check[] {
  const i = list.findIndex((x) => x.id === c.id);
  if (i < 0) return [...list, c];
  const next = list.slice();
  next[i] = { ...list[i], ...c };
  return next;
}

/**
 * Accepts every shape the server may stream: a full snapshot `{checks, recommendation, done?}`,
 * `{type:"check", check}` / `{type:"check", ...Check}`, a bare Check, `{type:"recommendation", recommendation}`
 * and `{type:"done"}`.
 */
export function precheckReducer(s: PrecheckState, a: PrecheckAction): PrecheckState {
  switch (a.type) {
    case "reset":
      return { checks: [], done: false, startedAt: a.at };
    case "error":
      return { ...s, error: a.error, done: true };
    case "data": {
      const d: any = a.data;
      if (!d || typeof d !== "object") return s;
      let next = s;
      if (Array.isArray(d.checks)) {
        let checks = next.checks;
        for (const c of d.checks) if (isCheck(c)) checks = upsert(checks, c);
        next = { ...next, checks };
      }
      if (d.type === "check") {
        const c = isCheck(d.check) ? d.check : isCheck(d) ? d : undefined;
        if (c) next = { ...next, checks: upsert(next.checks, stripType(c)) };
      } else if (!d.type && isCheck(d)) {
        next = { ...next, checks: upsert(next.checks, d) };
      }
      const rec = isRecommendation(d.recommendation) ? d.recommendation : d.type === "recommendation" && isRecommendation(d) ? d : undefined;
      if (rec) next = { ...next, recommendation: stripType(rec) };
      if (d.type === "done" || d.done === true) next = { ...next, done: true };
      return next;
    }
  }
}

function stripType<T>(x: T): T {
  const { type: _t, ...rest } = x as any;
  return rest as T;
}

const KEYWORDS: [GroupId, RegExp][] = [
  ["sensors", /^(lhm|sensor|librehardware|temps?)/],
  ["homepanel", /^(homepanel|hp|server|agent|app|pc-registered|registered|tray|task|local-server|hp-app)/],
  ["ha", /^(ha|homeassistant|home-assistant|mosquitto|mqtt|zbt|zigbee|zha|proxmox|pve)/],
  ["pc", /^(pc|windows|win|os|admin|winget|net|network|ip|firewall|internet|state|setup|saved)/],
];

/** Which group a check belongs to: explicit `group`, else inferred from its id. */
export function groupOf(c: Pick<Check, "id" | "group">): GroupId {
  const g = c.group?.toLowerCase();
  if (g === "pc" || g === "this-pc" || g === "this pc") return "pc";
  if (g === "ha" || g === "home-assistant" || g === "home assistant") return "ha";
  if (g === "homepanel") return "homepanel";
  if (g === "sensors") return "sensors";
  const id = c.id.toLowerCase();
  // "homepanel-app"/"hp-app" before "ha"; "mosquitto" stays with Home Assistant (it is an HA app)
  for (const [gid, re] of KEYWORDS) if (re.test(id)) return gid;
  return "pc";
}

export function grouped(checks: Check[]): { id: GroupId; title: string; checks: Check[] }[] {
  return GROUPS.map((g) => ({ ...g, checks: checks.filter((c) => groupOf(c) === g.id) }));
}

export function counts(checks: Check[]): Record<CheckState, number> {
  const r: Record<CheckState, number> = { ok: 0, warn: 0, fail: 0, info: 0, running: 0 };
  for (const c of checks) r[c.state]++;
  return r;
}

/**
 * Fix action → what to do. "<item>/<op>" (e.g. "agent/restart", "network/private") is
 * POST /api/control/<item>/<op>; "start:agent" is accepted too. Anything else is not understood.
 */
export function parseFixAction(action: string): { kind: "control"; item: string; verb: string } | { kind: "other"; action: string } {
  const a = /^([a-z][a-z-]*)\/([a-z][a-z-]*)$/.exec(action);
  if (a) return { kind: "control", item: a[1]!, verb: a[2]! };
  const b = /^(start|stop|restart):([a-z][a-z-]*)$/.exec(action);
  if (b) return { kind: "control", verb: b[1]!, item: b[2]! };
  return { kind: "other", action };
}
