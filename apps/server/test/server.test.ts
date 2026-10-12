import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDotEnv, withDataDirEnv } from "../src/config.js";
import { demoApp, plainApp, tmpDir, wsClient } from "./helpers.js";

describe("media", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("serves files, lists them, and blocks path traversal", async () => {
    const hp = await plainApp();
    close = () => hp.app.close();
    fs.writeFileSync(path.join(hp.dir, "secret.txt"), "top secret");
    fs.mkdirSync(path.join(hp.dir, "media", "photos"), { recursive: true });
    fs.writeFileSync(path.join(hp.dir, "media", "photos", "a.png"), "png");
    fs.writeFileSync(path.join(hp.dir, "media", ".hidden.gif"), "x");

    const list = (await hp.app.inject({ url: "/api/media" })).json();
    expect(list).toEqual(expect.arrayContaining(["homepanel.gif", "photos/a.png"]));
    expect(list).not.toContain(".hidden.gif");
    expect((await hp.app.inject({ url: "/media/photos/a.png" })).statusCode).toBe(200);

    for (const url of [
      "/media/../secret.txt",
      "/media/..%2fsecret.txt",
      "/media/%2e%2e/secret.txt",
      "/media/photos/../../secret.txt",
      "/media/..%5csecret.txt",
      "/media/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/media/.hidden.gif",
    ]) {
      const r = await hp.app.inject({ url });
      expect(r.statusCode, url).not.toBe(200);
      expect(r.body).not.toContain("top secret");
    }
  });

  it("requires a device token from outside the LAN", async () => {
    const hp = await demoApp();
    close = () => hp.app.close();
    const remote = { remoteAddress: "100.100.1.1" };
    expect((await hp.app.inject({ url: "/api/media", ...remote })).statusCode).toBe(401);
    expect((await hp.app.inject({ url: "/api/media?t=demo", ...remote })).statusCode).toBe(200);
    expect((await hp.app.inject({ url: "/media/homepanel.gif?t=demo", ...remote })).statusCode).toBe(200);
    expect((await hp.app.inject({ url: "/api/camera/camera.front_door/snapshot" })).statusCode).toBe(401);
  });
});

describe("subscription fan-out", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("sends current values on subscribe, then changes only for subscribed keys", async () => {
    const hp = await demoApp();
    close = () => hp.app.close();
    const a = await wsClient(hp.app);
    const b = await wsClient(hp.app);
    a.send({ type: "hello", deviceToken: "demo" });
    b.send({ type: "hello", deviceToken: "ipad" });
    await a.next((m) => m.type === "welcome");
    await b.next((m) => m.type === "welcome");
    a.send({ type: "subscribe", keys: ["ha:light.kitchen"] });
    b.send({ type: "subscribe", keys: ["ha:light.living_room"] });
    await a.next((m) => m.key === "ha:light.kitchen");
    await b.next((m) => m.key === "ha:light.living_room");

    hp.hub.set("ha:light.kitchen", { entity_id: "light.kitchen", state: "on" });
    await a.next((m) => m.key === "ha:light.kitchen" && m.value.state === "on");
    await new Promise((r) => setTimeout(r, 50));
    expect(b.msgs.some((m) => m.key === "ha:light.kitchen")).toBe(false);

    // subscribe replaces the set
    a.send({ type: "subscribe", keys: ["ha:light.desk_lamp"] });
    await a.next((m) => m.key === "ha:light.desk_lamp");
    const before = a.msgs.length;
    hp.hub.set("ha:light.kitchen", { entity_id: "light.kitchen", state: "off" });
    await new Promise((r) => setTimeout(r, 50));
    expect(a.msgs.slice(before).some((m) => m.key === "ha:light.kitchen")).toBe(false);
    a.ws.terminate();
    b.ws.terminate();
  });

  it("throttles agent sensors to 1/s (normal) and 1/10 s (lite), always delivering the latest", async () => {
    const hp = await demoApp();
    close = () => hp.app.close();
    const desk = await wsClient(hp.app);
    const fire = await wsClient(hp.app);
    desk.send({ type: "hello", deviceToken: "demo" });
    fire.send({ type: "hello", deviceToken: "fire" }); // fire-hd8 is lite
    await desk.next((m) => m.type === "welcome");
    await fire.next((m) => m.type === "welcome");
    const key = "agent:test-pc:sensors";
    desk.send({ type: "subscribe", keys: [key] });
    fire.send({ type: "subscribe", keys: [key] });
    await new Promise((r) => setTimeout(r, 50));

    // burst of 20 updates over ~1.5 s
    for (let i = 0; i < 20; i++) {
      hp.hub.set(key, { n: i, sensors: [] });
      await new Promise((r) => setTimeout(r, 75));
    }
    await new Promise((r) => setTimeout(r, 1100));
    const d = desk.msgs.filter((m) => m.key === key).map((m) => m.value.n);
    const f = fire.msgs.filter((m) => m.key === key).map((m) => m.value.n);
    expect(d.length).toBeGreaterThanOrEqual(2);
    expect(d.length).toBeLessThanOrEqual(4);
    expect(d.at(-1)).toBe(19); // trailing send carries the newest value
    expect(f).toEqual([0]); // lite: nothing more within 10 s
    // HA keys are never throttled
    for (let i = 0; i < 5; i++) hp.hub.set("ha:light.kitchen", { state: String(i) });
    desk.send({ type: "subscribe", keys: [key, "ha:light.kitchen"] });
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 5; i++) hp.hub.set("ha:light.kitchen", { state: "x" + i });
    await new Promise((r) => setTimeout(r, 50));
    expect(desk.msgs.filter((m) => m.key === "ha:light.kitchen" && String(m.value.state).startsWith("x"))).toHaveLength(5);
    desk.ws.terminate();
    fire.ws.terminate();
  });
});

describe("env", () => {
  it("parses dotenv files", () => {
    expect(parseDotEnv(`# c\nHA_URL=http://x:8123\nexport HA_TOKEN="a b#c"\nMQTT_PASS='p w' \nPORT=9000 # trailing\nbad line\n`)).toEqual({
      HA_URL: "http://x:8123",
      HA_TOKEN: "a b#c",
      MQTT_PASS: "p w",
      PORT: "9000",
    });
  });

  it("merges DATA_DIR/.env without overriding real env vars", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".env"), "HA_URL=http://from-file\nHA_TOKEN=file-token\nDATA_DIR=/elsewhere\n");
    const env = withDataDirEnv({ DATA_DIR: dir, HA_TOKEN: "real" }, []);
    expect(env.HA_URL).toBe("http://from-file");
    expect(env.HA_TOKEN).toBe("real");
    expect(env.DATA_DIR).toBe(dir);
  });

  it("first start copies data-example and generates an admin password", async () => {
    const dir = tmpDir();
    const { loadEnv } = await import("../src/config.js");
    const { buildApp } = await import("../src/app.js");
    const hp = await buildApp({ env: loadEnv({ DATA_DIR: dir, KIOSK_DIST: path.join(dir, "nokiosk") }, []), logger: false, connect: false });
    try {
      expect(fs.existsSync(path.join(dir, "config.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "profiles", "desk-monitor.yaml"))).toBe(true);
      const pw = fs.readFileSync(path.join(dir, "admin-password.txt"), "utf8").trim();
      expect(pw).toBe(hp.adminPassword);
      expect(pw.length).toBeGreaterThanOrEqual(10);
      const ok = await hp.app.inject({ method: "POST", url: "/api/admin/login", payload: { password: pw } });
      expect(ok.statusCode).toBe(200);
      // server runs without HA / MQTT
      expect((await hp.app.inject({ url: "/api/health" })).json()).toMatchObject({ ok: true, ha: "disconnected" });
    } finally {
      await hp.app.close();
    }
  });
});

describe("review fixes: X-Forwarded-For trust", () => {
  it("TRUST_PROXY ignores client-supplied XFF entries from a remote peer", async () => {
    const { plainApp } = await import("./helpers.js");
    const hp = await plainApp({ TRUST_PROXY: "1" });
    try {
      // remote client talks to us directly and claims to be on the LAN
      const spoof = await hp.app.inject({ url: "/api/media", remoteAddress: "100.100.1.1", headers: { "x-forwarded-for": "192.168.1.5" } });
      expect(spoof.statusCode).toBe(401);
      // a local reverse proxy forwarding a remote client → still remote
      const viaProxy = await hp.app.inject({ url: "/api/media", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "192.168.1.5, 8.8.8.8" } });
      expect(viaProxy.statusCode).toBe(401);
      // a local reverse proxy forwarding a LAN client → home
      const lan = await hp.app.inject({ url: "/api/media", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "192.168.1.5" } });
      expect(lan.statusCode).toBe(200);
    } finally {
      await hp.app.close();
    }
  });
});
