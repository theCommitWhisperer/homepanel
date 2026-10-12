import { describe, expect, it, vi } from "vitest";
import { DataStore, History, fitGrid, matchesWildcard } from "../src/lib/store";

describe("DataStore", () => {
  it("stores values and notifies only that key's listeners", () => {
    const s = new DataStore();
    const a = vi.fn();
    const b = vi.fn();
    s.subscribe("ha:light.a", a);
    s.subscribe("ha:light.b", b);
    s.set("ha:light.a", { state: "on" }, 5);
    expect(s.get("ha:light.a")).toEqual({ state: "on" });
    expect(s.ts("ha:light.a")).toBe(5);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("unsubscribes and cleans up", () => {
    const s = new DataStore();
    const l = vi.fn();
    const off = s.subscribe("k", l);
    expect(s.listenerCount("k")).toBe(1);
    off();
    expect(s.listenerCount("k")).toBe(0);
    s.set("k", 1);
    expect(l).not.toHaveBeenCalled();
  });

  it("clear() drops values and notifies", () => {
    const s = new DataStore();
    const l = vi.fn();
    s.set("k", 1);
    s.subscribe("k", l);
    s.clear();
    expect(s.get("k")).toBeUndefined();
    expect(l).toHaveBeenCalledTimes(1);
  });
});

describe("lights wildcard collection", () => {
  const ent = (id: string, state = "on") => ({ entity_id: id, state, attributes: {}, last_changed: "", last_updated: "" });

  it("matches only that domain", () => {
    expect(matchesWildcard("ha:light.*", "ha:light.kitchen")).toBe(true);
    expect(matchesWildcard("ha:light.*", "ha:switch.fan")).toBe(false);
    expect(matchesWildcard("ha:light.*", "ha:lightning.x")).toBe(false);
    expect(matchesWildcard("ha:light.kitchen", "ha:light.kitchen")).toBe(false);
  });

  it("collects per-entity messages under a wildcard, stable until a new one arrives", () => {
    const s = new DataStore();
    const l = vi.fn();
    s.subscribePattern("ha:light.*", l);
    expect(s.keysMatching("ha:light.*")).toEqual([]);
    s.set("ha:light.office", ent("light.office"));
    s.set("ha:switch.fan", ent("switch.fan"));
    s.set("ha:light.kitchen", ent("light.kitchen"));
    const first = s.keysMatching("ha:light.*");
    expect(first).toEqual(["ha:light.kitchen", "ha:light.office"]);
    expect(l).toHaveBeenCalledTimes(2);
    // state update of a known light: same array (no re-render of the list), no pattern notification
    s.set("ha:light.kitchen", ent("light.kitchen", "off"));
    expect(s.keysMatching("ha:light.*")).toBe(first);
    expect(l).toHaveBeenCalledTimes(2);
  });

  it("expands a bulk array sent under the wildcard key", () => {
    const s = new DataStore();
    s.set("ha:light.*", [ent("light.a"), ent("light.b", "off"), { nope: 1 }]);
    expect(s.keysMatching("ha:light.*")).toEqual(["ha:light.a", "ha:light.b"]);
    expect(s.get<{ state: string }>("ha:light.b")?.state).toBe("off");
    expect(s.get("ha:light.*")).toBeUndefined();
  });
});

describe("History", () => {
  it("keeps a rolling window and honours min interval", () => {
    const h = new History(10_000);
    expect(h.push("x", 1, 0)).toBe(true);
    expect(h.push("x", 2, 500, 1000)).toBe(false);
    h.push("x", 3, 5_000);
    h.push("x", 4, 12_000);
    expect(h.get("x").map((p) => p.v)).toEqual([3, 4]);
  });
});

describe("fitGrid", () => {
  it("fits all tiles when there is room", () => {
    const g = fitGrid(4, 800, 400, 120, 64);
    expect(g.cols * g.rows).toBeGreaterThanOrEqual(4);
    expect(g.scroll).toBe(false);
  });
  it("scrolls when tiles can't fit", () => {
    expect(fitGrid(30, 300, 100, 120, 64).scroll).toBe(true);
  });
});

import { takeTokenFromUrl } from "../src/lib/bootstrap";
import { local, TOKEN_KEY } from "../src/lib/storage";
describe("?token= bootstrap", () => {
  it("stores the token and strips it from the URL", () => {
    let url = "";
    expect(takeTokenFromUrl({ search: "?a=1&token=abc", pathname: "/", hash: "#x" }, (u) => (url = u))).toBe("abc");
    expect(url).toBe("/?a=1#x");
    expect(local.get(TOKEN_KEY)).toBe("abc");
    local.remove(TOKEN_KEY);
    expect(takeTokenFromUrl({ search: "", pathname: "/", hash: "" }, () => undefined)).toBeNull();
  });
});
