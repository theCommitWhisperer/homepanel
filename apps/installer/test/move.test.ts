import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readAgentConn } from "../src/local/files.js";
import { hostFlow } from "../src/local/modes.js";
import { moveFlow } from "../src/local/move.js";
import { main, offerMove } from "../src/main.js";
import { StateStore } from "../src/state.js";
import { memoryOut, scriptedPrompter } from "../src/ui.js";
import { fakeCtx, FakeOps, fakePaths, World } from "./fake-win.js";

const HA = "http://192.168.1.60:8080";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hp-move-"));
});

/** A PC that ran "Host on this PC", with two layouts + config.yaml, and the HomePanel app on HA. */
async function hostedPc() {
  const first = fakeCtx({ root, prompt: scriptedPrompter([]), yes: true });
  expect(await hostFlow(first.ctx)).toBe(0);
  const { world, ops } = first;
  const prof = join(first.ctx.paths.serverDir, "profiles");
  mkdirSync(prof, { recursive: true });
  writeFileSync(join(prof, "desk-monitor.yaml"), "name: Kevin's desk\nwidgets: []\n");
  writeFileSync(join(prof, "kitchen-ipad.yaml"), "name: Kitchen\nwidgets: []\n");
  writeFileSync(join(first.ctx.paths.serverDir, "config.yaml"), "doorbells:\n  front: { trigger: binary_sensor.front_visitor }\n");
  world.remote = { url: HA, adminPassword: "ha-admin" };
  world.remoteProfiles = new Map([["desk-monitor", "name: example\nwidgets: []\n"]]);
  const ha = new StateStore(join(root, "ha-wizard"));
  ha.update({ serverUrl: HA, host: "192.168.1.60", haUrl: "http://192.168.1.60:8123", mqtt: { host: "192.168.1.60", port: 1883, username: "homepanel" } });
  ha.setSecret("adminPassword", "ha-admin");
  ha.setSecret("mqttPassword", "ha-mqtt");
  return { world, ops, ha, oldAdmin: first.ctx.store.secrets.adminPassword! };
}

function moveCtx(world: World, ops: FakeOps, answers: Parameters<typeof scriptedPrompter>[0], yes = true) {
  const c = fakeCtx({ root, prompt: scriptedPrompter(answers), yes, world, ops });
  c.ctx.mqttCheck = async (url, user, pass) => {
    if (url !== "mqtt://192.168.1.60:1883" || user !== "homepanel" || pass !== "ha-mqtt") throw new Error("Connection refused: Not authorized");
  };
  return c;
}

describe("Move the server to Home Assistant", () => {
  it("--yes: agent → HA broker, online on the new server, layouts + config copied, local server retired, browser re-paired", async () => {
    const { world, ops, ha } = await hostedPc();
    const { ctx, out } = moveCtx(world, ops, []);
    const before = ops.calls.length;
    expect(await moveFlow(ctx, { haStore: ha })).toBe(0);
    const text = out.text();
    expect(text).not.toContain("ERR");

    // (a) registered with the new server, agent.yaml rewritten (buttons kept), task restarted
    expect(world.requests).toContain(`POST ${HA}/api/admin/agents`);
    const yaml = readFileSync(ctx.paths.agentYaml, "utf8");
    expect(readAgentConn(yaml)).toMatchObject({ pcId: "gaming-pc", mqttUrl: "mqtt://192.168.1.60:1883", mqttUser: "homepanel", mqttPass: "ha-mqtt" });
    expect(yaml).toContain("open-drive-c");
    const calls = ops.calls.slice(before);
    expect(calls).toContain("start-task HomePanel Agent");
    // (b) online on the new server (the step polls GET /api/admin/agents there until it says online)
    expect(world.requests).toContain(`GET ${HA}/api/admin/agents`);
    expect(text).toMatch(/✔ Restart the agent/);
    // (c) layouts + config.yaml
    expect(world.remoteProfiles!.get("desk-monitor")).toBe("name: Kevin's desk\nwidgets: []\n");
    expect(world.remoteProfiles!.get("kitchen-ipad")).toBe("name: Kitchen\nwidgets: []\n");
    expect(world.remoteConfig).toContain("binary_sensor.front_visitor");
    // (d) local server retired: task gone, Mosquitto stopped + Manual, firewall rules gone; nothing uninstalled with --yes
    expect(ops.tasks.has("HomePanel Server")).toBe(false);
    expect(ops.tasks.has("HomePanel Agent")).toBe(true);
    expect(ops.services.get("mosquitto")).toMatchObject({ running: false, manual: true });
    expect([...ops.rules.keys()]).toEqual([]);
    expect(calls.filter((c) => c.startsWith("uninstall"))).toEqual([]);
    // browser paired with the new server and opened there
    expect(ops.opened.at(-1)).toMatch(new RegExp(`^${HA}/\\?token=tok-`));
    // (e) summary: new URL + re-pair note
    expect(text).toContain(`Dashboard now: ${HA}`);
    expect(text).toContain("must pair again");
    // this PC is now a "join" PC of the new server; secrets are the new ones
    expect(ctx.store.state.local).toMatchObject({ mode: "join", serverUrl: HA, mqttHost: "192.168.1.60", movedFrom: "http://127.0.0.1:8080", configCopied: true });
    expect(ctx.store.secrets).toMatchObject({ adminPassword: "ha-admin", mqttPassword: "ha-mqtt" });

    // second run: everything detected as done, no system changes
    const n = ops.calls.length;
    const again = moveCtx(world, ops, []);
    expect(await moveFlow(again.ctx, { haStore: ha })).toBe(0);
    expect(ops.calls.slice(n).filter((c) => /^(register-task|unregister-task|start-task|disable-service|remove-firewall|uninstall)/.test(c))).toEqual([]);
  });

  it("interactive: asks which server, uses the saved HA passwords, offers to uninstall Mosquitto", async () => {
    const { world, ops, ha } = await hostedPc();
    const { ctx, out } = moveCtx(world, ops, [HA, "all", true], false);
    expect(await moveFlow(ctx, { haStore: ha })).toBe(0);
    expect(ops.calls).toContain("uninstall EclipseFoundation.Mosquitto");
    expect(out.text()).toContain("Mosquitto uninstalled");
  });

  it("without mode 3 on this PC: asks for the admin + MQTT passwords; refuses this PC as the 'new' server", async () => {
    const { world, ops } = await hostedPc();
    const empty = new StateStore(join(root, "nothing"));
    const { ctx, out } = moveCtx(world, ops, ["__type", "127.0.0.1", true, "192.168.1.60", "wrong", true, "ha-admin", "homepanel", "ha-mqtt", "ask", true, true, true, true, false, true], false);
    expect(await moveFlow(ctx, { haStore: empty })).toBe(0);
    expect(out.text()).toContain("That is this PC");
    expect(out.text()).toContain("admin password rejected");
    expect(ctx.store.secrets.mqttPassword).toBe("ha-mqtt");
    expect(ops.tasks.has("HomePanel Server")).toBe(false);
  });

  it("a layout the new server rejects → fix shown, skip keeps going", async () => {
    const { world, ops, ha } = await hostedPc();
    writeFileSync(join(fakeCtx({ root, prompt: scriptedPrompter([]) }).ctx.paths.serverDir, "profiles", "broken.yaml"), "invalid: true\n");
    const { ctx, out } = moveCtx(world, ops, ["skip"]);
    expect(await moveFlow(ctx, { haStore: ha })).toBe(1);
    expect(out.text()).toContain("broken:");
    expect(world.remoteProfiles!.has("kitchen-ipad")).toBe(true);
    expect(ops.tasks.has("HomePanel Server")).toBe(false);
  });

  it("a PC that never hosted HomePanel: nothing to move", async () => {
    const { ctx, out, ops } = fakeCtx({ root, prompt: scriptedPrompter([]), yes: true });
    expect(await moveFlow(ctx, { haStore: new StateStore(join(root, "x")) })).toBe(0);
    expect(out.text()).toContain("nothing to move");
    expect(ops.calls).toEqual([]);
  });

  it("after the HA wizard: offers the move on a hosting PC (relaunching elevated on Windows)", async () => {
    const ops = new FakeOps(root, new World(), fakePaths(root));
    const ha = new StateStore(join(root, "ha"));
    ha.update({ serverUrl: HA });
    const health = (async (u: RequestInfo | URL) =>
      String(u) === `${HA}/api/health` ? new Response(JSON.stringify({ ok: true, version: "0.2.1" })) : Promise.reject(new TypeError("x"))) as typeof fetch;
    const out = memoryOut();
    // not hosting → no question
    expect(await offerMove({ out, prompt: scriptedPrompter([]), ops, yes: false, rest: [], haStore: ha, fetchImpl: health })).toBe(0);
    // hosting + not elevated → asks, then relaunches `setup --mode move --server <url>` elevated
    ops.tasks.set("HomePanel Server", { name: "HomePanel Server", description: "", file: "cmd.exe", args: [], trigger: "startup", state: "Running" });
    ops.elevated = false;
    const prompt = scriptedPrompter([true]);
    expect(await offerMove({ out, prompt, ops, yes: false, rest: [], haStore: ha, fetchImpl: health })).toBe(0);
    expect(prompt.asked[0]).toMatch(/Move the server to Home Assistant now/);
    expect(ops.relaunched).toHaveLength(1);
    expect(ops.relaunched[0]!.args).toEqual(expect.arrayContaining(["setup", "--mode", "move", "--server", HA, "--elevated"]));
    // HA app not answering → no offer
    const down = (async () => Promise.reject(new TypeError("down"))) as typeof fetch;
    expect(await offerMove({ out, prompt: scriptedPrompter([]), ops, yes: false, rest: [], haStore: ha, fetchImpl: down })).toBe(0);
  });

  it("start menu → 4 on a PC that does not host → explains, back to the menu", async () => {
    const ops = new FakeOps(root, new World(), fakePaths(root));
    const out = memoryOut();
    expect(await main(["setup"], { out, ops, prompt: scriptedPrompter(["move", "quit"]), pause: async () => undefined })).toBe(0);
    expect(out.text()).toContain("nothing to move");
  });
});
