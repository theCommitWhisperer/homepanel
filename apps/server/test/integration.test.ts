import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { demoApp, plainApp, tmpDir, wsClient } from "./helpers.js";
import { bootstrapScript } from "../src/routes/agentDownload.js";

describe("wildcard subscriptions (ha:<domain>.*)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("sends every entity of the domain as its own key, now and on change", async () => {
    const hp = await demoApp();
    close = () => hp.app.close();
    const a = await wsClient(hp.app);
    a.send({ type: "hello", deviceToken: "demo" });
    await a.next((m) => m.type === "welcome");
    a.send({ type: "subscribe", keys: ["ha:light.*"] });
    await a.next((m) => m.key === "ha:light.kitchen");
    await a.next((m) => m.key === "ha:light.living_room");
    await a.next((m) => m.key === "ha:light.desk_lamp");
    expect(a.msgs.some((m) => m.key === "ha:sensor.outdoor_temperature")).toBe(false);

    hp.hub.set("ha:light.new_one", { entity_id: "light.new_one", state: "on" });
    await a.next((m) => m.key === "ha:light.new_one");
    a.ws.terminate();
  });
});

describe("PC agent download", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("serves a bootstrap pointing at this host and only allowlisted files", async () => {
    const agentDir = tmpDir("hp-agent-");
    fs.mkdirSync(path.join(agentDir, "scripts"));
    fs.writeFileSync(path.join(agentDir, "install.ps1"), "# installer");
    fs.writeFileSync(path.join(agentDir, "homepanel-agent.mjs"), "// agent");
    const hp = await plainApp({ AGENT_DIST: agentDir });
    close = () => hp.app.close();

    const boot = await hp.app.inject({ url: "/agent/install.ps1", headers: { host: "192.168.1.20:8080" } });
    expect(boot.statusCode).toBe(200);
    expect(boot.body).toContain("-Server '192.168.1.20'");
    expect(boot.body).toContain("http://192.168.1.20:8080/agent/files/");

    const f = await hp.app.inject({ url: "/agent/files/homepanel-agent.mjs" });
    expect(f.statusCode).toBe(200);
    expect(f.body).toBe("// agent");
    expect((await hp.app.inject({ url: "/agent/files/../package.json" })).statusCode).toBe(404);
    expect((await hp.app.inject({ url: "/agent/files/secret.txt" })).statusCode).toBe(404);
  });

  it("bootstrap refuses to run without admin and passes the server", () => {
    const s = bootstrapScript("http://hp.local:8080", "hp.local");
    expect(s).toContain("Run as administrator");
    expect(s).toContain("-Server 'hp.local'");
  });
});
