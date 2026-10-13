/**
 * A fake Windows PC + HomePanel server for the local flows: FakeOps records every system change,
 * `world` ties them together (starting the server task makes /api/health answer, the agent task
 * makes the PC online, …) and `fetch` serves the HTTP endpoints the flows call.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { ExecResult } from "../src/sys.js";
import type { FirewallRule, RunOpts, ServiceInfo, TaskInfo, TaskSpec, WinOps } from "../src/local/ops.js";
import { defaultPaths, type LocalCtx, type LocalPaths } from "../src/local/flow.js";
import { StateStore } from "../src/state.js";
import { memoryOut, type Prompter } from "../src/ui.js";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

export class World {
  serverUp = false;
  /** server task starts but never answers (to test failures) */
  serverBroken = false;
  lhmUp = false;
  agentOnline = false;
  mqttPass?: string;
  agents = new Map<string, { name: string; key: string; mac?: string }>();
  pairings = new Map<string, { approved: boolean; token?: string; profileId?: string }>();
  devices: { name: string; profileId: string; token: string }[] = [];
  profiles = ["desk-monitor", "kitchen-ipad", "fire-hd8"];
  remote?: { url: string; adminPassword: string };
}

export class FakeOps implements WinOps {
  readonly platform: NodeJS.Platform;
  calls: string[] = [];
  elevated = true;
  relaunched: { file: string; args: string[] }[] = [];
  packages = new Set<string>();
  /** ids whose install fails this many more times */
  failInstall = new Map<string, number>();
  services = new Map<string, { running: boolean; env: string[] }>();
  rules = new Map<string, FirewallRule>();
  category = "Private";
  tasks = new Map<string, TaskSpec & { state: string }>();
  procs = new Set<string>();
  acl: { path: string; user?: string }[] = [];
  opened: string[] = [];
  user = "GAMING-PC\\kevin";
  lhmExe: string;
  mosqDir: string;

  constructor(
    readonly root: string,
    readonly world: World,
    readonly paths: LocalPaths,
    platform: NodeJS.Platform = "win32",
  ) {
    this.platform = platform;
    this.lhmExe = join(root, "WinGet", "Packages", "LibreHardwareMonitor.LibreHardwareMonitor_x", "LibreHardwareMonitor.exe");
    this.mosqDir = join(root, "Program Files", "mosquitto");
  }

  private log(s: string) {
    this.calls.push(s);
  }

  async isElevated() {
    return this.elevated;
  }
  async relaunchElevated(file: string, args: string[]) {
    this.relaunched.push({ file, args });
    return 0;
  }
  async run(file: string, args: string[], o: RunOpts = {}): Promise<ExecResult> {
    this.log(`run ${file} ${args.join(" ")}`);
    if (/mosquitto_passwd/.test(file)) {
      const [, , path, , pass] = args;
      writeFileSync(path!, `homepanel:$7$hash\n`);
      this.world.mqttPass = pass;
      return ok();
    }
    if (/mosquitto(\.exe)?$/.test(file) && args[0] === "install") {
      this.services.set("mosquitto", { running: false, env: [] });
      return ok();
    }
    if (args.includes("init")) {
      const cfg = args[args.indexOf("--config") + 1]!;
      const doc = {
        pcId: args[args.indexOf("--pc-id") + 1],
        name: o.env?.HOMEPANEL_INIT_NAME,
        mqtt: { url: args[args.indexOf("--mqtt-url") + 1], username: args[args.indexOf("--mqtt-user") + 1], password: o.env?.HOMEPANEL_INIT_MQTT_PASS },
        key: o.env?.HOMEPANEL_INIT_KEY,
        actions: { "open-drive-c": { type: "open", path: "C:\\" } },
      };
      mkdirSync(join(cfg, ".."), { recursive: true });
      writeFileSync(cfg, "# suggested buttons below\n" + YAML.stringify(doc));
      return ok(`Wrote ${cfg}`);
    }
    if (args.includes("check-config")) return ok("OK");
    if (file === "chgrp" || file === "chmod") return ok();
    return { code: 127, stdout: "", stderr: "not faked" };
  }
  async packageInstalled(id: string) {
    return this.packages.has(id);
  }
  installPackageCommand(id: string, o: { scope?: "machine" | "user"; silent?: boolean } = {}) {
    return ["winget", "install", "--id", id, "-e", ...(o.scope ? ["--scope", o.scope] : []), ...(o.silent ? ["--silent"] : [])];
  }
  async installPackage(id: string, o: { scope?: "machine" | "user"; silent?: boolean } = {}) {
    this.log(`install ${id}${o.scope ? " scope=" + o.scope : ""}${o.silent ? " silent" : ""}`);
    const n = this.failInstall.get(id) ?? 0;
    if (n > 0) {
      this.failInstall.set(id, n - 1);
      return { code: 1, stdout: "", stderr: "boom" };
    }
    this.packages.add(id);
    if (id.startsWith("LibreHardwareMonitor")) {
      mkdirSync(join(this.lhmExe, ".."), { recursive: true });
      writeFileSync(this.lhmExe, "exe");
    }
    if (id === "EclipseFoundation.Mosquitto") {
      mkdirSync(this.mosqDir, { recursive: true });
      writeFileSync(join(this.mosqDir, "mosquitto.exe"), "exe");
      this.services.set("mosquitto", { running: true, env: [] });
    }
    if (id === "namazso.PawnIO") this.services.set("PawnIO", { running: true, env: [] });
    return ok();
  }
  async findLhmExe() {
    return existsSync(this.lhmExe) ? this.lhmExe : undefined;
  }
  async findMosquittoDir() {
    return existsSync(join(this.mosqDir, "mosquitto.exe")) ? this.mosqDir : undefined;
  }
  async processRunning(name: string) {
    return this.procs.has(name);
  }
  async stopProcess(o: { name?: string; path?: string }) {
    this.log(`stop-process ${o.name ?? o.path}`);
    if (o.name) {
      this.procs.delete(o.name);
      if (o.name === "LibreHardwareMonitor") this.world.lhmUp = false;
    }
  }
  async serviceInfo(name: string): Promise<ServiceInfo> {
    const s = this.services.get(name);
    return s ? { exists: true, running: s.running, env: s.env } : { exists: false, running: false, env: [] };
  }
  async setServiceEnv(name: string, env: Record<string, string>) {
    this.log(`service-env ${name} ${JSON.stringify(env)}`);
    const s = this.services.get(name);
    if (!s) return { code: 1, stdout: "", stderr: "no service" };
    s.env = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    return ok();
  }
  async restartService(name: string) {
    this.log(`restart-service ${name}`);
    const s = this.services.get(name);
    if (!s) return { code: 1, stdout: "", stderr: "no service" };
    s.running = true;
    return ok();
  }
  async firewallRuleExists(name: string) {
    return this.rules.has(name);
  }
  async addFirewallRule(r: FirewallRule) {
    this.log(`firewall ${r.name} ${r.port} ${r.profile}`);
    this.rules.set(r.name, r);
    return ok();
  }
  async networkCategory() {
    return this.category;
  }
  async setNetworkPrivate() {
    this.log("network-private");
    this.category = "Private";
    return ok();
  }
  async taskInfo(name: string): Promise<TaskInfo> {
    const t = this.tasks.get(name);
    return t ? { exists: true, state: t.state, file: t.file, args: t.args.join(" ") } : { exists: false };
  }
  async registerTask(t: TaskSpec) {
    this.log(`register-task ${t.name}`);
    const prev = this.tasks.get(t.name);
    this.tasks.set(t.name, { ...t, state: prev?.state ?? "Ready" });
    return ok();
  }
  async startTask(name: string) {
    this.log(`start-task ${name}`);
    const t = this.tasks.get(name);
    if (!t) return { code: 1, stdout: "", stderr: "no task" };
    t.state = "Running";
    if (name === "HomePanel Sensors") {
      this.world.lhmUp = true;
      this.procs.add("LibreHardwareMonitor");
    }
    if (name === "HomePanel Server") this.world.serverUp = !this.world.serverBroken;
    if (name === "HomePanel Agent") this.world.agentOnline = true;
    return ok();
  }
  async stopTask(name: string) {
    const t = this.tasks.get(name);
    if (t) {
      this.log(`stop-task ${name}`);
      t.state = "Ready";
      if (name === "HomePanel Server") this.world.serverUp = false;
      if (name === "HomePanel Agent") this.world.agentOnline = false;
    }
    return ok();
  }
  async restrictAcl(path: string, o: { dir: boolean; user?: string }) {
    this.acl.push({ path, user: o.user });
    return ok();
  }
  async interactiveUser() {
    return this.user;
  }
  async openUrl(url: string) {
    this.opened.push(url);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** fetch for localhost:8085 (LHM), the local server (127.0.0.1/localhost:8080) and world.remote. */
export function fakeFetch(world: World, paths: LocalPaths): typeof fetch {
  let n = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.port === "8085") {
      if (!world.lhmUp) throw new TypeError("fetch failed: ECONNREFUSED");
      return json({ id: 0, Text: "Sensor", Children: [] });
    }
    const local = (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === "8080";
    const remote = world.remote && url.origin === world.remote.url;
    if (!(local && world.serverUp) && !remote) throw new TypeError("fetch failed: ECONNREFUSED");
    const adminPw = remote
      ? world.remote!.adminPassword
      : /ADMIN_PASSWORD="?([^"\n]*)"?/.exec(existsSync(join(paths.serverDir, ".env")) ? readFileSync(join(paths.serverDir, ".env"), "utf8") : "")?.[1];
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    const p = url.pathname;
    if (p === "/api/health") return json({ ok: true, ha: "disconnected", mqtt: "connected", version: "0.2.0" });
    if (p === "/api/admin/login" && method === "POST") return body?.password && body.password === adminPw ? json({ session: "sess" }) : json({ error: "wrong-password" }, 401);
    if (p === "/api/pair/start" && method === "POST") {
      const id = `p${++n}`;
      world.pairings.set(id, { approved: false });
      return json({ pairingId: id, code: "123456", expiresAt: Date.now() + 600_000 });
    }
    const st = /^\/api\/pair\/status\/(.+)$/.exec(p);
    if (st) {
      const x = world.pairings.get(st[1]!);
      return x?.approved ? json({ status: "approved", deviceToken: x.token, device: { id: "d1", name: "x", profileId: x.profileId } }) : json({ status: "pending" });
    }
    if (auth !== "Bearer sess") return json({ error: "unauthorized" }, 401);
    if (p === "/api/admin/agents" && method === "GET")
      return json(
        [...world.agents].map(([pcId, a]) => ({ pcId, name: a.name, status: world.agentOnline ? "online" : "never-seen", hasMac: !!a.mac })),
      );
    if (p === "/api/admin/agents" && method === "POST") {
      const ex = world.agents.get(body.pcId);
      const a = { name: body.name, key: ex?.key ?? `key-${body.pcId}-0123456789abcdef`, mac: body.mac ?? ex?.mac };
      world.agents.set(body.pcId, a);
      return json({ pcId: body.pcId, key: a.key });
    }
    if (p === "/api/admin/profiles") return json(world.profiles.map((id) => ({ id, name: id, yaml: "" })));
    const ap = /^\/api\/admin\/pairings\/(.+)\/approve$/.exec(p);
    if (ap && method === "POST") {
      const x = world.pairings.get(ap[1]!);
      if (!x) return json({ error: "pairing-not-found" }, 404);
      if (!world.profiles.includes(body.profileId)) return json({ error: "unknown profile" }, 400);
      Object.assign(x, { approved: true, token: `tok-${ap[1]}`, profileId: body.profileId });
      world.devices.push({ name: body.name, profileId: body.profileId, token: x.token! });
      return json({ id: "d1", name: body.name, profileId: body.profileId });
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
}

export function fakePaths(root: string, platform: NodeJS.Platform = "win32"): LocalPaths {
  const base = defaultPaths(platform, { ProgramFiles: join(root, "Program Files"), ProgramData: join(root, "ProgramData"), HOMEPANEL_DATA_ROOT: join(root, "var") });
  if (platform !== "win32") {
    const etc = join(root, "etc", "mosquitto");
    return { ...base, mosquittoDir: join(etc, "conf.d"), mosquittoConf: join(etc, "conf.d", "homepanel.conf"), mosquittoPasswd: join(etc, "homepanel.passwd") };
  }
  return base;
}

export function fakeCtx(o: {
  root: string;
  prompt: Prompter;
  yes?: boolean;
  world?: World;
  platform?: NodeJS.Platform;
  ops?: FakeOps;
  sea?: { running: string };
}): { ctx: LocalCtx; ops: FakeOps; world: World; out: ReturnType<typeof memoryOut> } {
  const world = o.world ?? new World();
  const paths = fakePaths(o.root, o.platform);
  const ops = o.ops ?? new FakeOps(o.root, world, paths, o.platform);
  const out = memoryOut();
  const ctx: LocalCtx = {
    out,
    prompt: o.prompt,
    store: new StateStore(paths.setupDir),
    ops,
    fetchImpl: fakeFetch(world, paths),
    yes: !!o.yes,
    paths,
    sea: !!o.sea,
    runningExe: o.sea?.running ?? null,
    repoRoot: "/repo",
    sleep: async () => undefined,
    async mqttCheck(url, user, pass) {
      const svc = ops.services.get("mosquitto");
      if (!svc?.running) throw new Error("connect ECONNREFUSED");
      if (user !== "homepanel" || pass !== world.mqttPass) throw new Error("Connection refused: Not authorized");
      if (!url.startsWith("mqtt://")) throw new Error("bad url");
    },
    net: () => ({ ip: "192.168.1.50", mac: "AA:BB:CC:DD:EE:FF", hostname: "GAMING-PC" }),
    timeouts: { lhm: 6, server: 6, agent: 6, pollMs: 1 },
  };
  return { ctx, ops, world, out };
}
