import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signingString, topics } from "@homepanel/protocol";
import { AgentManager, buildCommand, signCommand } from "../src/agents.js";
import { StateHub } from "../src/hub.js";
import { isRemoteIp, magicPacket } from "../src/net.js";
import { tmpDir } from "./helpers.js";

describe("command signing", () => {
  it("is hex HMAC-SHA256(key, signingString)", () => {
    const cmd = buildCommand("k3y", "open-drive-c", 1_700_000_000_000, "abc");
    expect(cmd).toMatchObject({ id: "abc", action: "open-drive-c", ts: 1_700_000_000_000 });
    expect(signingString(cmd)).toBe("abc.open-drive-c.1700000000000");
    const expected = createHmac("sha256", "k3y").update("abc.open-drive-c.1700000000000").digest("hex");
    expect(cmd.sig).toBe(expected);
    expect(cmd.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(signCommand("other", cmd)).not.toBe(expected);
  });
});

describe("remote classifier", () => {
  it.each([
    ["127.0.0.1", false],
    ["::1", false],
    ["::ffff:192.168.1.20", false],
    ["192.168.0.10", false],
    ["10.1.2.3", false],
    ["172.20.0.1", false],
    ["169.254.3.3", false],
    ["fe80::1%eth0", false],
    ["fd12:3456::1", false],
    ["100.64.0.1", true], // Tailscale / CGNAT → remote
    ["100.101.102.103", true],
    ["100.127.255.254", true],
    ["fd7a:115c:a1e0::1", true], // Tailscale IPv6
    ["8.8.8.8", true],
    ["172.32.0.1", true],
    ["2001:db8::1", true],
    ["", true],
  ])("%s → remote=%s", (ip, remote) => {
    expect(isRemoteIp(ip)).toBe(remote);
  });
});

describe("agent guards", () => {
  function setup() {
    const hub = new StateHub();
    const published: { topic: string; payload: string }[] = [];
    const mgr = new AgentManager(tmpDir(), hub, async () => {});
    mgr.transport = {
      status: "connected",
      publish: (topic, payload) => {
        published.push({ topic, payload });
        const c = JSON.parse(payload);
        setTimeout(() => mgr.handleMessage(topics.cmdResult("pc1"), JSON.stringify({ id: c.id, ok: true })), 5);
      },
      stop() {},
    };
    mgr.register("pc1", "PC", undefined, "key1");
    mgr.handleMessage(topics.status("pc1"), "online");
    mgr.handleMessage(
      topics.actions("pc1"),
      JSON.stringify({
        pc: "pc1",
        actions: [
          { id: "lock", label: "Lock", type: "system" },
          { id: "sleep", label: "Sleep", type: "system", guard: "confirm" },
          { id: "shutdown", label: "Off", type: "system", guard: "confirm+home-only" },
          { id: "update", label: "Upd", type: "script", guard: "home-only" },
        ],
      }),
    );
    return { mgr, hub, published };
  }

  it("refuses home-only actions from a Tailscale (100.x) client", async () => {
    const { mgr, published } = setup();
    const remote = isRemoteIp("100.100.1.1");
    expect(await mgr.runAction("pc1", "update", { remote, confirmed: true })).toEqual({ ok: false, error: "home-only" });
    expect(await mgr.runAction("pc1", "shutdown", { remote, confirmed: true })).toEqual({ ok: false, error: "home-only" });
    expect(published).toHaveLength(0);
    expect(await mgr.runAction("pc1", "update", { remote: isRemoteIp("192.168.1.9"), confirmed: false })).toEqual({ ok: true });
  });

  it("requires confirmed for confirm guards and signs the published command", async () => {
    const { mgr, published } = setup();
    expect(await mgr.runAction("pc1", "sleep", { remote: false, confirmed: false })).toEqual({ ok: false, error: "confirm-required" });
    expect(await mgr.runAction("pc1", "sleep", { remote: false, confirmed: true })).toEqual({ ok: true });
    expect(await mgr.runAction("pc1", "nope", { remote: false, confirmed: true })).toEqual({ ok: false, error: "unknown-action" });
    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe("homepanel/agent/pc1/cmd");
    const c = JSON.parse(published[0]!.payload);
    expect(c.sig).toBe(signCommand("key1", c));
  });

  it("publishes agent keys and summaries to the hub", () => {
    const { hub } = setup();
    expect(hub.get("agent:pc1:status")?.value).toBe("online");
    const agents = hub.get("agents")?.value as any[];
    expect(agents[0]).toMatchObject({ pcId: "pc1", name: "PC", status: "online", hasMac: false });
    expect((hub.get("agent:pc1:actions")?.value as any).actions).toHaveLength(4);
  });

  it("builds a valid WOL magic packet", () => {
    const p = magicPacket("AA:BB:CC:DD:EE:FF");
    expect(p).toHaveLength(102);
    expect(p.subarray(0, 6).toString("hex")).toBe("ffffffffffff");
    expect(p.subarray(96, 102).toString("hex")).toBe("aabbccddeeff");
  });
});
