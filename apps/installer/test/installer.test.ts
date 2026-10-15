import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assistant } from "@homepanel/ai";
import { guideTools, SYSTEM_PROMPT } from "../src/ai-guide.js";
import { makeContext } from "../src/context.js";
import { runChecks } from "../src/doctor.js";
import { HaClient } from "../src/ha/client.js";
import { SecretVault, StateStore } from "../src/state.js";
import { checkDocker, vboxCommands } from "../src/steps/host.js";
import { stepsFor, STEP_IDS } from "../src/steps/index.js";
import { addMqttIntegration } from "../src/steps/mqtt.js";
import { onboardHomeAssistant } from "../src/steps/onboard.js";
import { agentYaml } from "../src/steps/pcs.js";
import type { Exec } from "../src/sys.js";
import { memoryOut, scriptedPrompter } from "../src/ui.js";
import { plainWizard, runStep } from "../src/wizard.js";
import { startFakeHa, type FakeHa } from "./fake-ha.js";
import { onboardStep, tokenStep } from "../src/steps/onboard.js";
import { mqttStep } from "../src/steps/mqtt.js";
import { doorbellStep, zigbeeStep } from "../src/steps/extras.js";
import { loginWithPassword } from "../src/steps/onboard.js";
import { envStep, healthStep, healthSummary } from "../src/steps/finish.js";
import { detectStep } from "../src/steps/detect.js";
import { staticIpStep, parseCidr, networkOf, validHostIn, staticIpPayload, nmcliCommands } from "../src/steps/static-ip.js";
import { setHaAddress, haCandidates, findReachableHa } from "../src/ha/address.js";
import { waitForHa } from "../src/ha/discover.js";
import { DEFAULT_HA_HOST } from "../src/constants.js";

let ha: FakeHa | undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hp-installer-"));
});
afterEach(async () => {
  await ha?.close();
  ha = undefined;
});

describe("HA onboarding client (fake HA over HTTP + WS)", () => {
  it("users → token → core_config → analytics → integration → location → long-lived token", async () => {
    ha = await startFakeHa();
    const c = new HaClient(ha.url);
    expect((await c.onboardingStatus()).state).toBe("onboarding");

    const access = await onboardHomeAssistant(c, {
      name: "Kevin",
      username: "kevin",
      password: "correct horse battery",
      location: { location_name: "Home", time_zone: "America/Denver", country: "US", unit_system: "us_customary" },
    });
    expect(access).toMatch(/^access/);
    expect(ha.state.users[0]).toMatchObject({ name: "Kevin", username: "kevin" });
    expect([...ha.state.onboardingDone].sort()).toEqual(["analytics", "core_config", "integration", "user"]);
    // client_id is the HA base URL with a trailing slash, as HA's frontend uses
    expect(new Set(ha.state.clientIds)).toEqual(new Set([`${ha.url}/`]));
    expect(ha.state.coreConfig).toMatchObject({ time_zone: "America/Denver", unit_system: "us_customary", country: "US" });
    // core_config etc. were sent with the bearer token
    const cc = ha.state.requests.find((r) => r.path === "/api/onboarding/core_config")!;
    expect(cc.auth).toBe(access);
    const integ = ha.state.requests.find((r) => r.path === "/api/onboarding/integration")!;
    expect(integ.body.redirect_uri).toBe(`${ha.url}/?auth_callback=1`);

    expect((await c.onboardingStatus()).state).toBe("onboarded");
    const llt = await c.withWs((s) => s.createLongLivedToken("HomePanel", 3650));
    expect(ha.state.longLived).toEqual([{ client_name: "HomePanel", lifespan: 3650, token: llt }]);
    expect(await new HaClient(ha.url, { token: llt }).apiOk()).toBe(true);
    expect(await new HaClient(ha.url, { token: "nope" }).apiOk()).toBe(false);
  });

  it("onboarding + token steps through the wizard save secrets outside the state file", async () => {
    ha = await startFakeHa({ haOs: true });
    const store = new StateStore(dir);
    store.update({ haUrl: ha.url, host: "127.0.0.1" });
    const prompt = scriptedPrompter([
      "Kevin", // name
      "", // username → default "kevin"
      "s3cretpass!", // password
      "s3cretpass!", // again
      "Home",
      "America/Denver",
      "US",
      "us_customary",
      "", // lat/long skip
    ]);
    const out = memoryOut();
    const ctx = makeContext({ store, out, prompt, fetchImpl: fetch, repoRoot: dir, noWait: true });
    expect(await runStep(ctx, onboardStep)).toBe("done");
    expect(await runStep(ctx, tokenStep)).toBe("done");
    expect(store.secrets.haToken).toMatch(/^llt-/);
    expect(store.state.haOs).toBe(true);
    expect(store.state.owner).toEqual({ name: "Kevin", username: "kevin" });
    const stateText = readFileSync(store.statePath, "utf8");
    expect(stateText).not.toContain("s3cretpass!");
    expect(stateText).not.toContain(store.secrets.haToken!);
    if (process.platform !== "win32") expect(statSync(store.secretsPath).mode & 0o777).toBe(0o600);

    // mqtt: installs Mosquitto via supervisor, creates the broker user, accepts the discovered flow
    expect(await runStep(ctx, mqttStep)).toBe("done");
    const eps = ha.state.supervisorCalls.map((c) => `${c.method} ${c.endpoint}`);
    expect(eps).toContain("post /store/addons/core_mosquitto/install");
    expect(eps).toContain("post /addons/core_mosquitto/start");
    expect(ha.state.users.find((u) => u.username === "homepanel")).toBeTruthy();
    expect(ha.state.configEntries.map((e) => e.domain)).toContain("mqtt");
    // second run detects done without changing anything
    const before = ha.state.supervisorCalls.length;
    expect(await runStep(ctx, mqttStep)).toBe("done");
    expect(ha.state.supervisorCalls.length).toBe(before);
  });

  it("MQTT integration on HA Container fills the broker form", async () => {
    ha = await startFakeHa({ onboarded: true });
    const c = new HaClient(ha.url);
    // give it a token
    ha.state.accessTokens.add("tok");
    c.token = "tok";
    const msg = await addMqttIntegration(c, { host: "127.0.0.1", port: 1883, username: "homepanel", password: "pw" });
    expect(msg).toMatch(/added/);
    const req = ha.state.requests.find((r) => /flow\/flow/.test(r.path) && r.method === "POST")!;
    expect(req.body).toEqual({ broker: "127.0.0.1", port: 1883, username: "homepanel", password: "pw" });
  });

  it("Reolink doorbell flow gets host/user/password", async () => {
    ha = await startFakeHa({ onboarded: true });
    ha.state.accessTokens.add("tok");
    const store = new StateStore(dir);
    store.update({ haUrl: ha.url });
    store.setSecret("haToken", "tok");
    const prompt = scriptedPrompter(["reolink", "192.168.1.50", "admin", "doorpw"]);
    const ctx = makeContext({ store, out: memoryOut(), prompt, repoRoot: dir });
    expect(await runStep(ctx, doorbellStep, { force: true })).toBe("done");
    expect(ha.state.configEntries[0]).toMatchObject({ domain: "reolink", title: "Doorbell 192.168.1.50" });
  });
});

describe("state + step selection", () => {
  it("resumes: done steps are not run again", async () => {
    const store = new StateStore(dir);
    store.update({ hostType: "ha-green" });
    for (const id of STEP_IDS) store.mark(id, "done");
    const reopened = new StateStore(dir);
    expect(reopened.state.hostType).toBe("ha-green");
    expect(reopened.isDone("mqtt")).toBe(true);
    const prompt = scriptedPrompter([]); // any prompt would throw
    const out = memoryOut();
    const code = await plainWizard(makeContext({ store: reopened, out, prompt, repoRoot: dir }));
    expect(code).toBe(0);
    expect(prompt.asked).toEqual([]);
    expect(out.text()).toContain("done earlier");
  });

  it("asks only for steps not done, and quit saves", async () => {
    const store = new StateStore(dir);
    store.update({ hostType: "x86-bare-metal" });
    store.mark("detect", "done");
    store.mark("host", "done");
    const prompt = scriptedPrompter(["quit"]);
    await plainWizard(makeContext({ store, out: memoryOut(), prompt, repoRoot: dir }));
    expect(prompt.asked[0]).toMatch(/^Create your Home Assistant account/);
  });

  it("step order depends on host type", () => {
    expect(stepsFor("linux-docker").map((s) => s.id)[0]).toBe("host");
    expect(stepsFor("linux-docker").map((s) => s.id)).not.toContain("detect");
    expect(stepsFor("x86-bare-metal").map((s) => s.id).slice(0, 5)).toEqual(["detect", "host", "onboard", "token", "staticip"]);
    expect(stepsFor("linux-docker").map((s) => s.id)).toContain("staticip");
    expect(stepsFor(undefined).length).toBe(STEP_IDS.length);
  });

  it("vault redacts secrets including JSON-escaped forms", () => {
    const v = new SecretVault();
    const ph = v.add("pw", 'a"b\\c-secret');
    expect(v.redact(`x a"b\\c-secret y`)).toBe(`x ${ph} y`);
    expect(v.redact(JSON.stringify({ p: 'a"b\\c-secret' }))).toBe(`{"p":"${ph}"}`);
    expect(v.resolve(`use ${ph}`)).toBe('use a"b\\c-secret');
  });
});

describe("host helpers", () => {
  it("rejects Docker Desktop and old engines", async () => {
    const fake = (server: string, os: string): Exec =>
      async (_c, args) => {
        if (args[0] === "version") return { code: 0, stdout: server, stderr: "" };
        if (args[0] === "info") return { code: 0, stdout: os, stderr: "" };
        return { code: 0, stdout: "Docker Compose version v2.30", stderr: "" };
      };
    expect((await checkDocker(fake("27.3.1|Docker Engine - Community", "Ubuntu 24.04"))).ok).toBe(true);
    const desk = await checkDocker(fake("27.3.1|Docker Desktop 4.35.0 (172550)", "Docker Desktop"));
    expect(desk.ok).toBe(false);
    expect(desk.problem).toMatch(/Docker Desktop/);
    expect((await checkDocker(fake("20.10.24|Docker Engine", "Debian"))).problem).toMatch(/too old/);
    const none: Exec = async () => ({ code: 127, stdout: "", stderr: "" });
    expect((await checkDocker(none)).installed).toBe(false);
  });

  it("generates VirtualBox commands with EFI, 4 GB, 2 CPUs, bridged NIC", () => {
    const cmds = vboxCommands("C:\\vm\\haos.vdi", "Intel(R) Ethernet");
    const modify = cmds.find((c) => c[0] === "modifyvm")!;
    expect(modify).toEqual(expect.arrayContaining(["--firmware", "efi", "--memory", "4096", "--cpus", "2", "--nic1", "bridged"]));
    expect(cmds.find((c) => c[0] === "storageattach")).toContain("C:\\vm\\haos.vdi");
  });

  it("agent.yaml matches the agent schema shape", () => {
    const y = agentYaml({ pcId: "gaming-pc", name: "Gaming PC", mqttUrl: "mqtt://ha:1883", mqttUser: "u", mqttPass: "p", key: "k".repeat(32) });
    expect(y).toContain("pcId: gaming-pc");
    expect(y).toContain("url: mqtt://ha:1883");
  });
});

describe("AI guide never leaks secrets to the model", () => {
  it("secrets from ask_secret, saved secrets and tool output are redacted in every request", async () => {
    const store = new StateStore(dir);
    store.update({ haUrl: "http://127.0.0.1:1", hostType: "ha-green" });
    store.setSecret("haToken", "HA-TOKEN-abcdef123456");
    store.setSecret("adminPassword", "admin-pass-xyz");
    const prompt = scriptedPrompter(["hunter2-reolink"]);
    const vault = new SecretVault();
    const ctx = makeContext({ store, out: memoryOut(), prompt, vault, repoRoot: dir });

    const bodies: string[] = [];
    const script = [
      // model asks for a secret
      { tool_calls: [{ id: "a", type: "function", function: { name: "ask_secret", arguments: '{"label":"Reolink password"}' } }] },
      // model reads state (which would contain the secret if not redacted? state never has it, but extra secrets list does)
      { tool_calls: [{ id: "b", type: "function", function: { name: "read_state", arguments: "{}" } }] },
      { content: "Thanks, stored." },
    ];
    const fakeFetch = vi.fn(async (_u: any, init: any) => {
      bodies.push(init.body);
      const m = script.shift()!;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: (m as any).content ?? null, ...m } }] }));
    }) as unknown as typeof fetch;

    const a = new Assistant({
      provider: { provider: "groq", apiKey: "gsk_x" },
      system: SYSTEM_PROMPT,
      tools: guideTools(ctx),
      fetchImpl: fakeFetch,
      redact: ctx.vault.redact,
    });
    // user also pastes their admin password by mistake
    const r = await a.step([{ role: "user", content: "my admin password is admin-pass-xyz, set up the doorbell" }]);
    expect(r.error).toBeUndefined();
    expect(store.secrets.extra?.["Reolink password"]).toBe("hunter2-reolink");
    const all = bodies.join("\n");
    expect(all).not.toContain("hunter2-reolink");
    expect(all).not.toContain("admin-pass-xyz");
    expect(all).not.toContain("HA-TOKEN-abcdef123456");
    expect(all).toMatch(/stored as \$SECRET_\d+/);
    // the act tool run_step requires approval
    expect(guideTools(ctx).find((t) => t.name === "run_step")!.kind).toBe("act");
  });

  it("run_step summary shows exactly what will happen", () => {
    const store = new StateStore(dir);
    store.update({ hostType: "vm-windows" });
    const ctx = makeContext({ store, out: memoryOut(), prompt: scriptedPrompter([]), repoRoot: dir });
    const t = guideTools(ctx).find((x) => x.name === "run_step")!;
    expect(t.summarize!({ step_id: "host" })).toMatch(/VBoxManage createvm/);
    expect(() => t.summarize!({ step_id: "nope" })).toThrow(/Unknown step/);
  });
});

describe("doctor", () => {
  it("fails gracefully with nothing configured / unreachable HA", async () => {
    const store = new StateStore(dir);
    let checks = await runChecks(store);
    expect(checks[0]).toMatchObject({ ok: false, name: "Home Assistant address" });
    store.update({ haUrl: "http://127.0.0.1:1", serverUrl: "http://127.0.0.1:2" });
    checks = await runChecks(store);
    expect(checks.find((c) => c.name === "Home Assistant reachable")!.ok).toBe(false);
    expect(checks.find((c) => c.name === "HomePanel server")!.ok).toBe(false);
  });
});

describe("already-onboarded HA, env file, ZHA and health", () => {
  it("login flow → access token → long-lived token; health counts entities; zha/devices; .env written", async () => {
    ha = await startFakeHa({ onboarded: true });
    ha.state.users.push({ id: "u0", name: "Kevin", username: "kevin", password: "pw-123456", group_ids: ["system-admin"] });
    const c = new HaClient(ha.url);
    await expect(loginWithPassword(c, "kevin", "wrong")).rejects.toThrow(/Login failed/);
    const access = await loginWithPassword(c, "kevin", "pw-123456");
    expect(ha.state.clientIds.every((id) => id === `${ha!.url}/`)).toBe(true);
    const llt = await new HaClient(ha.url, { token: access }).withWs((s) => s.createLongLivedToken());
    expect(llt).toMatch(/^llt-/);

    const store = new StateStore(dir);
    store.update({ haUrl: ha.url, host: "127.0.0.1", mqtt: { host: "192.168.1.20", port: 1883, username: "homepanel" } });
    store.setSecret("haToken", llt);
    store.setSecret("mqttPassword", "mq-pass-xyz");
    ha.state.configEntries.push({ entry_id: "e1", domain: "mqtt", title: "Mosquitto", state: "loaded" });
    ha.state.configEntries.push({ entry_id: "e2", domain: "zha", title: "ZBT-1", state: "loaded" });
    const out = memoryOut();
    const envDir = join(dir, "server");
    const ctx = makeContext({ store, out, prompt: scriptedPrompter(["file", envDir]), fetchImpl: fetch, repoRoot: dir, noWait: true });

    const h = await healthSummary(ctx);
    expect(h.ha).toMatchObject({ reachable: true, entities: 2, version: "2026.10.0" });
    expect(h.mqtt.integration).toBe("loaded");
    expect(h.zigbee).toEqual({ devices: 1 });
    expect(await runStep(ctx, healthStep)).toBe("done");
    expect(await zigbeeStep.detect(ctx)).toMatchObject({ done: true });

    expect(await runStep(ctx, envStep)).toBe("done");
    const env = readFileSync(join(envDir, ".env"), "utf8");
    expect(env).toContain(`HA_URL=${ha.url}`);
    expect(env).toContain(`HA_TOKEN=${llt}`);
    expect(env).toContain("MQTT_URL=mqtt://192.168.1.20:1883");
    expect(env).toContain("MQTT_USER=homepanel");
    expect(env).toContain("MQTT_PASS=mq-pass-xyz");
    expect(env).toMatch(/ADMIN_PASSWORD=.{16}/);
    if (process.platform !== "win32") expect(statSync(join(envDir, ".env")).mode & 0o777).toBe(0o600);
  });
});

describe("address management, fail-safes and static IP automation", () => {
  it("setHaAddress updates haUrl, host, serverUrl, and MQTT host synchronously", () => {
    const store = new StateStore(dir);
    store.update({
      haUrl: "http://homeassistant.local:8123",
      host: "homeassistant.local",
      serverUrl: "http://homeassistant.local:8080",
      mqtt: { host: "homeassistant.local", port: 1883, username: "homepanel" },
    });

    const changed = setHaAddress(store, "192.168.1.81");
    expect(changed.length).toBe(3);
    expect(store.state.haUrl).toBe("http://192.168.1.81:8123");
    expect(store.state.host).toBe("192.168.1.81");
    expect(store.state.serverUrl).toBe("http://192.168.1.81:8080");
    expect(store.state.mqtt?.host).toBe("192.168.1.81");
  });

  it("haCandidates probes default IP before mDNS fallback", () => {
    expect(DEFAULT_HA_HOST).toBe("192.168.1.81");
    const candidates = haCandidates("http://192.168.1.99:8123");
    expect(candidates).toEqual([
      "http://192.168.1.99:8123",
      "http://192.168.1.81:8123",
      "http://homeassistant.local:8123",
    ]);
  });

  it("IPv4 helpers validate subnet boundaries and static IP payload", () => {
    const cidr = parseCidr("192.168.1.150/24");
    expect(cidr).toEqual({ ip: "192.168.1.150", prefix: 24 });
    expect(networkOf("192.168.1.150", 24)).toBe("192.168.1.0");

    expect(validHostIn("192.168.1.81", cidr!)).toBe(true);
    expect(validHostIn("192.168.2.81", cidr!)).toBe(false);
    expect(validHostIn("192.168.1.0", cidr!)).toBe(false); // network
    expect(validHostIn("192.168.1.255", cidr!)).toBe(false); // broadcast

    const payload = staticIpPayload("192.168.1.81", 24, "192.168.1.1", ["192.168.1.1"]);
    expect(payload).toEqual({
      ipv4: {
        method: "static",
        address: ["192.168.1.81/24"],
        gateway: "192.168.1.1",
        nameservers: ["192.168.1.1"],
      },
    });

    const nmcli = nmcliCommands("Wired connection 1", "192.168.1.81", 24, "192.168.1.1", ["192.168.1.1"]);
    expect(nmcli[0]).toContain("ipv4.method");
    expect(nmcli[0]).toContain("192.168.1.81/24");
    expect(nmcli[1]).toEqual(["nmcli", "con", "up", "Wired connection 1"]);
  });

  it("staticIpStep updates network interface on HA OS via Supervisor API", async () => {
    ha = await startFakeHa({ haOs: true, onboarded: true });
    ha.state.accessTokens.add("tok-supervisor");
    const store = new StateStore(dir);
    store.update({ haUrl: ha.url, host: "127.0.0.1", haOs: true });
    store.setSecret("haToken", "tok-supervisor");

    const prompt = scriptedPrompter([
      "192.168.1.81", // static IP
      "192.168.1.1",  // gateway
      true,           // confirm apply
    ]);
    const out = memoryOut();
    const mockExec: Exec = async (cmd, args) => {
      if (cmd === "ping") return { code: 1, stdout: "unreachable", stderr: "" }; // not in use
      return { code: 0, stdout: "", stderr: "" };
    };
    const ctx = makeContext({ store, out, prompt, exec: mockExec, fetchImpl: fetch, repoRoot: dir, noWait: true });

    const status = await runStep(ctx, staticIpStep);
    expect(status).toBe("done");

    const updateCall = ha.state.supervisorCalls.find((c) => /interface\/eth0\/update/.test(c.endpoint));
    expect(updateCall).toBeTruthy();
    expect(updateCall?.method).toBe("post");
    expect(updateCall?.data).toMatchObject({
      ipv4: {
        method: "static",
        address: ["192.168.1.81/24"],
        gateway: "192.168.1.1",
      },
    });
    expect(store.state.host).toBe("192.168.1.81");
  });

  it("waitForHa probes multiple URLs and triggers onFound callback", async () => {
    ha = await startFakeHa({ onboarded: true });
    let foundUrl: string | undefined;
    const ok = await waitForHa(["http://127.0.0.1:1", ha.url], {
      fetchImpl: fetch,
      timeoutMs: 2000,
      intervalMs: 100,
      onFound: (u) => {
        foundUrl = u;
      },
    });
    expect(ok).toBe(ha.url);
    expect(foundUrl).toBe(ha.url);
  });
});
