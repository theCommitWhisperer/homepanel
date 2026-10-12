import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, defaultConfigPath, parseConfig, resolveConfigPath } from "../src/config.js";

const minimal = `
pcId: gaming-pc
mqtt: { url: "mqtt://192.168.1.10:1883" }
key: 0123456789abcdef0123
`;

describe("config", () => {
  it("applies defaults", () => {
    const c = parseConfig(minimal);
    expect(c).toMatchObject({
      pcId: "gaming-pc",
      name: "gaming-pc",
      publishIntervalMs: 2000,
      drivesIntervalMs: 60000,
      sensors: "auto",
      ha_sensors: "default",
      sensorSource: "auto",
      lhmUrl: "http://localhost:8085/data.json",
      actions: {},
    });
    expect(c.mqtt.rejectUnauthorized).toBe(true);
  });

  it("the shipped example is valid and has the day-one actions", () => {
    const text = readFileSync(new URL("../agent.example.yaml", import.meta.url), "utf8");
    const c = parseConfig(text);
    for (const id of [
      "open-drive-c", "open-drive-d", "open-downloads", "open-projects", "launch-studio", "launch-steam",
      "launch-discord", "play-pause", "next-track", "vol-up", "vol-down", "mute-mic", "monitors-off",
      "audio-speakers", "audio-headphones", "lock", "sleep", "restart", "shutdown",
    ]) expect(c.actions[id], id).toBeDefined();
    expect(c.actions["launch-studio"]).toMatchObject({ type: "launch", find: expect.stringContaining("RobloxStudioBeta.exe") });
    expect(c.actions["restart"]).toMatchObject({ guard: "confirm+home-only" });
    expect(c.actions["open-drive-c"]).toMatchObject({ type: "open", path: "C:\\" });
  });

  const bad = (yaml: string, match: RegExp) => {
    try {
      parseConfig(yaml);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(match);
      return;
    }
    throw new Error("expected ConfigError");
  };

  it("reports helpful errors", () => {
    bad("pcId: Gaming PC\nmqtt: {url: 'mqtt://x'}\nkey: 0123456789abcdef0", /pcId: use lowercase/);
    bad("pcId: pc\nmqtt: {url: 'http://x'}\nkey: 0123456789abcdef0", /mqtt\.url/);
    bad("pcId: pc\nmqtt: {url: 'mqtt://x'}\nkey: short", /key/);
    bad(minimal + "actions:\n  x: { type: teleport }", /actions\.x/);
    bad(minimal + "actions:\n  x: { type: keys, key: f13 }", /actions\.x\.key/);
    bad(minimal + "actions:\n  x: { type: launch }", /exactly one of `exe` or `find`/);
    bad(minimal + "actions:\n  x: { type: launch, exe: a.exe, find: b }", /exactly one/);
    bad(minimal + "actions:\n  x: { type: launch, exe: 'a\"b.exe' }", /double quotes/);
    bad(minimal + "actions:\n  Bad Id: { type: system, op: lock }", /action ids/);
    bad(minimal + "actions:\n  x: { type: url, url: 'file:///C:/Windows' }", /actions\.x\.url: must be/);
    bad(minimal + "actions:\n  x: { type: system, op: lock, extra: 1 }", /Unrecognized key/);
    bad(minimal + "bogus: 1", /Unrecognized key/);
    bad("pcId: [unclosed", /invalid YAML/);
  });

  it("accepts sensor lists", () => {
    const c = parseConfig(minimal + "sensors: [cpu_package, 'gpu_*']\nha_sensors: none");
    expect(c.sensors).toEqual(["cpu_package", "gpu_*"]);
    expect(c.ha_sensors).toBe("none");
  });

  it("default config paths per platform", () => {
    expect(defaultConfigPath("win32", { ProgramData: "C:\\ProgramData" })).toMatch(/ProgramData.HomePanel.agent\.yaml$/);
    expect(defaultConfigPath("linux", { HOME: "/home/kevin" })).toBe("/home/kevin/.config/homepanel/agent.yaml");
    expect(defaultConfigPath("linux", { HOME: "/home/kevin", XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/homepanel/agent.yaml");
  });

  it("resolution order: flag > env > next to program > default", () => {
    const env = { HOME: "/home/k" };
    expect(resolveConfigPath("/x/a.yaml", { env })).toBe("/x/a.yaml");
    expect(resolveConfigPath(undefined, { env: { ...env, HOMEPANEL_AGENT_CONFIG: "/e.yaml" } })).toBe("/e.yaml");
    expect(resolveConfigPath(undefined, { env, platform: "linux", programDir: "/opt/hp", exists: (p) => p === "/opt/hp/agent.yaml" })).toBe("/opt/hp/agent.yaml");
    expect(resolveConfigPath(undefined, { env, platform: "linux", programDir: "/opt/hp", exists: () => false })).toBe("/home/k/.config/homepanel/agent.yaml");
  });
});
