import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { ConfigError, defaultConfigPath, parseConfig, resolveConfigPath } from "../src/config.js";
import { defaultConfigYaml, EXAMPLE_INIT } from "../src/defaults.js";

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
      haDiscovery: true,
      haSensors: "default",
      lhmUrl: "http://localhost:8085/data.json",
      actions: {},
    });
  });

  it("accepts what the setup wizard writes (sensorSource: auto, empty actions)", () => {
    expect(parseConfig(minimal + "name: Gaming PC\nsensorSource: auto\nactions: {}\n").name).toBe("Gaming PC");
  });

  it("`init` output and the shipped example are valid and have Kevin's day-one actions", () => {
    const fromInit = parseConfig(defaultConfigYaml(EXAMPLE_INIT));
    const example = parseConfig(readFileSync(new URL("../agent.example.yaml", import.meta.url), "utf8"));
    expect(example).toEqual(fromInit);
    const ids = [
      "open-drive-c", "open-drive-d", "open-downloads", "open-projects", "launch-studio", "launch-steam",
      "launch-discord", "media-playpause", "media-next", "vol-up", "vol-down", "mute-mic", "audio-speakers",
      "audio-headphones", "monitors-off", "lock", "sleep", "restart", "shutdown",
    ];
    expect(Object.keys(fromInit.actions).sort()).toEqual([...ids].sort());
    const a = fromInit.actions;
    expect(a["open-drive-c"]).toMatchObject({ type: "open", path: "C:\\" });
    expect(a["open-projects"]).toMatchObject({ type: "open", path: "D:\\Projects" });
    expect(a["launch-steam"]).toMatchObject({ type: "launch", exe: "steam://open/main" });
    expect(a["launch-studio"]).toMatchObject({ type: "launch", exe: "roblox-studio:" });
    expect(a["media-playpause"]).toMatchObject({ type: "keys", keys: "media_play_pause" });
    expect(a["sleep"]).toMatchObject({ guard: "confirm" });
    expect(a["restart"]).toMatchObject({ guard: "confirm+home-only" });
    expect(a["shutdown"]).toMatchObject({ guard: "confirm+home-only" });
    // drive actions follow the open-drive-<letter> convention the kiosk drive widget relies on
    for (const id of Object.keys(a).filter((k) => k.startsWith("open-drive-"))) expect(id).toMatch(/^open-drive-[a-z]$/);
  });

  it("init quotes awkward values safely", () => {
    const c = parseConfig(defaultConfigYaml({ ...EXAMPLE_INIT, name: "Kevin's PC: #1", mqttPass: "p'a$s: #x", key: "k".repeat(43) }));
    expect(c.name).toBe("Kevin's PC: #1");
    expect(c.mqtt.password).toBe("p'a$s: #x");
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

  it("reports friendly errors with the path of the problem", () => {
    bad("pcId: Gaming PC\nmqtt: {url: 'mqtt://x'}\nkey: 0123456789abcdef0", /pcId: use lowercase/);
    bad("pcId: pc\nmqtt: {url: 'http://x'}\nkey: 0123456789abcdef0", /mqtt\.url: must look like mqtt:/);
    bad("pcId: pc\nmqtt: {url: 'mqtt://x'}\nkey: short", /key: key looks too short/);
    bad("mqtt: {url: 'mqtt://x'}\nkey: 0123456789abcdef0", /pcId: Required/);
    bad(minimal + "actions:\n  x: { type: teleport }", /actions\.x/);
    bad(minimal + "actions:\n  x: { type: keys, keys: ctrl+banana }", /actions\.x\.keys: unknown key "banana"/);
    bad(minimal + "actions:\n  x: { type: launch }", /actions\.x\.exe: Required/);
    bad(minimal + "actions:\n  x: { type: launch, exe: 'a\"b.exe' }", /double quotes/);
    bad(minimal + "actions:\n  x: { type: open }", /actions\.x\.path: Required/);
    bad(minimal + "actions:\n  x: { type: script }", /actions\.x\.script: Required/);
    bad(minimal + "actions:\n  Bad Id: { type: system, command: lock }", /action ids/);
    bad(minimal + "actions:\n  x: { type: system, command: format }", /actions\.x\.command/);
    bad(minimal + "actions:\n  x: { type: url, url: 'file:///C:/Windows' }", /not allowed/);
    bad(minimal + "actions:\n  x: { type: url, url: 'javascript:alert(1)' }", /not allowed/);
    bad(minimal + "actions:\n  x: { type: system, command: lock, guard: maybe }", /actions\.x\.guard/);
    bad(minimal + "actions:\n  x: { type: system, command: lock, extra: 1 }", /Unrecognized key/);
    bad(minimal + "bogus: 1", /Unrecognized key/);
    bad(minimal + "publishIntervalMs: 10", /publishIntervalMs/);
    bad("pcId: [unclosed", /invalid YAML/);
  });

  it("sensor lists and HA switches", () => {
    const c = parseConfig(minimal + "sensors: [cpu_package, 'gpu_*']\nhaDiscovery: false\nhaSensors: [cpu_package]");
    expect(c.sensors).toEqual(["cpu_package", "gpu_*"]);
    expect(c.haDiscovery).toBe(false);
    expect(c.haSensors).toEqual(["cpu_package"]);
  });

  // these expect POSIX separators (path.join is platform-native); Windows paths are covered by the win32 case
  it.skipIf(process.platform === "win32")("default config paths per platform", () => {
    expect(defaultConfigPath("win32", { ProgramData: "C:\\ProgramData" })).toMatch(/ProgramData.HomePanel.agent\.yaml$/);
    expect(defaultConfigPath("linux", { HOME: "/home/kevin" })).toBe("/home/kevin/.config/homepanel/agent.yaml");
    expect(defaultConfigPath("linux", { HOME: "/home/kevin", XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/homepanel/agent.yaml");
  });

  it.skipIf(process.platform === "win32")("resolution order: --config > env > next to the program > default", () => {
    const env = { HOME: "/home/k" };
    expect(resolveConfigPath("/x/a.yaml", { env })).toBe("/x/a.yaml");
    expect(resolveConfigPath(undefined, { env: { ...env, HOMEPANEL_AGENT_CONFIG: "/e.yaml" } })).toBe("/e.yaml");
    expect(resolveConfigPath(undefined, { env, platform: "linux", programDir: "/opt/hp", exists: (p) => p === "/opt/hp/agent.yaml" })).toBe("/opt/hp/agent.yaml");
    expect(resolveConfigPath(undefined, { env, platform: "linux", programDir: "/opt/hp", exists: () => false })).toBe("/home/k/.config/homepanel/agent.yaml");
  });
});

describe("cli args", () => {
  it("parses commands, flags and values", () => {
    expect(parseArgs([])).toEqual({ command: "run", positional: [], flags: {} });
    expect(parseArgs(["run", "--mock", "-c", "a.yaml"])).toEqual({ command: "run", positional: [], flags: { mock: true, c: "a.yaml", config: "a.yaml" } });
    expect(parseArgs(["test-action", "lock", "--really"])).toEqual({ command: "test-action", positional: ["lock"], flags: { really: true } });
    expect(parseArgs(["init", "--pc-id=gaming-pc", "--key", "abc"]).flags).toEqual({ "pc-id": "gaming-pc", key: "abc" });
  });
});
