import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newerVersion, tailFile } from "../src/ui/control.js";
import { startFakeWorld, type FakeUiWorld } from "../src/ui/fake.js";
import { clearUiInfo, handoff, readUiInfo, sha256, writeUiInfo } from "../src/ui/handoff.js";
import { parseUiFlags } from "../src/ui/launch.js";
import { PLACEHOLDER_HTML, UiServer } from "../src/ui/server.js";
import { newlyStopped, parseTrayLine, trayScript, TRAY_MENU } from "../src/ui/tray.js";
import { pickBrowser } from "../src/ui/window.js";

let world: FakeUiWorld | undefined;
let server: UiServer | undefined;
afterEach(async () => {
  await server?.close();
  await world?.close();
  server = undefined;
  world = undefined;
});

async function setup(o: { scenario?: string; staticDir?: string; handoffToken?: string; onShow?: (v?: string) => void; onIdle?: () => void; idleMs?: number } = {}) {
  world = await startFakeWorld(o.scenario ?? "fresh", { version: "9.9.9", quick: true });
  server = new UiServer({
    version: "9.9.9",
    control: world.control,
    precheckEnv: world.precheckEnv,
    setupDeps: () => ({ ...world!.setupDeps(), noOfferMove: true }),
    installed: world.installed,
    fake: world.scenario,
    ...o,
  });
  await server.start();
  const base = server.url.replace(/\/$/, "");
  const H = { "x-hp-ui": server.secret, "content-type": "application/json" };
  const api = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, { ...init, headers: { ...H, ...(init.headers as Record<string, string>) } });
    return { status: r.status, body: (await r.json()) as any };
  };
  const post = (path: string, body: unknown = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
  return { base, H, api, post, server: server!, world: world! };
}

/** Read an SSE stream until `until` says stop; returns the parsed data events. */
async function sse(url: string, headers: Record<string, string>, until: (e: any, all: any[]) => boolean | Promise<boolean>, timeoutMs = 8000): Promise<any[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const r = await fetch(url, { headers: { ...headers, accept: "text/event-stream" }, signal: ctrl.signal });
  const out: any[] = [];
  const dec = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!block.startsWith("data:")) continue;
        const e = JSON.parse(block.slice(5));
        out.push(e);
        if (await until(e, out)) {
          ctrl.abort();
          return out;
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  } finally {
    clearTimeout(t);
  }
  return out;
}

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("UI server: access rules", () => {
  it("needs the secret (header or cookie), the exact Host, and no foreign Origin", async () => {
    const { base, server: s, H } = await setup();
    expect((await fetch(base + "/api/control/status")).status).toBe(401);
    expect((await fetch(base + "/api/control/status", { headers: { cookie: `hpui=${s.secret}` } })).status).toBe(200);
    expect((await fetch(base + "/api/control/status", { headers: { "x-hp-ui": "wrong" } })).status).toBe(401);
    expect(await rawGet(s.listeningPort, "/api/control/status", { host: `localhost:${s.listeningPort}`, "x-hp-ui": s.secret })).toBe(421);
    expect(await rawGet(s.listeningPort, "/", { host: `evil.example:${s.listeningPort}` })).toBe(421);
    expect((await fetch(base + "/api/control/status", { headers: { ...H, origin: "http://evil.example" } })).status).toBe(403);
    expect((await fetch(base + "/api/control/status", { headers: { ...H, origin: base } })).status).toBe(200);
    expect(s.openUrl).toBe(`${base}/#k=${s.secret}`);
  });

  it("serves the built UI with an index.html fallback, refuses traversal; placeholder without a build", async () => {
    const dist = mkdtempSync(join(tmpdir(), "hp-ui-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>HomePanel UI</title>");
    writeFileSync(join(dist, "assets", "app-123.js"), "console.log(1)");
    const { base } = await setup({ staticDir: dist });
    const idx = await fetch(base + "/");
    expect(await idx.text()).toContain("HomePanel UI");
    expect(idx.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect((await fetch(base + "/control/logs")).status).toBe(200); // client route
    const js = await fetch(base + "/assets/app-123.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(base + "/assets/nope.js")).status).toBe(404);
    expect((await fetch(base + "/..%2f..%2fetc%2fpasswd")).status).toBe(403);
    await server!.close();
    await world!.close();
    const again = await setup();
    expect(await (await fetch(again.base + "/")).text()).toBe(PLACEHOLDER_HTML);
  });

  it("POST /api/ui/show accepts the handoff token (and only that endpoint does)", async () => {
    const shown: (string | undefined)[] = [];
    const { base, api } = await setup({ handoffToken: "tok-handoff-123456", onShow: (v) => shown.push(v) });
    const r = await fetch(base + "/api/ui/show", { method: "POST", headers: { "x-hp-handoff": "tok-handoff-123456", "content-type": "application/json" }, body: JSON.stringify({ view: "setup" }) });
    expect(r.status).toBe(200);
    expect(shown).toEqual(["setup"]);
    expect((await fetch(base + "/api/ui/show", { method: "POST", headers: { "x-hp-handoff": "nope" } })).status).toBe(401);
    expect((await fetch(base + "/api/control/status", { headers: { "x-hp-handoff": "tok-handoff-123456" } })).status).toBe(401);
    expect((await api("/api/ui/info")).body).toMatchObject({ version: "9.9.9", installed: false, view: "setup", fake: "fresh" });
  });

  it("idle: onIdle fires once the last live window stream is gone", async () => {
    let idle = 0;
    const { base, H } = await setup({ onIdle: () => idle++, idleMs: 100 });
    await sse(base + "/api/ui/live", H, (e) => e.type === "hello");
    await new Promise((r) => setTimeout(r, 400));
    expect(idle).toBe(1);
  });
});

describe("UI server: system check and setup runs", () => {
  it("precheck as JSON and as a stream; modes carry the recommendation", async () => {
    const { base, H, api } = await setup({ scenario: "kevin" });
    const j = await api("/api/setup/precheck");
    expect(j.body.recommendation).toMatchObject({ mode: "ha", fromStep: "mqtt" });
    expect(j.body.checks.length).toBeGreaterThan(15);
    const evs = await sse(base + "/api/setup/precheck", H, (e) => e.type === "done");
    expect(evs[0]).toMatchObject({ type: "check", check: { state: "running" } });
    expect(evs.at(-1)).toMatchObject({ type: "done", recommendation: { mode: "ha" } });
    const modes = (await api("/api/setup/modes")).body;
    expect(modes.installed).toBe(true);
    expect(modes.modes.find((m: any) => m.id === "ha")).toMatchObject({ recommended: true, available: true });
  });

  it("start → events (questions) → answer → replay for a late client → one run at a time → cancel", async () => {
    const { base, H, post } = await setup();
    const start = await post("/api/setup/start", { mode: "host" });
    expect(start.status).toBe(200);
    expect((await post("/api/setup/start", { mode: "join" })).status).toBe(409);
    expect((await post("/api/setup/start", { mode: "nope" })).status).toBe(409); // still one running
    // first question: "How do you want to go?" → "Do all of them"
    let q: any;
    await sse(base + "/api/setup/events", H, (e) => (e.type === "question" ? ((q = e), true) : false));
    expect(q.kind).toBe("select");
    const all = q.choices.findIndex((c: any) => c.name.startsWith("Do all"));
    expect((await post("/api/setup/answer", { questionId: q.id, value: "99" })).status).toBe(422);
    expect((await post("/api/setup/answer", { questionId: "q999", value: "0" })).status).toBe(409);
    expect((await post("/api/setup/answer", { questionId: q.id, value: String(all) })).body).toEqual({ ok: true });
    // a late client gets the whole history first (run event first), then the next question
    let q2: any;
    const evs = await sse(base + "/api/setup/events", H, (e) => (e.type === "question" && e.id !== q.id ? ((q2 = e), true) : false));
    expect(evs[0]).toMatchObject({ type: "run", state: "running", mode: "host", ai: false });
    expect(evs.every((e) => typeof e.ts === "number")).toBe(true);
    expect(evs.some((e) => e.type === "answered" && e.id === q.id)).toBe(true);
    expect(evs.some((e) => e.type === "steps")).toBe(true);
    expect(q2.message).toMatch(/admin page/);
    expect((await post("/api/setup/cancel")).body).toEqual({ ok: true });
    const end = await sse(base + "/api/setup/events", H, (e) => e.type === "run" && e.state !== "running");
    expect(end.at(-1)).toMatchObject({ type: "run", state: "cancelled" });
    expect((await post("/api/setup/start", { mode: "host", fromStep: "agent" })).status).toBe(200);
    expect((await post("/api/setup/ai/message", { text: "hi" })).status).toBe(409); // no AI in this run
  });

  it("a full Host run through the API ends with a summary", async () => {
    const { base, H, post } = await setup();
    await post("/api/setup/start", { mode: "host" });
    const evs = await sse(
      base + "/api/setup/events",
      H,
      async (e) => {
        if (e.type === "question") {
          const v = e.kind === "select" ? String(Math.max(0, e.choices.findIndex((c: any) => /^(Do all|Make one up)/.test(c.name)))) : e.kind === "confirm" ? true : "";
          await post("/api/setup/answer", { questionId: e.id, value: v });
        }
        return e.type === "run" && e.state !== "running";
      },
      15_000,
    );
    expect(evs.at(-1)).toMatchObject({ type: "run", state: "done" });
    const summary = evs.find((e) => e.type === "summary");
    expect(summary.items.some((i: any) => i.label === "Admin password" && i.secret)).toBe(true);
  }, 20_000);
});

describe("UI server: control API (fake Windows PC)", () => {
  it("status, restart, logs, agent.yaml validate + save + restart, test-action dry run, open, update check", async () => {
    const { api, post } = await setup({ scenario: "kevin" });
    const st = (await api("/api/control/status")).body;
    expect(st).toMatchObject({ role: "host", pcId: "gaming-pc", agentOnline: true });
    expect(st.items.find((i: any) => i.id === "server")).toMatchObject({ state: "running", canRestart: true });
    expect(st.sensors).toMatchObject({ ok: true, count: 142 });
    expect(st.sensors.top[0].name).toBe("CPU Package");

    expect((await post("/api/control/agent/restart")).body).toEqual({ ok: true });
    expect((await post("/api/control/agent/frobnicate")).status).toBe(404);
    expect((await post("/api/control/ha/start")).body.ok).toBe(false);
    expect((await post("/api/control/mosquitto/stop")).body).toEqual({ ok: true });
    expect((await api("/api/control/status")).body.items.find((i: any) => i.id === "mosquitto").state).toBe("stopped");
    expect((await post("/api/control/mosquitto/start")).body).toEqual({ ok: true });

    const logs = (await api("/api/control/logs/server?lines=5")).body;
    expect(logs.lines).toHaveLength(5);
    expect((await api("/api/control/logs/sensors")).body.lines[0]).toMatch(/no log file/);

    const cfg = (await api("/api/control/agent-config")).body;
    expect(cfg.actions.map((a: any) => a.id)).toEqual(["open-drive-c"]);
    const bad = await api("/api/control/agent-config", { method: "PUT", body: JSON.stringify({ yaml: cfg.yaml.replace("type: open", "type: teleport") }) });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.join(" ")).toMatch(/actions/);
    const good = await api("/api/control/agent-config", {
      method: "PUT",
      body: JSON.stringify({ yaml: cfg.yaml + "  steam:\n    type: url\n    url: steam://open/main\n    label: Steam\n" }),
    });
    expect(good.body).toEqual({ ok: true, restarted: true });
    expect((await api("/api/control/agent-config")).body.actions.map((a: any) => a.id)).toEqual(["open-drive-c", "steam"]);

    const dry = (await post("/api/control/test-action", { id: "steam" })).body;
    expect(dry).toMatchObject({ ok: true, ran: false });
    expect(dry.commands.join(" ")).toContain("steam://open/main");
    expect((await post("/api/control/test-action", { id: "steam", really: true })).body).toMatchObject({ ok: true, ran: true });
    expect((await post("/api/control/test-action", { id: "ghost" })).body.ok).toBe(false);

    expect((await post("/api/control/open", { target: "admin" })).body).toEqual({ ok: true, url: "http://localhost:8080/admin" });
    expect((await post("/api/control/open", { target: "file:///etc" })).status).toBe(400);
    expect((await post("/api/control/update-check")).body).toMatchObject({ current: "9.9.9", latest: "0.3.1", newer: false });
    expect((await post("/api/control/network/private")).body).toEqual({ ok: true });
  });
});

describe("helpers", () => {
  it("ui.json handoff: write, read, refuse a mismatching secret, clear only our own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hp-handoff-"));
    writeUiInfo(dir, { port: 1234, pid: process.pid, secretHash: sha256("tok"), kind: "window" }, "tok");
    expect(readUiInfo(dir)).toEqual({ info: { port: 1234, pid: process.pid, secretHash: sha256("tok"), kind: "window" }, token: "tok" });
    writeUiInfo(dir, { port: 1234, pid: process.pid, secretHash: sha256("other"), kind: "window" }, "tok");
    expect(readUiInfo(dir)?.token).toBeUndefined();
    clearUiInfo(dir, 999999);
    expect(readUiInfo(dir)).toBeDefined();
    clearUiInfo(dir);
    expect(readUiInfo(dir)).toBeUndefined();
  });

  it("handoff() reaches a running server's /api/ui/show", async () => {
    const shown: string[] = [];
    const { server: s } = await setup({ handoffToken: "tok-abc", onShow: (v) => shown.push(v ?? "default") });
    const dir = mkdtempSync(join(tmpdir(), "hp-handoff-"));
    expect(await handoff(dir)).toBe(false); // nothing there
    writeUiInfo(dir, { port: s.listeningPort, pid: process.pid, secretHash: sha256("tok-abc"), kind: "tray" }, "tok-abc");
    expect(await handoff(dir, { view: "setup" })).toBe(true);
    expect(shown).toEqual(["setup"]);
  });

  it("pickBrowser: Edge app window with its own profile, then Chrome, then the default browser", () => {
    const env = { "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\kevin\\AppData\\Local", SystemRoot: "C:\\Windows" };
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const p = pickBrowser("http://127.0.0.1:5000/#k=x", { env, platform: "win32", exists: (f) => f === edge, appPath: () => undefined });
    expect(p).toEqual({
      kind: "edge",
      file: edge,
      args: [
        "--app=http://127.0.0.1:5000/#k=x",
        "--window-size=1100,760",
        "--user-data-dir=C:\\Users\\kevin\\AppData\\Local\\HomePanel\\ui-profile",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
      ],
    });
    const reg = pickBrowser("u", { env, platform: "win32", exists: (f) => f === "D:\\Edge\\msedge.exe", appPath: (e) => (e === "msedge.exe" ? "D:\\Edge\\msedge.exe" : undefined) });
    expect(reg.file).toBe("D:\\Edge\\msedge.exe");
    const chrome = pickBrowser("u", { env, platform: "win32", exists: (f) => f.endsWith("chrome.exe") && f.startsWith("C:\\Program Files\\"), appPath: () => undefined });
    expect(chrome.kind).toBe("chrome");
    expect(chrome.args[0]).toBe("--app=u");
    expect(pickBrowser("u", { env, platform: "win32", exists: () => false, appPath: () => undefined })).toMatchObject({ kind: "default", args: ["url.dll,FileProtocolHandler", "u"] });
    expect(pickBrowser("u", { env: {}, platform: "linux", exists: () => false, appPath: () => undefined })).toEqual({ kind: "default", file: "xdg-open", args: ["u"] });
  });

  it("tray: script has every menu item, messages parse, balloons only for running→stopped", () => {
    const s = trayScript("C:\\Program Files\\HomePanel\\HomePanel.exe");
    for (const m of TRAY_MENU) expect(s).toContain(`'${m.text}'`);
    expect(s).toContain("ExtractAssociatedIcon('C:\\Program Files\\HomePanel\\HomePanel.exe')");
    expect(s).toContain("ReadLineAsync");
    expect(parseTrayLine('{"type":"menu","id":"open"}')).toEqual({ type: "menu", id: "open" });
    expect(parseTrayLine("garbage")).toBeUndefined();
    const prev = new Map<string, string>();
    expect(newlyStopped(prev, [{ id: "agent", label: "PC agent", state: "running" }])).toEqual([]);
    expect(newlyStopped(prev, [{ id: "agent", label: "PC agent", state: "stopped" }])).toEqual([{ id: "agent", label: "PC agent", state: "stopped" }]);
    expect(newlyStopped(prev, [{ id: "agent", label: "PC agent", state: "stopped" }])).toEqual([]);
  });

  it("ui flags, versions, log tails", () => {
    expect(parseUiFlags(["--no-open", "--fake=preparing", "--view", "setup", "--port", "8799"])).toEqual({ noOpen: true, fake: "preparing", view: "setup", port: 8799, hidden: false, elevated: false });
    expect(parseUiFlags(["--fake"]).fake).toBe("kevin");
    expect(newerVersion("0.3.1", "0.3.0")).toBe(true);
    expect(newerVersion("0.3.0", "0.3.0")).toBe(false);
    expect(newerVersion("0.2.9", "0.3.0-beta")).toBe(false);
    const f = join(mkdtempSync(join(tmpdir(), "hp-tail-")), "x.log");
    writeFileSync(f, Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n");
    expect(tailFile(f, 3)).toEqual(["line 997", "line 998", "line 999"]);
    expect(tailFile(f, 2, 20)).toEqual(["line 998", "line 999"]);
  });
});
