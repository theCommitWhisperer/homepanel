// agent.yaml editing through the `yaml` Document API, so comments, quoting and the rest of the file
// (mqtt, key, sensors…) survive a visual edit. Mirrors apps/agent/src/config.ts (ActionDefSchema).
import { Document, isMap, isScalar, isSeq, Pair, parseDocument, Scalar, YAMLMap, YAMLSeq } from "yaml";

export const ACTION_TYPES = ["open", "launch", "keys", "script", "url", "system"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const SYSTEM_COMMANDS = ["lock", "sleep", "restart", "shutdown", "monitors-off"] as const;
export const GUARDS = ["confirm", "home-only", "confirm+home-only"] as const;
export type Guard = (typeof GUARDS)[number];

export const TYPE_INFO: Record<ActionType, { title: string; hint: string }> = {
  open: { title: "Open folder or file", hint: "Opens a path in Explorer" },
  launch: { title: "Launch program", hint: "Starts an exe or app link" },
  keys: { title: "Press keys", hint: "Media key or shortcut" },
  script: { title: "Run script", hint: ".ps1, .cmd or .bat" },
  url: { title: "Open link", hint: "Web page or app URL" },
  system: { title: "System", hint: "Lock, sleep, restart…" },
};

export interface ActionDraft {
  id: string;
  type: ActionType;
  label?: string;
  icon?: string;
  guard?: Guard;
  path?: string;
  exe?: string;
  args?: string[];
  keys?: string;
  script?: string;
  timeoutMs?: number;
  url?: string;
  command?: string;
}

const TYPE_FIELDS: Record<ActionType, (keyof ActionDraft)[]> = {
  open: ["path"],
  launch: ["exe", "args"],
  keys: ["keys"],
  script: ["script", "args", "timeoutMs"],
  url: ["url"],
  system: ["command"],
};

export const ACTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Line endings of the file each document came from (Windows files written by Notepad use CRLF). */
const EOL = new WeakMap<Document, "\r\n" | "\n">();

export function parseAgentYaml(text: string): { doc: Document; error?: string } {
  const crlf = text.includes("\r\n");
  const doc = parseDocument(crlf ? text.replace(/\r\n/g, "\n") : text, { keepSourceTokens: false });
  EOL.set(doc, crlf ? "\r\n" : "\n");
  liftTrailingComments(doc);
  const err = doc.errors[0];
  return err ? { doc, error: err.message.split("\n")[0] } : { doc };
}

/**
 * A column-0 comment block after a nested map (e.g. the "# --- Buttons ---" banner after `log:`)
 * parses as that map's trailing comment and would be re-indented into it. Text after the first blank
 * line moves to the next top-level key, where it was written.
 */
function liftTrailingComments(doc: Document) {
  const top = doc.contents;
  if (!isMap(top)) return;
  for (let i = 0; i < top.items.length - 1; i++) {
    const v = top.items[i]!.value as { comment?: string | null } | null;
    if (!v || typeof v !== "object" || !(isMap(v) || isSeq(v)) || !v.comment) continue;
    const at = v.comment.indexOf("\n\n");
    if (at < 0) continue;
    const keep = v.comment.slice(0, at);
    const move = v.comment.slice(at + 2);
    v.comment = keep || null;
    const next = keyNode(top.items[i + 1]!);
    next.commentBefore = next.commentBefore ? move + "\n" + next.commentBefore : move;
    next.spaceBefore = true;
  }
}

export function stringify(doc: Document): string {
  // lineWidth 0: never fold long lines, so one-line flow maps stay on one line
  const out = doc.toString({ lineWidth: 0, flowCollectionPadding: true });
  return EOL.get(doc) === "\r\n" ? out.replace(/\n/g, "\r\n") : out;
}

function actionsMap(doc: Document, create: boolean): YAMLMap | undefined {
  const node = doc.get("actions", true);
  if (isMap(node)) return node;
  if (!create) return undefined;
  const map = new YAMLMap();
  doc.set("actions", map);
  return map;
}

function keyOf(p: Pair): string {
  return isScalar(p.key) ? String(p.key.value) : String(p.key);
}

export function listActions(doc: Document): ActionDraft[] {
  const map = actionsMap(doc, false);
  if (!map) return [];
  return map.items.map((p) => {
    const raw = (p.value && typeof (p.value as any).toJSON === "function" ? (p.value as any).toJSON() : p.value) ?? {};
    return { ...(raw as object), id: keyOf(p) } as ActionDraft;
  });
}

/** Plain object written for a draft: type first, then its fields, then label/icon/guard; empties dropped. */
export function draftToObject(d: ActionDraft): Record<string, unknown> {
  const o: Record<string, unknown> = { type: d.type };
  for (const f of TYPE_FIELDS[d.type]) {
    const v = d[f];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    o[f] = v;
  }
  if (d.label) o.label = d.label;
  if (d.icon) o.icon = d.icon;
  if (d.guard) o.guard = d.guard;
  return o;
}

function nodeFor(doc: Document, v: unknown, flow: boolean): unknown {
  if (typeof v === "string") {
    const s = new Scalar(v);
    if (/\\/.test(v)) s.type = Scalar.QUOTE_SINGLE;
    return s;
  }
  if (Array.isArray(v)) {
    const seq = new YAMLSeq();
    seq.flow = true;
    for (const x of v) seq.items.push(nodeFor(doc, x, flow));
    return seq;
  }
  return doc.createNode(v);
}

/** Add a new action or update one (rename when prevId differs). Unchanged scalars keep their quoting. */
export function upsertAction(doc: Document, d: ActionDraft, prevId?: string): void {
  const map = actionsMap(doc, true)!;
  const from = prevId ?? d.id;
  if (prevId !== undefined && prevId !== d.id && map.items.some((p) => keyOf(p) === d.id)) throw new Error(`An action called "${d.id}" already exists.`);
  const obj = draftToObject(d);
  const pair = map.items.find((p) => keyOf(p) === from);
  if (pair && isMap(pair.value)) {
    const m = pair.value;
    for (const p of [...m.items]) {
      const k = keyOf(p);
      if (!(k in obj)) m.delete(k);
    }
    for (const [k, v] of Object.entries(obj)) {
      const cur = m.get(k, true);
      if (isScalar(cur) && typeof v !== "object") {
        if (cur.value !== v) {
          cur.value = v;
          if (typeof v === "string" && /\\/.test(v) && cur.type === Scalar.PLAIN) cur.type = Scalar.QUOTE_SINGLE;
        }
      } else if (isSeq(cur) && Array.isArray(v)) {
        const same = JSON.stringify(cur.toJSON()) === JSON.stringify(v);
        if (!same) {
          const fresh = nodeFor(doc, v, true) as YAMLSeq;
          fresh.flow = cur.flow ?? true;
          m.set(k, fresh);
        }
      } else m.set(k, nodeFor(doc, v, !!m.flow));
    }
    if (prevId !== undefined && prevId !== d.id) {
      if (isScalar(pair.key)) pair.key.value = d.id;
      else pair.key = new Scalar(d.id);
    }
    return;
  }
  // new action: match the style of its neighbours (one-line flow maps in the shipped agent.yaml)
  const neighbourFlow = map.items.length ? map.items.filter((p) => isMap(p.value) && p.value.flow).length * 2 >= map.items.length : true;
  const node = new YAMLMap();
  node.flow = neighbourFlow;
  for (const [k, v] of Object.entries(obj)) node.items.push(new Pair(new Scalar(k), nodeFor(doc, v, neighbourFlow)));
  if (pair) pair.value = node;
  else map.items.push(new Pair(new Scalar(d.id), node));
}

/** Split a key's leading comment into section-header lines (stay at the position) and its own lines. */
function splitComment(c: string | null | undefined): { pos: string[]; own: string[] } {
  if (!c) return { pos: [], own: [] };
  const lines = c.split("\n");
  let i = 0;
  while (i < lines.length && /-{3,}|={3,}/.test(lines[i]!)) i++;
  return { pos: lines.slice(0, i), own: lines.slice(i) };
}
function joinComment(a: string[], b: string[]): string | undefined {
  const all = [...a, ...b];
  return all.length ? all.join("\n") : undefined;
}
function keyNode(p: Pair): Scalar {
  if (!isScalar(p.key)) p.key = new Scalar(p.key);
  return p.key as Scalar;
}

export function deleteAction(doc: Document, id: string): void {
  const map = actionsMap(doc, false);
  if (!map) return;
  const i = map.items.findIndex((p) => keyOf(p) === id);
  if (i < 0) return;
  const k = keyNode(map.items[i]!);
  const { pos } = splitComment(k.commentBefore);
  const next = map.items[i + 1];
  if (next && pos.length) {
    const nk = keyNode(next);
    const n = splitComment(nk.commentBefore);
    nk.commentBefore = joinComment([...pos, ...n.pos], n.own);
    nk.spaceBefore = nk.spaceBefore || k.spaceBefore;
  }
  map.items.splice(i, 1);
}

/** Move an action up (-1) or down (+1). Section-header comments and blank lines stay in place. */
export function moveAction(doc: Document, id: string, delta: -1 | 1): boolean {
  const map = actionsMap(doc, false);
  if (!map) return false;
  const i = map.items.findIndex((p) => keyOf(p) === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= map.items.length) return false;
  const a = keyNode(map.items[i]!);
  const b = keyNode(map.items[j]!);
  const ca = splitComment(a.commentBefore);
  const cb = splitComment(b.commentBefore);
  const sa = a.spaceBefore;
  const sb = b.spaceBefore;
  // positional parts swap back so they stay at index i / j
  a.commentBefore = joinComment(cb.pos, ca.own);
  b.commentBefore = joinComment(ca.pos, cb.own);
  a.spaceBefore = sb;
  b.spaceBefore = sa;
  const tmp = map.items[i]!;
  map.items[i] = map.items[j]!;
  map.items[j] = tmp;
  return true;
}

export function validateDraft(d: ActionDraft, otherIds: string[]): Partial<Record<keyof ActionDraft, string>> {
  const e: Partial<Record<keyof ActionDraft, string>> = {};
  if (!ACTION_ID.test(d.id)) e.id = "Lowercase letters, digits, - and _ (e.g. open-drive-e)";
  else if (otherIds.includes(d.id)) e.id = "Another button already uses this id";
  const req = (f: keyof ActionDraft, msg: string) => {
    const v = d[f];
    if (v === undefined || (typeof v === "string" && !v.trim())) e[f] = msg;
  };
  switch (d.type) {
    case "open":
      req("path", "Which folder or file?");
      break;
    case "launch":
      req("exe", "Which program?");
      if (d.exe && /["\r\n]/.test(d.exe)) e.exe = "No double quotes";
      if (d.args?.some((a) => /["\r\n]/.test(a))) e.args = "No double quotes in arguments";
      break;
    case "keys":
      req("keys", "Which keys? e.g. media_play_pause or ctrl+shift+m");
      if (d.keys && /\s/.test(d.keys.trim())) e.keys = "One key or combo, joined with + (no spaces)";
      break;
    case "script":
      req("script", "Path of the script");
      if (d.timeoutMs !== undefined && (!Number.isInteger(d.timeoutMs) || d.timeoutMs < 1000 || d.timeoutMs > 600000)) e.timeoutMs = "1000 – 600000 ms";
      break;
    case "url":
      req("url", "Which link?");
      if (d.url && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(d.url)) e.url = "Must look like https://… or steam://…";
      else if (d.url && /^(file|javascript|vbscript|data):/i.test(d.url)) e.url = "file:, javascript: and data: links are not allowed";
      break;
    case "system":
      if (!d.command || !(SYSTEM_COMMANDS as readonly string[]).includes(d.command)) e.command = "Pick a command";
      break;
  }
  return e;
}

/** One line for the list: what pressing the button does. */
export function describeAction(d: ActionDraft): string {
  switch (d.type) {
    case "open":
      return `Open ${d.path ?? "?"}`;
    case "launch":
      return `Start ${d.exe ?? "?"}${d.args?.length ? " " + d.args.join(" ") : ""}`;
    case "keys":
      return `Press ${d.keys ?? "?"}`;
    case "script":
      return `Run ${d.script ?? "?"}${d.args?.length ? " " + d.args.join(" ") : ""}`;
    case "url":
      return `Open ${d.url ?? "?"}`;
    case "system":
      return ({ lock: "Lock this PC", sleep: "Sleep", restart: "Restart this PC", shutdown: "Shut down", "monitors-off": "Turn the screens off" } as Record<string, string>)[d.command ?? ""] ?? `System: ${d.command ?? "?"}`;
  }
}

export function emptyDraft(type: ActionType = "open"): ActionDraft {
  return { id: "", type, ...(type === "system" ? { command: "lock" } : {}) };
}

/** Suggest an id from the label: "Open E: drive" → "open-e-drive". */
export function suggestId(label: string, taken: string[]): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "button";
  let id = /^[a-z0-9]/.test(base) ? base : "b-" + base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** Map server validation errors ("actions.foo.url: …") to action ids. */
export function errorsByAction(errors: (string | { path?: string; message: string })[]): { byId: Record<string, string[]>; general: string[] } {
  const byId: Record<string, string[]> = {};
  const general: string[] = [];
  for (const e of errors) {
    const text = typeof e === "string" ? e : `${e.path ? e.path + ": " : ""}${e.message}`;
    const m = /^actions\.([a-z0-9_-]+)(?:\.([^:]+))?:\s*(.*)$/i.exec(text.trim());
    if (m) (byId[m[1]!] ??= []).push(m[2] ? `${m[2]}: ${m[3]}` : m[3]!);
    else general.push(text);
  }
  return { byId, general };
}
