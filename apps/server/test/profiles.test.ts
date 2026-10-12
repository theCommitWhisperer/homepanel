import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_EXAMPLE_DIR } from "../src/config.js";
import { validateProfileYaml } from "../src/profiles.js";
import { plainApp } from "./helpers.js";

describe("profile validation", () => {
  it("all shipped example profiles are valid", () => {
    const dir = path.join(DATA_EXAMPLE_DIR, "profiles");
    const files = fs.readdirSync(dir);
    expect(files.sort()).toEqual(["desk-monitor.yaml", "fire-hd8.yaml", "kitchen-ipad.yaml"]);
    for (const f of files) {
      const r = validateProfileYaml(fs.readFileSync(path.join(dir, f), "utf8"), f.replace(".yaml", ""));
      expect(r.ok ? [] : r.errors, f).toEqual([]);
    }
    const fire = validateProfileYaml(fs.readFileSync(path.join(dir, "fire-hd8.yaml"), "utf8"), "fire-hd8");
    expect(fire.ok && fire.profile.lite).toBe(true);
  });

  it("rejects bad YAML, schema errors, id mismatch and off-grid widgets", () => {
    expect(validateProfileYaml("a: [", "x").ok).toBe(false);
    const noGrid = validateProfileYaml("id: x\nname: X\n", "x");
    expect(!noGrid.ok && noGrid.errors.join()).toMatch(/grid/);
    const mismatch = validateProfileYaml("id: y\nname: X\ngrid: {cols: 2, rows: 2}\n", "x");
    expect(!mismatch.ok && mismatch.errors.join()).toMatch(/must be "x"/);
    const off = validateProfileYaml("name: X\ngrid: {cols: 2, rows: 2}\nwidgets:\n  - {type: clock, at: [1, 0, 2, 1]}\n", "x");
    expect(!off.ok && off.errors.join()).toMatch(/does not fit/);
    const ok = validateProfileYaml("name: X\ngrid: {cols: 2, rows: 2}\nwidgets:\n  - {type: clock, at: [0, 0, 2, 1], format24: true}\n", "x");
    expect(ok.ok && ok.profile.id).toBe("x");
    expect(ok.ok && (ok.profile.widgets[0] as any).format24).toBe(true); // passthrough widget keys survive
  });
});

describe("profile REST + push", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("PUT validates, saves and DELETE refuses profiles in use", async () => {
    const hp = await plainApp();
    close = () => hp.app.close();
    const { session } = (await hp.app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "secret" } })).json();
    const h = { authorization: `Bearer ${session}`, "content-type": "text/yaml" };
    const bad = await hp.app.inject({ method: "PUT", url: "/api/admin/profiles/test", headers: h, payload: "name: T\n" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().ok).toBe(false);
    const good = await hp.app.inject({ method: "PUT", url: "/api/admin/profiles/test", headers: h, payload: "name: T\ngrid: {cols: 3, rows: 3}\n" });
    expect(good.json()).toEqual({ ok: true });
    expect(fs.existsSync(path.join(hp.dir, "profiles", "test.yaml"))).toBe(true);
    const list = (await hp.app.inject({ url: "/api/admin/profiles", headers: h })).json();
    expect(list.map((p: any) => p.id)).toContain("test");
    hp.devices.add("D", "test", "tok");
    const del = await hp.app.inject({ method: "DELETE", url: "/api/admin/profiles/test", headers: h });
    expect(del.statusCode).toBe(409);
  });
});
