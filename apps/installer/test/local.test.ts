import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { lhmConfigXml, lhmConfigured, parseLhmConfig, patchAgentYaml, readAgentConn, sanitizePcId, dotEnv } from "../src/local/files.js";
import { findServers, hostSteps, primaryInterface, runLocalSteps } from "../src/local/flow.js";
import { hostFlow, joinFlow } from "../src/local/modes.js";
import { systemdUnit } from "../src/local/ops.js";
import { firewallRulePs, icaclsArgs, loopingCmd, psStr, registerTaskPs, serviceEnvPs, winArg, winCmdLine } from "../src/local/ps.js";
import { main } from "../src/main.js";
import { selfCommand } from "../src/runtime.js";
import { StateStore } from "../src/state.js";
import { memoryOut, scriptedPrompter } from "../src/ui.js";
import { fakeCtx, FakeOps, fakePaths, World } from "./fake-win.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hp-local-"));
});

describe("PowerShell / Windows quoting", () => {
  it("psStr doubles single quotes (incl. typographic ones)", () => {
    expect(psStr("C:\\Users\\O'Brien")).toBe("'C:\\Users\\O''Brien'");
    expect(psStr("a\u2019b")).toBe("'a\u2019\u2019b'");
  });
  it("winArg follows CommandLineToArgvW rules", () => {
    expect(winArg("plain")).toBe("plain");
    expect(winArg("C:\\Program Files\\HomePanel\\HomePanel.exe")).toBe('"C:\\Program Files\\HomePanel\\HomePanel.exe"');
    expect(winArg("C:\\a b\\")).toBe('"C:\\a b\\\\"');
    expect(winArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(winArg("")).toBe('""');
    expect(winCmdLine(["agent", "run", "--config", "C:\\ProgramData\\HomePanel\\agent.yaml"])).toBe("agent run --config C:\\ProgramData\\HomePanel\\agent.yaml");
  });
  it("scheduled task scripts: startup/SYSTEM and logon/user, no time limit, restart every minute", () => {
    const s = registerTaskPs({ name: "HomePanel Server", description: "it's the server", file: "C:\\Windows\\System32\\cmd.exe", args: ["/c", "C:\\Program Data\\run.cmd"], trigger: "startup" });
    expect(s).toContain("New-ScheduledTaskTrigger -AtStartup");
    expect(s).toContain("New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest");
    expect(s).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)");
    expect(s).toContain(`-Argument '/c "C:\\Program Data\\run.cmd"'`);
    expect(s).toContain("-Description 'it''s the server'");
    const l = registerTaskPs({ name: "HomePanel Agent", description: "d", file: "x.exe", args: [], trigger: "logon", user: "PC\\O'Brien", delayS: 10 });
    expect(l).toContain("New-ScheduledTaskTrigger -AtLogOn -User 'PC\\O''Brien'");
    expect(l).toContain("-LogonType Interactive -RunLevel Highest");
    expect(l).toContain("$trigger.Delay = 'PT10S'");
    expect(l).not.toContain("-Argument");
    expect(() => registerTaskPs({ name: "x", description: "", file: "f", args: [], trigger: "logon" })).toThrow();
  });
  it("firewall rule is idempotent and private-only; service env uses the registry Environment value", () => {
    const f = firewallRulePs({ name: "HomePanel-MQTT-TCP-1883", displayName: "MQTT", port: 1883, profile: "Private" });
    expect(f).toMatch(/if \(-not \(Get-NetFirewallRule -Name 'HomePanel-MQTT-TCP-1883'/);
    expect(f).toContain("-LocalPort 1883 -Action Allow -Profile Private");
    const e = serviceEnvPs("mosquitto", { MOSQUITTO_DIR: "C:\\ProgramData\\HomePanel\\mosquitto" });
    expect(e).toContain("HKLM:\\SYSTEM\\CurrentControlSet\\Services\\mosquitto");
    expect(e).toContain("-Name 'Environment' -PropertyType MultiString -Value @('MOSQUITTO_DIR=C:\\ProgramData\\HomePanel\\mosquitto')");
  });
  it("cmd wrapper escapes % and loops without `timeout` (fails without a console)", () => {
    const c = loopingCmd({ title: "t", env: { DATA_DIR: "C:\\Data\\100%" }, file: "C:\\Program Files\\HomePanel\\HomePanel.exe", args: ["server"], log: "C:\\logs\\s.log" });
    expect(c).toContain('set "DATA_DIR=C:\\Data\\100%%"');
    expect(c).toContain('"C:\\Program Files\\HomePanel\\HomePanel.exe" "server" >> "C:\\logs\\s.log" 2>&1');
    expect(c).toContain("ping -n 6 127.0.0.1 >nul");
    expect(c).not.toContain("timeout");
    expect(c.split("\r\n")).toContain("goto loop");
    expect(() => loopingCmd({ title: "t", file: 'a"b', args: [] })).toThrow();
  });
  it("icacls keeps only SYSTEM + Administrators (+ user)", () => {
    expect(icaclsArgs("C:\\x", { dir: true })).toEqual(["C:\\x", "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]);
    expect(icaclsArgs("C:\\a.yaml", { dir: false, user: "PC\\kevin" }).slice(-1)).toEqual(["PC\\kevin:M"]);
  });
});

describe("file helpers", () => {
  it("LHM config: sets web server/tray keys, keeps the rest, round-trips", () => {
    const existing = `<?xml version="1.0" encoding="utf-8"?><configuration><appSettings><add key="mainForm.Width" value="470" /><add key="runWebServerMenuItem" value="false" /><add key="x&amp;y" value="a&quot;b" /></appSettings></configuration>`;
    expect(lhmConfigured(existing)).toBe(false);
    const xml = lhmConfigXml(existing);
    const m = parseLhmConfig(xml);
    expect(m.get("mainForm.Width")).toBe("470");
    expect(m.get("x&y")).toBe('a"b');
    expect(m.get("runWebServerMenuItem")).toBe("true");
    expect(m.get("listenerPort")).toBe("8085");
    expect(m.get("startMinMenuItem")).toBe("true");
    expect(m.get("minTrayMenuItem")).toBe("true");
    expect(lhmConfigured(xml)).toBe(true);
    expect(lhmConfigured(lhmConfigXml(undefined))).toBe(true);
  });
  it("agent.yaml patch keeps buttons and comments", () => {
    const y = "# my buttons\npcId: old\nmqtt:\n  url: mqtt://x:1883\nkey: k\nactions:\n  open-sovereign: { type: open, path: 'D:\\Projects' } # keep me\n";
    const out = patchAgentYaml(y, { pcId: "gaming-pc", mqttUrl: "mqtt://127.0.0.1:1883", mqttUser: "homepanel", mqttPass: "p@ss", key: "newkey" });
    expect(out).toContain("# my buttons");
    expect(out).toContain("# keep me");
    const c = readAgentConn(out)!;
    expect(c).toMatchObject({ pcId: "gaming-pc", mqttUrl: "mqtt://127.0.0.1:1883", mqttUser: "homepanel", mqttPass: "p@ss", key: "newkey" });
    expect(YAML.parse(out).actions["open-sovereign"].path).toBe("D:\\Projects");
  });
  it("misc", () => {
    expect(sanitizePcId("KEVIN-RIG_01")).toBe("kevin-rig-01");
    expect(sanitizePcId("--")).toBe("pc");
    expect(dotEnv({ A: "x y", B: "plain", C: undefined })).toContain('A="x y"\nB=plain\n');
    expect(() => dotEnv({ A: 'a"b' })).toThrow();
    expect(
      primaryInterface({
        "vEthernet (WSL)": [{ address: "172.20.0.1", family: "IPv4", internal: false, mac: "00:15:5d:00:00:01", netmask: "", cidr: null }],
        Ethernet: [{ address: "192.168.1.50", family: "IPv4", internal: false, mac: "aa:bb:cc:dd:ee:ff", netmask: "", cidr: null }],
      } as any),
    ).toEqual({ ip: "192.168.1.50", mac: "AA:BB:CC:DD:EE:FF" });
    const u = systemdUnit({ name: "HomePanel Server", description: "d", file: "/usr/bin/node", args: ["/r/a b.js"], trigger: "startup", env: { DATA_DIR: "/var/lib/homepanel/server" } });
    expect(u).toContain('ExecStart=/usr/bin/node "/r/a b.js"');
    expect(u).toContain("Environment=DATA_DIR=/var/lib/homepanel/server");
    expect(u).toContain("Restart=always");
  });
  it("selfCommand: SEA → exe + subcommand; source → node + dist entry", () => {
    expect(selfCommand("C:\\PF\\HomePanel.exe", "agent", ["run"], { sea: true })).toEqual({ file: "C:\\PF\\HomePanel.exe", args: ["agent", "run"] });
    const s = selfCommand(null, "server", [], { sea: false, repoRoot: "/repo" });
    expect(s.file).toBe(process.execPath);
    expect(s.args).toEqual([join("/repo", "apps", "server", "dist", "index.js")]);
    expect(selfCommand(null, "agent", ["init"], { sea: false, repoRoot: "/repo" }).args[0]).toBe(join("/repo", "apps", "agent", "dist", "homepanel-agent.mjs"));
  });
});

describe("Host on this PC (fake Windows)", () => {
  it("--yes: installs + configures everything, then a second run changes nothing", async () => {
    const { ctx, ops, world, out } = fakeCtx({ root, prompt: scriptedPrompter([]), yes: true });
    const code = await hostFlow(ctx);
    expect(out.text()).not.toContain("ERR");
    expect(code).toBe(0);

    // winget installs, exact ids
    expect(ops.calls.filter((c) => c.startsWith("install"))).toEqual([
      "install LibreHardwareMonitor.LibreHardwareMonitor scope=machine",
      "install namazso.PawnIO silent",
      "install EclipseFoundation.Mosquitto silent",
    ]);
    // LHM settings next to the exe
    expect(lhmConfigured(readFileSync(ops.lhmExe.replace(/\.exe$/, ".config"), "utf8"))).toBe(true);
    // Mosquitto: our config, hashed login, service env, works
    const conf = readFileSync(ctx.paths.mosquittoConf, "utf8");
    expect(conf).toContain("listener 1883 0.0.0.0");
    expect(conf).toContain("allow_anonymous false");
    expect(conf).toContain(`password_file ${ctx.paths.mosquittoPasswd}`);
    expect(ops.services.get("mosquitto")!.env).toEqual([`MOSQUITTO_DIR=${ctx.paths.mosquittoDir}`]);
    expect(world.mqttPass).toBe(ctx.store.secrets.mqttPassword);
    // firewall
    expect([...ops.rules.values()].map((r) => `${r.port}/${r.profile}`)).toEqual(["8080/Private", "1883/Private"]);
    // server settings + wrapper (DATA_DIR via the .cmd since tasks can't set env)
    const env = readFileSync(join(ctx.paths.serverDir, ".env"), "utf8");
    expect(env).toContain("MQTT_URL=mqtt://127.0.0.1:1883");
    expect(env).toContain(`MQTT_PASS=${ctx.store.secrets.mqttPassword}`);
    expect(env).toContain(`ADMIN_PASSWORD=${ctx.store.secrets.adminPassword}`);
    const cmd = readFileSync(join(ctx.paths.serverDir, "run-server.cmd"), "utf8");
    expect(cmd).toContain(`set "DATA_DIR=${ctx.paths.serverDir}"`);
    expect(ops.acl.map((a) => a.path)).toContain(ctx.paths.serverDir);
    // tasks
    const tasks = ops.tasks;
    expect(tasks.get("HomePanel Server")).toMatchObject({ trigger: "startup", state: "Running" });
    expect(tasks.get("HomePanel Server")!.args).toEqual(["/c", join(ctx.paths.serverDir, "run-server.cmd")]);
    expect(tasks.get("HomePanel Agent")).toMatchObject({ trigger: "logon", user: "GAMING-PC\\kevin", state: "Running" });
    expect(tasks.get("HomePanel Agent")!.args.slice(0, 1)).toEqual(["--headless"]);
    expect(tasks.get("HomePanel Sensors")).toMatchObject({ trigger: "logon", file: ops.lhmExe });
    // agent registered with Wake-on-LAN MAC, yaml written by `agent init` with the key + MQTT login
    expect(world.agents.get("gaming-pc")).toMatchObject({ name: "Gaming PC", mac: "AA:BB:CC:DD:EE:FF" });
    const conn = readAgentConn(readFileSync(ctx.paths.agentYaml, "utf8"))!;
    expect(conn).toMatchObject({ pcId: "gaming-pc", mqttUrl: "mqtt://127.0.0.1:1883", mqttUser: "homepanel", key: world.agents.get("gaming-pc")!.key });
    expect(ops.calls.some((c) => c.includes(" init ") && !c.includes(ctx.store.secrets.mqttPassword!))).toBe(true); // secrets via env, not argv
    expect(ops.acl.find((a) => a.path === ctx.paths.agentYaml)?.user).toBe("GAMING-PC\\kevin");
    // browser paired with desk-monitor and opened
    expect(world.devices).toEqual([{ name: "GAMING-PC (this PC)", profileId: "desk-monitor", token: "tok-p1" }]);
    expect(ops.opened).toEqual(["http://localhost:8080/?token=tok-p1"]);
    // summary
    expect(out.text()).toContain(`password: ${ctx.store.secrets.adminPassword}`);
    expect(out.text()).toContain("http://192.168.1.50:8080");

    // second run: everything detected, nothing installed/registered again
    const before = ops.calls.length;
    const again = fakeCtx({ root, prompt: scriptedPrompter([]), yes: true, world, ops });
    expect(await hostFlow(again.ctx)).toBe(0);
    const newCalls = ops.calls.slice(before);
    expect(newCalls.filter((c) => /^(install|register-task|firewall|run )/.test(c))).toEqual([]);
    expect(again.ctx.store.secrets.adminPassword).toBe(ctx.store.secrets.adminPassword);
    expect(again.ctx.store.secrets.mqttPassword).toBe(ctx.store.secrets.mqttPassword);
  });

  it("interactive: one up-front choice, then y/N per step; declining changes nothing", async () => {
    const steps = hostSteps("win32").length; // program step is already done (not SEA)
    const prompt = scriptedPrompter(["ask", ...Array(steps - 1).fill(false)]);
    const { ctx, ops } = fakeCtx({ root, prompt });
    expect(await hostFlow(ctx)).toBe(0);
    expect(prompt.asked.filter((m) => m === "Do this now?")).toHaveLength(steps - 1);
    expect(ops.calls.filter((c) => !c.startsWith("stop"))).toEqual([]);
    expect(Object.values(ctx.store.state.steps).filter((s) => s.status === "skipped")).toHaveLength(steps - 1);
  });

  it("asks for the admin password choice and the PC id when not --yes ('do all' mode)", async () => {
    const prompt = scriptedPrompter(["all", "type", "hunter22", "hunter22", "kevins-rig", "Kevin's rig"]);
    const { ctx, world } = fakeCtx({ root, prompt });
    expect(await hostFlow(ctx)).toBe(0);
    expect(ctx.store.secrets.adminPassword).toBe("hunter22");
    expect(world.agents.get("kevins-rig")?.name).toBe("Kevin's rig");
  });

  it("failure → fix shown → quit; resume later continues without redoing work; retry works", async () => {
    const world = new World();
    world.serverBroken = true;
    const p1 = scriptedPrompter(["quit"]);
    const first = fakeCtx({ root, prompt: p1, yes: true, world });
    first.ops.failInstall.set("EclipseFoundation.Mosquitto", 1);
    // mosquitto install fails once → "What now?" … we answer retry via a second prompter below
    const p0 = scriptedPrompter(["retry", "quit"]);
    first.ctx.prompt = p0;
    expect(await hostFlow(first.ctx)).toBe(1);
    const t = first.out.text();
    expect(t).toContain("did not answer");
    expect(t).toContain("netstat -ano | findstr :8080");
    expect(first.ops.calls.filter((c) => c.startsWith("install EclipseFoundation"))).toHaveLength(2);
    const mq = first.ctx.store.secrets.mqttPassword;
    expect(first.ctx.store.state.steps["host.server"]?.status).toBe("failed");

    world.serverBroken = false;
    const before = first.ops.calls.length;
    const second = fakeCtx({ root, prompt: scriptedPrompter([]), yes: true, world, ops: first.ops });
    expect(await hostFlow(second.ctx)).toBe(0);
    const calls = first.ops.calls.slice(before);
    expect(calls.filter((c) => c.startsWith("install"))).toEqual([]);
    expect(calls).toContain("start-task HomePanel Server");
    expect(second.ctx.store.secrets.mqttPassword).toBe(mq);
  });

  it("public network: rules are added and the network is switched to Private after a yes", async () => {
    const { ctx, ops } = fakeCtx({ root, prompt: scriptedPrompter([]), yes: true });
    ops.category = "Public";
    expect(await hostFlow(ctx)).toBe(0);
    expect(ops.calls).toContain("network-private");
  });

  it("SEA: copies the running exe into Program Files and tasks run the installed copy", async () => {
    const running = join(root, "Downloads", "HomePanel-Setup.exe");
    mkdirSync(join(root, "Downloads"), { recursive: true });
    writeFileSync(running, "SEA-BINARY");
    const { ctx, ops } = fakeCtx({ root, prompt: scriptedPrompter([]), yes: true, sea: { running } });
    expect(await hostFlow(ctx)).toBe(0);
    expect(readFileSync(ctx.paths.exe!, "utf8")).toBe("SEA-BINARY");
    expect(readFileSync(join(ctx.paths.serverDir, "run-server.cmd"), "utf8")).toContain(`"${ctx.paths.exe}" "server"`);
    expect(ops.calls.some((c) => c.startsWith(`run ${ctx.paths.exe} agent init`))).toBe(true);
    expect(readFileSync(join(ctx.paths.dataRoot, "run-agent.cmd"), "utf8")).toContain(`"${ctx.paths.exe}" "agent" "run" "--config"`);
  });

  it("an existing agent.yaml keeps its buttons; only the connection is updated", async () => {
    const paths = fakePaths(root);
    mkdirSync(paths.dataRoot, { recursive: true });
    writeFileSync(paths.agentYaml, "# mine\npcId: gaming-pc\nmqtt: { url: 'mqtt://old:1883' }\nkey: old\nactions:\n  launch-obs: { type: launch, exe: 'obs64.exe' }\n");
    const { ctx, ops } = fakeCtx({ root, prompt: scriptedPrompter([]), yes: true });
    expect(await hostFlow(ctx)).toBe(0);
    const y = readFileSync(paths.agentYaml, "utf8");
    expect(y).toContain("launch-obs");
    expect(y).toContain("# mine");
    expect(readAgentConn(y)?.mqttUrl).toBe("mqtt://127.0.0.1:1883");
    expect(ops.calls.some((c) => c.includes(" init "))).toBe(false);
  });
});

describe("Host on this PC (fake Linux)", () => {
  it("skips Windows-only steps and uses systemd + conf.d", async () => {
    const { ctx, ops } = fakeCtx({ root, prompt: scriptedPrompter([]), yes: true, platform: "linux" });
    expect(await hostFlow(ctx)).toBe(0);
    expect(ops.calls.filter((c) => c.startsWith("install"))).toEqual(["install EclipseFoundation.Mosquitto silent"]);
    expect(ops.tasks.get("HomePanel Server")?.env).toEqual({ DATA_DIR: ctx.paths.serverDir });
    expect(existsSync(join(ctx.paths.serverDir, "run-server.cmd"))).toBe(false);
    expect(ops.calls).toContain(`run chgrp mosquitto ${ctx.paths.mosquittoPasswd}`);
  });
});

describe("Join this PC", () => {
  it("finds nothing → typed address; admin + MQTT login; agent points at the server host", async () => {
    const world = new World();
    world.remote = { url: "http://192.168.1.20:8080", adminPassword: "adminpw" };
    const prompt = scriptedPrompter(["__type", "192.168.1.20", "wrong", true, "adminpw", "", "mqttpw", "all", "", ""]);
    const { ctx, ops } = fakeCtx({ root, prompt, world });
    ctx.mqttCheck = async (url, user, pass) => {
      expect(url).toBe("mqtt://192.168.1.20:1883");
      if (user !== "homepanel" || pass !== "mqttpw") throw new Error("Not authorized");
    };
    ctx.fetchImpl = ((orig) => (async (u: any, i: any) => {
      const s = String(u);
      if (!s.startsWith("http://192.168.1.20") && !s.includes(":8085")) throw new TypeError("fetch failed");
      return orig(u, i);
    }) as typeof fetch)(ctx.fetchImpl);
    ctx.net = () => ({ hostname: "OFFICE-PC", mac: "11:22:33:44:55:66" }); // no ip → no LAN scan
    expect(await joinFlow(ctx)).toBe(0);
    expect(world.agents.get("office-pc")).toMatchObject({ name: "OFFICE-PC", mac: "11:22:33:44:55:66" });
    const c = readAgentConn(readFileSync(ctx.paths.agentYaml, "utf8"))!;
    expect(c).toMatchObject({ pcId: "office-pc", mqttUrl: "mqtt://192.168.1.20:1883", mqttPass: "mqttpw" });
    expect(ops.calls.some((x) => x.startsWith("install EclipseFoundation"))).toBe(false);
    expect(ops.tasks.has("HomePanel Server")).toBe(false);
    expect(ops.tasks.has("HomePanel Agent")).toBe(true);
  });

  it("findServers probes mDNS results, defaults and the /24", async () => {
    const seen: string[] = [];
    const f = (async (u: any) => {
      seen.push(String(u));
      if (String(u).startsWith("http://192.168.1.77:8080")) return new Response(JSON.stringify({ ok: true, version: "0.2.0" }));
      throw new TypeError("nope");
    }) as typeof fetch;
    const found = await findServers({ fetchImpl: f, net: () => ({ ip: "192.168.1.50", hostname: "x" }) }, { mdns: async () => ["http://10.0.0.9:8080"] });
    expect(found).toEqual(["http://192.168.1.77:8080"]);
    expect(seen).toContain("http://10.0.0.9:8080/api/health");
    expect(seen).toContain("http://homeassistant.local:8080/api/health");
    expect(seen.some((s) => s.startsWith("http://192.168.1.50:"))).toBe(false);
  });
});

describe("main()", () => {
  it("Windows, not elevated: relaunches itself elevated with the same args", async () => {
    const ops = new FakeOps(root, new World(), fakePaths(root));
    ops.elevated = false;
    const out = memoryOut();
    const code = await main(["setup", "--mode", "host", "--yes"], { out, ops, prompt: scriptedPrompter([]), pause: async () => undefined });
    expect(code).toBe(0);
    expect(ops.relaunched).toHaveLength(1);
    expect(ops.relaunched[0]!.args.slice(-5)).toEqual(["--mode", "host", "--yes", "--elevated", "--pause"]);
    expect(ops.relaunched[0]!.args).toContain("setup");
  });
  it("start menu → move (nothing hosted here) → close; --version; HA mode needs no elevation", async () => {
    const ops = new FakeOps(root, new World(), fakePaths(root));
    const out = memoryOut();
    let paused = 0;
    const code = await main(["setup", "--pause"], { out, ops, prompt: scriptedPrompter(["move", "quit"]), pause: async () => void paused++ });
    expect(code).toBe(0);
    expect(out.text()).toContain("nothing to move");
    expect(paused).toBe(1);
    const v = memoryOut();
    expect(await main(["--version"], { out: v })).toBe(0);
    expect(v.text()).toMatch(/^\d+\.\d+\.\d+/);
    ops.elevated = false;
    const h = memoryOut();
    process.env.HOMEPANEL_HOME = join(root, "hp");
    expect(await main(["setup", "--mode", "ha", "--step", "screens"], { out: h, ops, prompt: scriptedPrompter([true, true, true]) })).toBeTypeOf("number");
    expect(ops.relaunched).toHaveLength(0);
  });
});

describe("runLocalSteps", () => {
  it("records statuses in the store under the prefix", async () => {
    const { ctx } = fakeCtx({ root, prompt: scriptedPrompter([]), yes: true });
    const r = await runLocalSteps(ctx, [{ id: "x", title: "X", why: "", detect: async () => ({ done: false, detail: "" }), actions: async () => ["a"], run: async () => "manual" }], "t");
    expect(r.results[0]!.status).toBe("manual");
    expect(new StateStore(ctx.paths.setupDir).state.steps["t.x"]?.status).toBe("manual");
  });
});
