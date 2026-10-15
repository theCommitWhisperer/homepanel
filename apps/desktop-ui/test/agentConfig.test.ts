import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  deleteAction,
  describeAction,
  errorsByAction,
  listActions,
  moveAction,
  parseAgentYaml,
  stringify,
  suggestId,
  upsertAction,
  validateDraft,
} from "../src/lib/agentConfig";

const SRC = readFileSync(new URL("./fixtures/agent.yaml", import.meta.url), "utf8");
const load = () => parseAgentYaml(SRC).doc;
const ids = (text: string) => Object.keys(parse(text).actions);
const nonActions = (text: string) => {
  const { actions: _a, ...rest } = parse(text);
  return rest;
};
// comment alignment (runs of spaces) is not preserved by the yaml printer; everything else is
const headerOf = (text: string) => text.slice(0, text.indexOf("actions:")).replace(/ {2,}#/g, " #");

describe("agent.yaml round-trip", () => {
  it("lists actions in file order with their fields", () => {
    const list = listActions(load());
    expect(list[0]).toMatchObject({ id: "open-drive-c", type: "open", path: "C:\\", label: "C:" });
    expect(list.find((a) => a.id === "launch-discord")).toMatchObject({ exe: "%LOCALAPPDATA%\\Discord\\Update.exe", args: ["--processStart", "Discord.exe"] });
    expect(list.find((a) => a.id === "restart")?.guard).toBe("confirm+home-only");
    expect(list.length).toBe(ids(SRC).length);
  });

  it("is unchanged in meaning and keeps every comment when nothing is edited", () => {
    const out = stringify(load());
    expect(parse(out)).toEqual(parse(SRC));
    for (const c of SRC.split("\n").filter((l) => l.trim().startsWith("#"))) expect(out).toContain(c.trim());
    expect(headerOf(out)).toBe(headerOf(SRC));
  });

  it("adds an action at the end in the same one-line style", () => {
    const doc = load();
    upsertAction(doc, { id: "open-drive-e", type: "open", path: "E:\\", label: "E:", icon: "💾" });
    const out = stringify(doc);
    expect(ids(out).at(-1)).toBe("open-drive-e");
    expect(parse(out).actions["open-drive-e"]).toEqual({ type: "open", path: "E:\\", label: "E:", icon: "💾" });
    expect(out).toMatch(/open-drive-e: \{ type: open, path: 'E:\\', label: "?E:"?, icon: "?💾"? \}/);
    expect(nonActions(out)).toEqual(nonActions(SRC));
    expect(out).toContain("# --- system ---");
    expect(headerOf(out)).toBe(headerOf(SRC));
  });

  it("edits in place: changed fields only, removed fields dropped, comments kept", () => {
    const doc = load();
    const cur = listActions(doc).find((a) => a.id === "sleep")!;
    upsertAction(doc, { ...cur, label: "Nap", guard: undefined });
    const out = stringify(doc);
    expect(parse(out).actions.sleep).toEqual({ type: "system", command: "sleep", label: "Nap", icon: "😴" });
    expect(ids(out)).toEqual(ids(SRC));
    expect(out).toContain("# --- system ---");
    expect(out).toContain("# Discord's own updater picks the current version:");
  });

  it("changing the type drops the old type's fields", () => {
    const doc = load();
    upsertAction(doc, { id: "launch-steam", type: "url", url: "steam://open/games", label: "Steam" }, "launch-steam");
    expect(parse(stringify(doc)).actions["launch-steam"]).toEqual({ type: "url", url: "steam://open/games", label: "Steam" });
  });

  it("renames keep position and refuse duplicates", () => {
    const doc = load();
    const cur = listActions(doc).find((a) => a.id === "lock")!;
    upsertAction(doc, { ...cur, id: "lock-pc" }, "lock");
    const out = stringify(doc);
    expect(ids(out).indexOf("lock-pc")).toBe(ids(SRC).indexOf("lock"));
    expect(() => upsertAction(doc, { ...cur, id: "sleep" }, "lock-pc")).toThrow(/already exists/);
  });

  it("delete keeps the section header for the next action", () => {
    const doc = load();
    deleteAction(doc, "monitors-off"); // first of "--- system ---"
    const out = stringify(doc);
    expect(ids(out)).not.toContain("monitors-off");
    expect(out).toMatch(/# --- system -+\n\s+lock:/);
    expect(nonActions(out)).toEqual(nonActions(SRC));
  });

  it("reorder moves the action but leaves section headers where they were", () => {
    const doc = load();
    expect(moveAction(doc, "lock", -1)).toBe(true);
    let out = stringify(doc);
    const order = ids(out);
    expect(order.indexOf("lock")).toBe(ids(SRC).indexOf("monitors-off"));
    expect(out).toMatch(/# --- system -+\n\s+lock:/);
    expect(moveAction(doc, "open-drive-c", -1)).toBe(false);
    expect(moveAction(doc, "shutdown", 1)).toBe(false);
    expect(nonActions(out)).toEqual(nonActions(SRC));
    // and back again is identical to the original
    moveAction(doc, "lock", 1);
    out = stringify(doc);
    expect(out).toBe(stringify(load()));
  });

  it("creates the actions map when the file has none", () => {
    const { doc } = parseAgentYaml("pcId: gaming-pc # me\nkey: abcdefghijklmnopqrstuvwxyz\n");
    upsertAction(doc, { id: "lock", type: "system", command: "lock" });
    const out = stringify(doc);
    expect(out).toContain("# me");
    expect(parse(out).actions).toEqual({ lock: { type: "system", command: "lock" } });
  });

  it("reports YAML syntax errors", () => {
    expect(parseAgentYaml("actions: {\n").error).toBeTruthy();
  });
});

describe("helpers", () => {
  it("validates per type", () => {
    expect(validateDraft({ id: "Bad Id", type: "open" }, [])).toMatchObject({ id: expect.any(String), path: expect.any(String) });
    expect(validateDraft({ id: "x", type: "url", url: "javascript:alert(1)" }, [])).toHaveProperty("url");
    expect(validateDraft({ id: "x", type: "launch", exe: 'a"b' }, [])).toHaveProperty("exe");
    expect(validateDraft({ id: "dup", type: "keys", keys: "volume_up" }, ["dup"])).toHaveProperty("id");
    expect(validateDraft({ id: "ok", type: "keys", keys: "ctrl+shift+m" }, [])).toEqual({});
  });
  it("describes, suggests ids and maps server errors", () => {
    expect(describeAction({ id: "a", type: "system", command: "monitors-off" })).toBe("Turn the screens off");
    expect(suggestId("Open E: drive", ["open-e-drive"])).toBe("open-e-drive-2");
    expect(errorsByAction(["actions.foo.url: must be a URL", "key: too short"])).toEqual({ byId: { foo: ["url: must be a URL"] }, general: ["key: too short"] });
  });
});
