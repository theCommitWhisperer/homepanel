import { afterEach, describe, expect, it } from "vitest";
import { demoApp, wsClient } from "./helpers.js";

describe("demo mode", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("health, demo admin password, fake entities", async () => {
    const hp = await demoApp();
    close = () => hp.app.close();
    expect((await hp.app.inject({ url: "/api/health" })).json()).toMatchObject({ ok: true, ha: "demo", mqtt: "demo" });
    const login = await hp.app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "demo" } });
    expect(login.statusCode).toBe(200);
    const ents = (await hp.app.inject({ url: "/api/admin/entities", headers: { authorization: `Bearer ${login.json().session}` } })).json();
    const ids = ents.map((e: any) => e.entity_id);
    expect(ids).toEqual(expect.arrayContaining(["light.living_room", "light.kitchen", "light.office", "switch.desk_fan", "weather.home", "camera.front_door"]));
    const snap = await hp.app.inject({ url: "/api/camera/camera.front_door/snapshot?t=demo" });
    expect(snap.statusCode).toBe(200);
    expect(snap.headers["content-type"]).toContain("image/svg+xml");
    const media = (await hp.app.inject({ url: "/api/media" })).json();
    expect(media).toContain("homepanel.gif");
    const gif = await hp.app.inject({ url: "/media/homepanel.gif" });
    expect(gif.statusCode).toBe(200);
    expect(gif.headers["content-type"]).toBe("image/gif");
    // SPA fallback (kiosk not built → placeholder page), API 404 stays JSON
    const spa = await hp.app.inject({ url: "/admin/screens" });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers["content-type"]).toContain("text/html");
    expect((await hp.app.inject({ url: "/api/nope" })).statusCode).toBe(404);
  });

  it("WS: hello → welcome, subscribe → state, HA action mutates state", async () => {
    const hp = await demoApp();
    close = () => hp.app.close();
    const c = await wsClient(hp.app);
    c.send({ type: "hello", deviceToken: "demo" });
    const welcome = await c.next((m) => m.type === "welcome");
    expect(welcome.device).toMatchObject({ id: "demo-desk", profileId: "desk-monitor", remote: false });
    expect(welcome.profile.id).toBe("desk-monitor");

    c.send({ type: "subscribe", keys: ["ha:light.kitchen", "agent:gaming-pc:sensors", "agent:gaming-pc:actions", "agents"] });
    const st = await c.next((m) => m.type === "state" && m.key === "ha:light.kitchen");
    expect(st.value.state).toBe("off");
    const sensors = await c.next((m) => m.type === "state" && m.key === "agent:gaming-pc:sensors");
    const pkg = sensors.value.sensors.find((s: any) => s.id === "cpu_package");
    expect(pkg.value).toBeGreaterThan(40);
    expect(pkg.value).toBeLessThan(80);
    const agents = await c.next((m) => m.type === "state" && m.key === "agents");
    expect(agents.value.map((a: any) => a.pcId)).toEqual(["gaming-pc", "mini-pc"]);

    c.send({ type: "action", id: "a1", action: { kind: "ha", domain: "light", service: "turn_on", data: { entity_id: "light.kitchen", brightness: 100 } } });
    expect(await c.next((m) => m.type === "action_result" && m.id === "a1")).toMatchObject({ ok: true });
    const on = await c.next((m) => m.type === "state" && m.key === "ha:light.kitchen" && m.value.state === "on");
    expect(on.value.attributes.brightness).toBe(100);

    c.send({ type: "action", id: "a2", action: { kind: "agent", pc: "gaming-pc", action: "open-drive-c" } });
    expect(await c.next((m) => m.id === "a2")).toMatchObject({ type: "action_result", ok: true });
    c.send({ type: "action", id: "a3", action: { kind: "agent", pc: "gaming-pc", action: "sleep" } });
    expect(await c.next((m) => m.id === "a3")).toMatchObject({ ok: false, error: "confirm-required" });
    c.send({ type: "action", id: "a4", action: { kind: "agent", pc: "gaming-pc", action: "sleep" }, confirmed: true });
    expect(await c.next((m) => m.id === "a4")).toMatchObject({ ok: true });
    c.ws.terminate();
  });

  it("WS from a Tailscale IP is remote and home-only actions are refused", async () => {
    const hp = await demoApp();
    close = () => hp.app.close();
    const c = await wsClient(hp.app, "100.88.1.2");
    c.send({ type: "hello", deviceToken: "demo" });
    const welcome = await c.next((m) => m.type === "welcome");
    expect(welcome.device.remote).toBe(true);
    c.send({ type: "action", id: "r1", action: { kind: "agent", pc: "gaming-pc", action: "restart" }, confirmed: true });
    expect(await c.next((m) => m.id === "r1")).toMatchObject({ ok: false, error: "home-only" });
    c.ws.terminate();
  });

  it("unknown token → unauthorized", async () => {
    const hp = await demoApp();
    close = () => hp.app.close();
    const c = await wsClient(hp.app);
    c.send({ type: "hello", deviceToken: "nope" });
    expect(await c.next((m) => m.type === "unauthorized")).toMatchObject({ reason: "unknown-token" });
  });

  it("POST /api/demo/ring broadcasts a doorbell takeover (debounced)", async () => {
    const hp = await demoApp();
    close = () => hp.app.close();
    const desk = await wsClient(hp.app);
    const fire = await wsClient(hp.app);
    desk.send({ type: "hello", deviceToken: "demo" });
    fire.send({ type: "hello", deviceToken: "demo-fire" });
    await desk.next((m) => m.type === "welcome");
    await fire.next((m) => m.type === "welcome");

    const r = await hp.app.inject({ method: "POST", url: "/api/demo/ring" });
    expect(r.json()).toMatchObject({ ok: true });
    for (const c of [desk, fire]) {
      const t = await c.next((m) => m.type === "takeover");
      expect(t.takeover).toMatchObject({
        kind: "doorbell",
        camera: "camera.front_door",
        streamUrl: "/api/camera/camera.front_door/stream",
        snapshotUrl: "/api/camera/camera.front_door/snapshot",
        closeAfterMs: 45_000,
      });
    }
    // the debounce on the takeover manager itself: a second ring within 10 s is ignored
    expect(hp.takeover.ring("front")).toBeUndefined();
    desk.ws.terminate();
    fire.ws.terminate();
  });

  it("profile PUT pushes a profile message to screens using it", async () => {
    const hp = await demoApp();
    close = () => hp.app.close();
    const c = await wsClient(hp.app);
    c.send({ type: "hello", deviceToken: "demo-fire" });
    await c.next((m) => m.type === "welcome");
    const { session } = (await hp.app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "demo" } })).json();
    const res = await hp.app.inject({
      method: "PUT",
      url: "/api/admin/profiles/fire-hd8",
      headers: { authorization: `Bearer ${session}`, "content-type": "text/yaml" },
      payload: "id: fire-hd8\nname: Fire renamed\ngrid: {cols: 4, rows: 6}\nlite: true\n",
    });
    expect(res.json()).toEqual({ ok: true });
    const p = await c.next((m) => m.type === "profile");
    expect(p.profile.name).toBe("Fire renamed");
    c.ws.terminate();
  });

  it("assistant route without provider returns no-provider", async () => {
    const hp = await demoApp();
    close = () => hp.app.close();
    const { session } = (await hp.app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "demo" } })).json();
    const r = await hp.app.inject({ method: "POST", url: "/api/admin/assistant", headers: { authorization: `Bearer ${session}` }, payload: { messages: [{ role: "user", content: "hi" }] } });
    expect(r.json()).toEqual({ error: "no-provider" });
  });
});
