import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ProfileSchema } from "@homepanel/protocol";
import type { AgentActionsPayload, AgentSensor, WidgetPlacement } from "@homepanel/protocol";
import { collectKeys, parseWidget } from "../src/sdk";
import { registry } from "../src/widgets";
import { lightKeys } from "../src/widgets/lights";
import { resolveMedia, schema as mediaSchema, mediaPath, filterFolder } from "../src/widgets/media";
import { actionFor } from "../src/widgets/pc-drives";
import { pickTemps, schema as tempsSchema } from "../src/widgets/pc-temps";
import { validateProfileYaml } from "../src/admin/ProfilesTab";

const w = (type: string, extra: Record<string, unknown> = {}): WidgetPlacement => ({ type, at: [0, 0, 1, 1], ...extra });
const ok = (p: WidgetPlacement) => {
  const r = parseWidget(registry, p);
  if (!r.ok) throw new Error(p.type + ": " + JSON.stringify(r));
  return r;
};
const bad = (p: WidgetPlacement) => expect(parseWidget(registry, p).ok).toBe(false);

describe("widget registry", () => {
  it("implements every built-in widget type", async () => {
    const { BUILTIN_WIDGETS } = await import("@homepanel/protocol");
    for (const t of BUILTIN_WIDGETS) expect(registry.get(t), t).toBeTruthy();
  });

  it("unknown types are reported, not thrown", () => {
    const r = parseWidget(registry, w("nope"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("unknown");
  });
});

describe("widget config schemas (exact keys)", () => {
  it("clock", () => {
    ok(w("clock"));
    ok(w("clock", { format: "24h" }));
    ok(w("clock", { format24: true })); // alias used by server example profiles
    bad(w("clock", { format: "25h" }));
  });

  it("pc-temps defaults", () => {
    const c = tempsSchema.parse({ pc: "gaming-pc" });
    expect(c).toMatchObject({ warnAt: 80, critAt: 90, style: "gauges" });
    expect(ok(w("pc-temps", { pc: "gaming-pc" })).keys).toEqual(["agent:gaming-pc:sensors", "agent:gaming-pc:status", "agents"]);
    bad(w("pc-temps", {}));
    bad(w("pc-temps", { pc: "x", style: "bars" }));
  });

  it("pc-drives", () => {
    expect(ok(w("pc-drives", { pc: "pc" })).keys).toEqual(["agent:pc:drives", "agent:pc:actions"]);
    bad(w("pc-drives"));
  });

  it("buttons: list or pc", () => {
    ok(w("buttons", { buttons: [{ label: "Fan", action: { kind: "ha", domain: "switch", service: "toggle" }, confirm: true }] }));
    expect(ok(w("buttons", { pc: "pc" })).keys).toEqual(["agent:pc:actions"]);
    bad(w("buttons", { buttons: [{ label: "x", action: { kind: "teleport" } }] }));
  });

  it("lights: explicit entities or wildcard", () => {
    expect(ok(w("lights", { entities: ["light.a", "light.b"] })).keys).toEqual(["ha:light.a", "ha:light.b"]);
    expect(ok(w("lights")).keys).toEqual(["ha:light.*"]);
    expect(lightKeys({ entities: [] })).toEqual(["ha:light.*"]);
  });

  it("entity, camera, text", () => {
    expect(ok(w("entity", { entity: "sensor.t", label: "T" })).keys).toEqual(["ha:sensor.t"]);
    bad(w("entity"));
    expect(ok(w("camera", { entity: "camera.door" })).keys).toEqual(["ha:camera.door"]);
    ok(w("text", { text: "hi" }));
    bad(w("text"));
  });

  it("media: file, URL, folder slideshow, interval durations", () => {
    expect(resolveMedia(mediaSchema.parse({ src: "media/cat.gif" }))).toMatchObject({ single: "media/cat.gif" });
    expect(resolveMedia(mediaSchema.parse({ src: "folder:photos", interval: "5s" }))).toEqual({ folder: "photos", stepMs: 5000 });
    expect(resolveMedia(mediaSchema.parse({ src: "folder:photos" })).stepMs).toBe(10_000);
    ok(w("media", { src: "https://example.com/a.gif", fit: "contain" }));
    bad(w("media", { src: "a.gif", interval: "soon" }));
    bad(w("media", {}));
    expect(mediaPath("media/a b.gif")).toBe("/media/a%20b.gif");
    expect(mediaPath("/media/x.gif")).toBe("/media/x.gif");
    expect(filterFolder(["photos/1.jpg", "photos/x.txt", "gifs/a.gif"], "photos")).toEqual(["photos/1.jpg"]);
  });

  it("collectKeys unions and dedupes", () => {
    const keys = collectKeys(registry, [w("pc-temps", { pc: "pc" }), w("pc-drives", { pc: "pc" }), w("lights"), w("clock")]);
    expect(keys).toEqual(["agent:pc:actions", "agent:pc:drives", "agent:pc:sensors", "agent:pc:status", "agents", "ha:light.*"]);
  });
});

describe("pc helpers", () => {
  const s = (id: string, value: number, kind: AgentSensor["kind"] = "temperature"): AgentSensor => ({ id, name: id, kind, value, unit: "°C" });

  it("pickTemps: all temperatures hottest first, or configured order", () => {
    const list = [s("cpu", 60), s("gpu", 70), s("load", 99, "load"), s("ssd", 40)];
    expect(pickTemps(list.slice(), undefined).map((x) => x.id)).toEqual(["gpu", "cpu", "ssd"]);
    expect(pickTemps(list.slice(), ["ssd", "cpu"]).map((x) => x.id)).toEqual(["ssd", "cpu"]);
  });

  it("drive tap uses open-drive-<letter> only if the PC offers it", () => {
    const adv: AgentActionsPayload = { pc: "pc", actions: [{ id: "open-drive-c", label: "C", type: "open" }] };
    const d = (letter: string) => ({ letter, label: "", totalGB: 1, freeGB: 1 });
    expect(actionFor(d("C:"), { pc: "pc" }, adv)).toBe("open-drive-c");
    expect(actionFor(d("D:"), { pc: "pc" }, adv)).toBeUndefined();
    expect(actionFor(d("E:"), { pc: "pc", openActions: { "E:": "open-projects" } }, adv)).toBe("open-projects");
  });
});

describe("server example profiles validate against kiosk widget schemas", () => {
  const dir = path.resolve(__dirname, "../../server/data-example/profiles");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")) : [];
  it.skipIf(!files.length)("has example profiles", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(f, () => {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      expect(ProfileSchema.safeParse(parse(text)).success).toBe(true);
      expect(validateProfileYaml(text).errors).toEqual([]);
    });
  }
});
