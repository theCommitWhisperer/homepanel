/**
 * `HomePanel ui --fake[=<scenario>]`: the window against a simulated Windows PC + Home Assistant, so
 * the UI can be demoed and tested on Linux. Nothing on the real machine is touched: the fake PC
 * lives in a temp folder (FakeOps), Home Assistant is an in-process fake on 127.0.0.1.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lhmFixture from "../../../agent/src/fixtures/lhm-ryzen-nvidia.json" with { type: "json" };
import { DryRunSpawner } from "../../../agent/src/exec.js";
import { makeContext } from "../../../installer/src/context.js";
import { startFakeHa, type FakeHa } from "../../../installer/src/fake/ha.js";
import { fakeCtx, FakeOps, fakeFetch, fakePaths, World } from "../../../installer/src/fake/win.js";
import { hostFlow } from "../../../installer/src/local/modes.js";
import type { LocalCtx } from "../../../installer/src/local/flow.js";
import { StateStore } from "../../../installer/src/state.js";
import { scriptedPrompter, memoryOut } from "../../../installer/src/ui.js";
import { fakePrecheckEnv, SCENARIOS, type PrecheckEnv, type SetupDeps } from "../../../installer/src/ui-api.js";
import { Control } from "./control.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Every async method of `o` answers after a short random pause (so the demo shows progress). */
export function slow<T extends object>(o: T, min: number, max: number): T {
  return new Proxy(o, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        const res = (v as (...x: unknown[]) => unknown).apply(t, a);
        return res instanceof Promise ? res.then(async (x) => (await delay(min + Math.random() * (max - min)), x)) : res;
      };
    },
  });
}

export interface FakeUiWorld {
  scenario: string;
  root: string;
  control: Control;
  precheckEnv(): PrecheckEnv;
  setupDeps(): SetupDeps;
  installed(): Promise<boolean>;
  uiDir: string;
  close(): Promise<void>;
}

const HA_TOKEN = "eyJhbGciOiJIUzI1NiJ9.fake-kevin.token";

export async function startFakeWorld(scenarioName = "kevin", o: { version: string; quick?: boolean } = { version: "0.0.0" }): Promise<FakeUiWorld> {
  const scenario = SCENARIOS[scenarioName] ? scenarioName : "kevin";
  const root = mkdtempSync(join(tmpdir(), "homepanel-fake-"));
  const world = new World();
  world.remote = { url: "http://192.168.1.81:8080", adminPassword: "ha-admin" };
  const paths = fakePaths(root, "win32");
  const rawOps = new FakeOps(root, world, paths, "win32");
  const ops = o.quick ? rawOps : slow(rawOps, 120, 450);

  const ha: FakeHa = await startFakeHa({ onboarded: true, haOs: true, tokens: [HA_TOKEN], delayMs: o.quick ? 0 : 40 });
  const haDir = join(root, "ha");
  process.env.HOMEPANEL_HOME = haDir; // anything that opens the default HA wizard store uses the fake one
  const haStore = () => new StateStore(haDir);
  {
    const s = haStore();
    s.update({ haUrl: ha.url, host: "127.0.0.1", haOs: true, hostType: "proxmox", proxmox: { host: "192.168.1.251" } });
    for (const id of ["detect", "host", "onboard", "token"]) s.mark(id, "done");
    s.setSecret("haToken", HA_TOKEN);
  }

  const base = fakeFetch(world, paths);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === ha.url) return globalThis.fetch(input, init);
    if (url.hostname === "api.github.com")
      return new Response(JSON.stringify({ tag_name: "v0.3.1", html_url: "https://github.com/theCommitWhisperer/homepanel/releases/tag/v0.3.1" }), { headers: { "content-type": "application/json" } });
    if (url.port === "8085") {
      if (!world.lhmUp) throw new TypeError("fetch failed: ECONNREFUSED");
      return new Response(JSON.stringify(lhmFixture), { headers: { "content-type": "application/json" } });
    }
    return base(input, init);
  }) as typeof fetch;

  const localCtx = (io: { out: LocalCtx["out"]; prompt: LocalCtx["prompt"] }): LocalCtx => {
    const { ctx } = fakeCtx({ root, prompt: io.prompt, world, ops: ops as FakeOps });
    return {
      ...ctx,
      out: io.out,
      fetchImpl,
      sleep: (ms) => delay(Math.min(ms, o.quick ? 1 : 400)),
      timeouts: o.quick ? ctx.timeouts : { lhm: 8000, server: 8000, agent: 8000, pollMs: 400 },
    };
  };

  // Kevin-like scenarios start with "Host on this PC" already done
  if (["kevin", "ha-down", "ready-to-move", "host-broken"].includes(scenario)) {
    const { ctx } = fakeCtx({ root, prompt: scriptedPrompter([]), world, ops: rawOps, yes: true });
    await hostFlow({ ...ctx, out: memoryOut(), fetchImpl });
    mkdirSync(paths.logsDir, { recursive: true });
    const now = Date.now();
    const stamp = (i: number) => new Date(now - (40 - i) * 60_000).toISOString();
    writeFileSync(join(paths.logsDir, "server.log"), Array.from({ length: 40 }, (_, i) => `${stamp(i)} INFO  [fake] server heartbeat ${i}: 1 agent, 2 screens`).join("\r\n") + "\r\n");
    writeFileSync(join(paths.logsDir, "agent.log"), Array.from({ length: 40 }, (_, i) => `${stamp(i)} INFO  [fake] published 142 sensors`).join("\r\n") + "\r\n");
  }

  const control = new Control({
    version: o.version,
    ops,
    paths,
    localStore: () => new StateStore(paths.setupDir),
    haStore,
    fetchImpl,
    open: async () => undefined,
    spawner: new DryRunSpawner(),
    sleep: (ms) => delay(Math.min(ms, 300)),
  });

  return {
    scenario,
    root,
    control,
    uiDir: join(root, "ui"),
    precheckEnv: () => fakePrecheckEnv({ ...SCENARIOS[scenario]!, delayMs: o.quick ? 0 : 150 }),
    setupDeps: () => ({
      ops,
      localCtx,
      haStore,
      haCtx: ({ store, out, prompt }) =>
        makeContext({
          store,
          out,
          prompt,
          fetchImpl,
          noWait: true,
          // never run real programs or SSH from the demo
          exec: async (cmd) => ({ code: 127, stdout: "", stderr: `${cmd}: not available in the demo` }),
          proxmox: { probe: async () => false, connect: async () => Promise.reject(new Error("no SSH in the demo")), lanIp: () => "192.168.1.50", sleep: (ms) => delay(Math.min(ms, 50)) },
        }),
    }),
    installed: async () => !!new StateStore(paths.setupDir).state.local?.mode,
    async close() {
      await ha.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
