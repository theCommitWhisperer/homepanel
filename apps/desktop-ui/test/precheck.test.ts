import { describe, expect, it } from "vitest";
import { counts, groupOf, grouped, initialPrecheck, parseFixAction, precheckReducer, type PrecheckState } from "../src/lib/precheck";

const feed = (data: unknown[], s: PrecheckState = initialPrecheck) => data.reduce<PrecheckState>((st, d) => precheckReducer(st, { type: "data", data: d }), s);

describe("precheck reducer", () => {
  it("accepts streamed checks in every shape and updates them in place", () => {
    const s = feed([
      { type: "check", id: "pc.windows", label: "Windows", state: "running", detail: "Checking…" },
      { type: "check", check: { id: "ha.found", label: "Home Assistant", state: "ok", detail: "http://192.168.1.81" } },
      { id: "sensors.lhm", label: "LibreHardwareMonitor", state: "ok", detail: "58 sensors" },
      { type: "check", id: "pc.windows", label: "Windows", state: "ok", detail: "Windows 11" },
    ]);
    expect(s.checks.map((c) => c.id)).toEqual(["pc.windows", "ha.found", "sensors.lhm"]);
    expect(s.checks[0]).toMatchObject({ state: "ok", detail: "Windows 11" });
    expect(s.checks[0]).not.toHaveProperty("type");
    expect(s.done).toBe(false);
  });

  it("takes snapshots (long-poll JSON), recommendation and done", () => {
    let s = feed([{ checks: [{ id: "ha.mosquitto", label: "Mosquitto", state: "fail", detail: "missing", fix: { label: "Install", mode: "ha" } }], done: false }]);
    expect(s.checks).toHaveLength(1);
    expect(s.done).toBe(false);
    s = feed([{ type: "recommendation", recommendation: { mode: "ha", title: "Finish Home Assistant setup", why: "…" } }, { type: "done" }], s);
    expect(s.recommendation?.mode).toBe("ha");
    expect(s.done).toBe(true);
    const snap = feed([{ checks: [], recommendation: { mode: "control", title: "All good", why: "" } }]);
    expect(snap.recommendation?.mode).toBe("control");
    const bare = feed([{ type: "recommendation", mode: "move", title: "Move", why: "" }]);
    expect(bare.recommendation).toEqual({ mode: "move", title: "Move", why: "" });
  });

  it("ignores junk, resets, and records errors", () => {
    let s = feed([null, 42, { type: "check", id: "x" }, { id: "y", label: "Y", state: "bogus" }]);
    expect(s.checks).toEqual([]);
    s = feed([{ id: "a", label: "A", state: "ok", detail: "" }]);
    s = precheckReducer(s, { type: "reset", at: 5 });
    expect(s).toEqual({ checks: [], done: false, startedAt: 5 });
    s = precheckReducer(s, { type: "error", error: "boom" });
    expect(s).toMatchObject({ error: "boom", done: true });
  });

  it("groups checks: explicit group wins, else inferred from the id", () => {
    expect(groupOf({ id: "pc.firewall" })).toBe("pc");
    expect(groupOf({ id: "internet" })).toBe("pc");
    expect(groupOf({ id: "ha.token" })).toBe("ha");
    expect(groupOf({ id: "mosquitto" })).toBe("ha");
    expect(groupOf({ id: "zbt1" })).toBe("ha");
    expect(groupOf({ id: "proxmox" })).toBe("ha");
    expect(groupOf({ id: "homepanel-app" })).toBe("homepanel");
    expect(groupOf({ id: "agent" })).toBe("homepanel");
    expect(groupOf({ id: "lhm" })).toBe("sensors");
    expect(groupOf({ id: "whatever", group: "sensors" })).toBe("sensors");
    expect(groupOf({ id: "ha.thing", group: "This PC" })).toBe("pc");
    const g = grouped([
      { id: "pc.a", label: "", state: "ok", detail: "" },
      { id: "ha.b", label: "", state: "warn", detail: "" },
      { id: "ha.c", label: "", state: "fail", detail: "" },
    ]);
    expect(g.map((x) => [x.title, x.checks.length])).toEqual([["This PC", 1], ["Home Assistant", 2], ["HomePanel", 0], ["Sensors", 0]]);
    expect(counts(g[1]!.checks)).toMatchObject({ warn: 1, fail: 1, ok: 0 });
  });

  it("parses fix actions", () => {
    expect(parseFixAction("agent/restart")).toEqual({ kind: "control", verb: "restart", item: "agent" });
    expect(parseFixAction("network/private")).toEqual({ kind: "control", verb: "private", item: "network" });
    expect(parseFixAction("start:agent")).toEqual({ kind: "control", verb: "start", item: "agent" });
    expect(parseFixAction("mark-network-private")).toEqual({ kind: "other", action: "mark-network-private" });
  });
});
