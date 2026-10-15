import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SetupEvent } from "../src/bridge/events.js";
import { startSetup } from "../src/bridge/run.js";
import { WebPrompter, webOut } from "../src/bridge/web.js";
import { makeContext } from "../src/context.js";
import { hostSteps, trayTaskStep } from "../src/local/flow.js";
import { StateStore } from "../src/state.js";
import { scriptedPrompter } from "../src/ui.js";
import { startFakeHa, type FakeHa } from "./fake-ha.js";
import { fakeCtx, World } from "./fake-win.js";

type Q = Extract<SetupEvent, { type: "question" }>;

function collector() {
  const events: SetupEvent[] = [];
  let onQ: ((q: Q) => void) | undefined;
  return {
    events,
    sink: { emit: (e: SetupEvent) => (events.push(e), e.type === "question" && onQ?.(e)) },
    onQuestion(f: (q: Q) => void) {
      onQ = f;
    },
  };
}

describe("WebPrompter / WebOut", () => {
  it("select: choices go out by index and map back to the original values", async () => {
    const c = collector();
    const p = new WebPrompter(c.sink);
    const r = p.select<{ k: number }>({ message: "Pick", choices: [{ value: { k: 1 }, name: "One" }, { value: { k: 2 }, name: "Two", description: "second" }], default: undefined });
    const q = c.events.find((e) => e.type === "question") as Q;
    expect(q.kind).toBe("select");
    expect(q.choices).toEqual([
      { value: "0", name: "One" },
      { value: "1", name: "Two", description: "second" },
    ]);
    expect(p.answer(q.id, "7")).toMatchObject({ ok: false, status: 422 });
    expect(p.answer("nope", "1")).toMatchObject({ ok: false, status: 409 });
    expect(p.answer(q.id, "1")).toEqual({ ok: true });
    expect(await r).toEqual({ k: 2 });
    expect(c.events.at(-1)).toEqual({ type: "answered", id: q.id });
  });

  it("select default is sent as its index; confirm accepts booleans and yes/no", async () => {
    const c = collector();
    const p = new WebPrompter(c.sink);
    const r = p.select({ message: "x", choices: [{ value: "a", name: "A" }, { value: "b", name: "B" }], default: "b" });
    const q = c.events.at(-1) as Q;
    expect(q.default).toBe("1");
    p.answer(q.id, 0);
    expect(await r).toBe("a");
    const r2 = p.confirm({ message: "ok?", default: true });
    const q2 = c.events.at(-1) as Q;
    expect(q2.default).toBe(true);
    p.answer(q2.id, "no");
    expect(await r2).toBe(false);
  });

  it("validate() failures send question_error and keep the same question open", async () => {
    const c = collector();
    const p = new WebPrompter(c.sink);
    const r = p.input({ message: "Id", default: "gaming-pc", validate: (v) => (/^[a-z-]+$/.test(v) ? true : "lowercase only") });
    const q = c.events.at(-1) as Q;
    expect(q.default).toBe("gaming-pc");
    expect(p.answer(q.id, "BAD")).toMatchObject({ ok: false, error: "lowercase only" });
    expect(c.events.at(-1)).toEqual({ type: "question_error", id: q.id, error: "lowercase only" });
    expect(p.waiting).toBe(q.id);
    p.answer(q.id, ""); // empty → default
    expect(await r).toBe("gaming-pc");
  });

  it("passwords are never echoed in any event", async () => {
    const c = collector();
    const p = new WebPrompter(c.sink);
    const r = p.password({ message: "Secret (hidden):" });
    const q = c.events.at(-1) as Q;
    p.answer(q.id, "hunter2-very-secret");
    expect(await r).toBe("hunter2-very-secret");
    expect(JSON.stringify(c.events)).not.toContain("hunter2-very-secret");
  });

  it("cancel rejects the pending question (and later ones) with ExitPromptError", async () => {
    const c = collector();
    const p = new WebPrompter(c.sink);
    const r = p.input({ message: "x" });
    p.cancel();
    await expect(r).rejects.toMatchObject({ name: "ExitPromptError" });
    await expect(p.confirm({ message: "y" })).rejects.toMatchObject({ name: "ExitPromptError" });
  });

  it("WebOut: levels, step tagging, colour codes stripped, steps as items", () => {
    const c = collector();
    const cursor = { current: "host.lhm" };
    const o = webOut(c.sink, cursor);
    o.ok("\x1b[32mdone\x1b[39m");
    o.steps(["a", "b"]);
    o.code("winget install x");
    expect(c.events).toEqual([
      { type: "log", level: "ok", text: "done", stepId: "host.lhm" },
      { type: "log", level: "steps", text: "", items: ["a", "b"], stepId: "host.lhm" },
      { type: "log", level: "code", text: "winget install x", stepId: "host.lhm" },
    ]);
  });
});

describe("startSetup (fake Windows PC)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hp-bridge-"));
  });

  function fakeDeps(world = new World()) {
    // one fake PC shared by every context the run asks for
    const base = fakeCtx({ root, prompt: scriptedPrompter([]), world });
    return {
      world,
      ops: base.ops,
      deps: {
        ops: base.ops,
        localCtx: (io: { out: any; prompt: any }) => ({ ...base.ctx, out: io.out, prompt: io.prompt, store: new StateStore(base.ctx.paths.setupDir) }),
        noOfferMove: true,
      },
    };
  }

  it("host: plan, step states, questions answered through the bridge, summary with secrets", async () => {
    const c = collector();
    const { deps } = fakeDeps();
    const h = startSetup({ mode: "host" }, c.sink, deps);
    c.onQuestion((q) =>
      queueMicrotask(() => {
        if (q.message.startsWith("How do you want to go")) h.answer(q.id, q.choices!.findIndex((x) => x.name.startsWith("Do all")).toString());
        else if (q.kind === "select") h.answer(q.id, "0"); // admin password: make one up
        else if (q.kind === "input") h.answer(q.id, ""); // defaults
        else h.answer(q.id, true);
      }),
    );
    const r = await h.done;
    expect(r).toEqual({ code: 0, state: "done" });
    const plan = c.events.find((e) => e.type === "steps") as Extract<SetupEvent, { type: "steps" }>;
    expect(plan.steps.map((s) => s.id)).toEqual(hostSteps("win32").map((s) => `host.${s.id}`));
    const final = new Map<string, string>();
    for (const e of c.events) if (e.type === "step") final.set(e.id, e.state);
    expect([...final.values()].every((s) => s === "done")).toBe(true);
    expect(c.events.some((e) => e.type === "step" && e.id === "host.server" && e.state === "running")).toBe(true);
    expect(c.events.some((e) => e.type === "log" && e.stepId === "host.mosquitto")).toBe(true);
    expect(c.events.some((e) => e.type === "progress")).toBe(false); // fake world answers at once
    // the plan arrives before the first question ("How do you want to go?")
    expect(c.events.findIndex((e) => e.type === "steps")).toBeLessThan(c.events.findIndex((e) => e.type === "question"));
    expect(c.events.every((e) => typeof e.ts === "number")).toBe(true);
    // summary lines after the last step belong to no step
    const sumHead = c.events.findIndex((e) => e.type === "log" && e.level === "heading" && e.text === "Summary");
    expect(sumHead).toBeGreaterThan(0);
    expect(c.events.slice(sumHead).filter((e) => e.type === "log").every((e) => !(e as { stepId?: string }).stepId)).toBe(true);
    const summary = c.events.find((e) => e.type === "summary") as Extract<SetupEvent, { type: "summary" }>;
    expect(summary.items.find((i) => i.label === "Admin password")).toMatchObject({ secret: true });
    expect(summary.items.find((i) => i.label === "Dashboard on this PC")?.href).toMatch(/^http:\/\/localhost:8080\/\?token=/);
  });

  it("fromStep: earlier steps are reported skipped and not run; later steps run", async () => {
    const c = collector();
    const { deps, ops } = fakeDeps();
    const h = startSetup({ mode: "host", fromStep: "agent" }, c.sink, deps);
    c.onQuestion((q) => queueMicrotask(() => h.answer(q.id, q.kind === "select" ? "0" : false))); // ask per step, decline each
    await h.done;
    const skipped = c.events.filter((e) => e.type === "step" && e.state === "skipped").map((e) => (e as { id: string }).id);
    expect(skipped).toContain("host.lhm");
    expect(skipped).toContain("host.server");
    expect(ops.calls.some((x) => x.startsWith("install"))).toBe(false);
  });

  it("cancel stops a run waiting on a question", async () => {
    const c = collector();
    const { deps } = fakeDeps();
    const h = startSetup({ mode: "host" }, c.sink, deps);
    await new Promise<void>((r) => c.onQuestion(() => r()));
    h.cancel();
    expect(await h.done).toEqual({ code: 130, state: "cancelled" });
  });

  it("progress events while a step polls (server slow to answer)", async () => {
    const c = collector();
    const world = new World();
    world.serverBroken = true;
    const { deps } = fakeDeps(world);
    const h = startSetup({ mode: "host", fromStep: "server" }, c.sink, deps);
    c.onQuestion((q) =>
      queueMicrotask(() => {
        if (q.message.startsWith("How do you want")) h.answer(q.id, "1");
        else if (q.message === "What now?") h.answer(q.id, "2"); // stop here
        else h.answer(q.id, q.kind === "select" ? "0" : q.kind === "input" ? "" : true);
      }),
    );
    const r = await h.done;
    expect(r.state).toBe("failed");
    expect(c.events.some((e) => e.type === "progress" && e.stepId === "host.server" && /Waiting/.test(e.label))).toBe(true);
    expect(c.events.some((e) => e.type === "step" && e.id === "host.server" && e.state === "failed")).toBe(true);
  });
});

describe("tray task step", () => {
  it("registers HomePanel Tray (logon, conhost --headless, the installed exe) and starts it", async () => {
    const root = mkdtempSync(join(tmpdir(), "hp-tray-"));
    const { ctx, ops } = fakeCtx({ root, prompt: scriptedPrompter([]), sea: { running: "C:\\Users\\kevin\\Downloads\\HomePanel-Setup.exe" } });
    expect((await trayTaskStep.detect(ctx)).done).toBe(false);
    await trayTaskStep.run(ctx);
    const t = ops.tasks.get("HomePanel Tray")!;
    expect(t.trigger).toBe("logon");
    expect(t.user).toBe("GAMING-PC\\kevin");
    expect(t.file).toMatch(/conhost\.exe$/);
    expect(t.args).toEqual(["--headless", "C:\\Users\\kevin\\Downloads\\HomePanel-Setup.exe", "tray"]);
    expect(t.state).toBe("Running");
    expect((await trayTaskStep.detect(ctx)).done).toBe(true);
  });
});

describe("startSetup (Home Assistant wizard)", () => {
  let ha: FakeHa;
  afterEach(async () => ha?.close());

  it("fromStep 'mqtt' on Kevin's HA: earlier steps skipped/done, the MQTT step is offered", async () => {
    ha = await startFakeHa({ onboarded: true, haOs: true, tokens: ["tok.kevin.x"] });
    const dir = mkdtempSync(join(tmpdir(), "hp-ha-"));
    const store = new StateStore(dir);
    store.update({ haUrl: ha.url, host: "127.0.0.1", haOs: true, hostType: "proxmox" });
    store.mark("detect", "done");
    store.setSecret("haToken", "tok.kevin.x");
    const c = collector();
    const asked: string[] = [];
    let h: ReturnType<typeof startSetup> | undefined;
    // questions can be emitted synchronously from startSetup(): register first
    c.onQuestion((q) =>
      queueMicrotask(() => {
        asked.push(q.message);
        h!.answer(q.id, String(q.choices!.findIndex((x) => /^Quit/.test(x.name))));
      }),
    );
    h = startSetup({ mode: "ha", fromStep: "mqtt" }, c.sink, {
      haStore: () => store,
      haCtx: ({ store: s, out, prompt }) => makeContext({ store: s, out, prompt, noWait: true, repoRoot: "/nonexistent" }),
      noOfferMove: true,
    });
    expect((await h.done).state).toBe("done");
    expect(asked[0]).toMatch(/^Set up MQTT|MQTT/);
    const st = (id: string) => c.events.filter((e) => e.type === "step" && e.id === id).map((e) => (e as { state: string }).state);
    expect(st("detect")).toContain("done");
    expect(st("token")).toContain("skipped");
    expect(st("mqtt")).toContain("checking");
    // the step event comes before its question, and the question carries the step id
    const qi = c.events.findIndex((e) => e.type === "question");
    const si = c.events.findIndex((e) => e.type === "step" && e.id === "mqtt");
    expect(si).toBeLessThan(qi);
    expect((c.events[qi] as Q).stepId).toBe("mqtt");
    const plan = c.events.find((e) => e.type === "steps") as Extract<SetupEvent, { type: "steps" }>;
    expect(plan.steps.map((s) => s.id)).toContain("server");
  });
});
