/**
 * `HomePanel.exe` (double-click), `HomePanel.exe ui [...]` and `HomePanel.exe tray`:
 *
 *   double-click → a running window/tray takes over (POST /api/ui/show) → else relaunch hidden
 *                  (and elevated via UAC when needed) as `ui --hidden`, so no console stays open
 *   ui           → UI server on 127.0.0.1:<random> + app window; exits 30 s after the window is gone
 *   tray         → UI server + tray icon (Windows), runs until "Quit tray"
 *
 *   ui flags: --no-open (print the URL), --fake[=<scenario>] (simulated PC + Home Assistant),
 *             --view setup|control, --port <n>
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultPaths, type LocalPaths } from "../../../installer/src/local/flow.js";
import { hostsServerHere } from "../../../installer/src/local/move.js";
import { defaultOps, spawnRun, type WinOps } from "../../../installer/src/local/ops.js";
import { powershellArgs, psStr, winCmdLine } from "../../../installer/src/local/ps.js";
import { StateStore } from "../../../installer/src/state.js";
import { realPrecheckEnv, type SetupMode } from "../../../installer/src/ui-api.js";
import { isSea } from "../runtime.js";
import { VERSION } from "../version.js";
import { Control } from "./control.js";
import { startFakeWorld } from "./fake.js";
import { clearUiInfo, handoff, pidAlive, readUiInfo, sha256, uiDir, writeUiInfo } from "./handoff.js";
import { findStaticDir, UiServer, type UiServerOptions } from "./server.js";
import { newlyStopped, TrayIcon, type TrayMenuId } from "./tray.js";
import { openWindow } from "./window.js";
import { randomBytes } from "node:crypto";

export interface LaunchResult {
  code: number;
  keepAlive: boolean;
}

interface UiFlags {
  noOpen: boolean;
  fake?: string;
  view?: string;
  port?: number;
  hidden: boolean;
  elevated: boolean;
}

export function parseUiFlags(args: string[]): UiFlags {
  const val = (name: string) => {
    const i = args.indexOf(name);
    if (i >= 0) return args[i + 1];
    const eq = args.find((a) => a.startsWith(name + "="));
    return eq ? eq.slice(name.length + 1) : undefined;
  };
  const fakeArg = args.find((a) => a === "--fake" || a.startsWith("--fake="));
  const port = Number(val("--port"));
  const view = val("--view");
  return {
    noOpen: args.includes("--no-open"),
    ...(fakeArg ? { fake: fakeArg.includes("=") ? fakeArg.slice(7) : "kevin" } : {}),
    ...(view === "setup" || view === "control" ? { view } : {}),
    ...(Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}),
    hidden: args.includes("--hidden"),
    elevated: args.includes("--elevated"),
  };
}

/** How to start this program again (SEA: the exe; from a checkout: node + the bundle). */
export function selfLaunch(args: string[]): { file: string; args: string[] } {
  if (isSea()) return { file: process.execPath, args };
  return { file: process.execPath, args: [process.argv[1]!, ...args] };
}

/** Windows: start ourselves again without a visible console; elevated through UAC when asked. */
export async function relaunchHidden(args: string[], elevate: boolean): Promise<number> {
  const self = selfLaunch(args);
  if (!elevate) {
    const c = spawn(self.file, self.args, { detached: true, stdio: "ignore", windowsHide: true });
    c.on("error", () => undefined);
    c.unref();
    return 0;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Start-Process -FilePath ${psStr(self.file)} -ArgumentList ${psStr(winCmdLine(self.args))} -Verb RunAs -WindowStyle Hidden`,
  ].join("\n");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return (await spawnRun(powershell, powershellArgs(script), { timeoutMs: 10 * 60_000 })).code;
}

function logger(file: string | undefined, echo: boolean) {
  return (line: string) => {
    const l = `${new Date().toISOString()} ${line}`;
    if (echo) process.stdout.write(l + "\n");
    if (!file) return;
    try {
      appendFileSync(file, l + "\r\n");
    } catch {
      /* logs are best effort */
    }
  };
}

interface World {
  ops?: WinOps;
  paths?: LocalPaths;
  control: Control;
  options: Pick<UiServerOptions, "precheckEnv" | "setupDeps" | "installed" | "modeAvailability" | "fake">;
  uiDir: string;
  logFile?: (name: string) => string | undefined;
  close(): Promise<void>;
}

async function realWorld(): Promise<World> {
  const ops = defaultOps();
  const paths = defaultPaths(ops.platform);
  const localStore = () => new StateStore(paths.setupDir);
  const control = new Control({
    version: VERSION,
    ops,
    paths,
    localStore,
    haStore: () => new StateStore(),
    fetchImpl: globalThis.fetch,
    open: (t) => ops.openUrl(t),
  });
  const installed = async () => !!localStore().state.local?.mode || (ops.platform === "win32" && !!paths.exe && existsSync(paths.exe));
  return {
    ops,
    paths,
    control,
    uiDir: uiDir(),
    logFile: (name) => {
      if (ops.platform !== "win32") return undefined;
      try {
        mkdirSync(paths.logsDir, { recursive: true });
        return join(paths.logsDir, name);
      } catch {
        return undefined;
      }
    },
    options: {
      precheckEnv: () => realPrecheckEnv({ ops, paths }),
      setupDeps: () => ({ ops }),
      installed,
      modeAvailability: async () => {
        const store = localStore();
        const hosting = await hostsServerHere({ store, ops }).catch(() => false);
        const moving = !!store.state.local?.movedFrom && store.state.local?.mode === "join";
        const local = ops.platform === "win32" || ops.platform === "linux";
        const why = "Needs Windows (or Linux with sudo).";
        const out: Partial<Record<SetupMode, { available: boolean; why?: string }>> = {
          host: local ? { available: true } : { available: false, why },
          join: local ? { available: true } : { available: false, why },
          ha: { available: true },
          move: hosting || moving ? { available: true } : { available: false, why: "This PC doesn't host a HomePanel server, so there is nothing to move." },
        };
        return out;
      },
    },
    close: async () => undefined,
  };
}

async function fakeWorld(name: string): Promise<World> {
  const w = await startFakeWorld(name, { version: VERSION });
  return {
    control: w.control,
    uiDir: w.uiDir,
    options: { precheckEnv: w.precheckEnv, setupDeps: w.setupDeps, installed: w.installed, fake: w.scenario },
    close: w.close,
  };
}

function staticDir(): string | undefined {
  return findStaticDir(globalThis.__HOMEPANEL_ROOT__ ?? process.cwd());
}

function windowUrl(server: UiServer, view?: string) {
  return `${server.url}${view ? `?view=${encodeURIComponent(view)}` : ""}#k=${server.secret}`;
}

/** Start the server and publish ui.json; shared by `ui` and `tray`. */
async function serve(world: World, kind: "window" | "tray", f: UiFlags, log: (l: string) => void, hooks: { onShow(view?: string): void; onIdle?: () => void }) {
  const token = randomBytes(24).toString("base64url");
  const server = new UiServer({
    version: VERSION,
    staticDir: staticDir(),
    handoffToken: token,
    control: world.control,
    ...world.options,
    ...(f.port ? { port: f.port } : {}),
    onShow: hooks.onShow,
    ...(hooks.onIdle ? { onIdle: hooks.onIdle, idleMs: 30_000, firstConnectMs: f.noOpen ? 24 * 3600_000 : 120_000 } : {}),
    log,
  });
  await server.start();
  try {
    writeUiInfo(world.uiDir, { port: server.listeningPort, pid: process.pid, secretHash: sha256(token), kind, version: VERSION }, token);
    if (world.ops?.platform === "win32") {
      const user = await world.ops.interactiveUser().catch(() => undefined);
      await world.ops.restrictAcl(join(world.uiDir, "ui.secret"), { dir: false, ...(user ? { user } : {}) });
    }
  } catch (e) {
    log(`could not write ${join(world.uiDir, "ui.json")}: ${(e as Error).message} (single-instance handoff disabled)`);
  }
  log(`${kind} server on ${server.url} (static: ${staticDir() ?? "placeholder page"})${world.options.fake ? ` [fake: ${world.options.fake}]` : ""}`);
  return server;
}

/** `HomePanel.exe ui [...]` */
export async function uiMain(args: string[]): Promise<LaunchResult> {
  const f = parseUiFlags(args);
  const win = process.platform === "win32";
  if (!f.fake) {
    // another window or the tray is already there → it opens the window, we're done
    if (await handoff(uiDir(), { ...(f.view ? { view: f.view } : {}) })) return { code: 0, keepAlive: false };
    if (win && !f.elevated) {
      const ops = defaultOps();
      if (!(await ops.isElevated())) {
        const code = await relaunchHidden(["ui", "--hidden", "--elevated", ...args.filter((a) => a !== "--hidden")], true);
        if (code !== 0) {
          process.stderr.write("HomePanel needs administrator rights to set up and control its background tasks.\nWindows asked for permission; run HomePanel again and click Yes.\n");
          return { code: 1, keepAlive: false };
        }
        return { code: 0, keepAlive: false };
      }
    }
  }
  const world = f.fake ? await fakeWorld(f.fake) : await realWorld();
  const log = logger(world.logFile?.("ui.log"), !f.hidden);
  let server: UiServer;
  const shutdown = async () => {
    log("window closed; exiting");
    clearUiInfo(world.uiDir);
    await server.close().catch(() => undefined);
    await world.close().catch(() => undefined);
    process.exit(0);
  };
  const show = async (view?: string) => {
    if (f.noOpen) return log(`open ${windowUrl(server, view)}`);
    const pick = await openWindow(windowUrl(server, view));
    log(`opened the window with ${pick.kind} (${pick.file})`);
  };
  server = await serve(world, "window", f, log, { onShow: (v) => (server.liveConnections ? undefined : void show(v)), onIdle: () => void shutdown() });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void shutdown());
  if (f.noOpen) {
    process.stdout.write(`HomePanel window: ${server.openUrl}${f.view ? `  (view=${f.view})` : ""}\nAPI secret (x-hp-ui header / hpui cookie): ${server.secret}\n`);
  } else await show(f.view);
  return { code: 0, keepAlive: true };
}

/** `HomePanel.exe tray` */
export async function trayMain(args: string[]): Promise<LaunchResult> {
  const f = parseUiFlags(args);
  const dir = f.fake ? undefined : uiDir();
  if (dir) {
    const cur = readUiInfo(dir);
    if (cur?.info.kind === "tray" && cur.info.pid !== process.pid && pidAlive(cur.info.pid)) {
      process.stdout.write("The HomePanel tray is already running.\n");
      return { code: 0, keepAlive: false };
    }
  }
  const world = f.fake ? await fakeWorld(f.fake) : await realWorld();
  const log = logger(world.logFile?.("tray.log"), !f.hidden);
  let server: UiServer;
  let tray: TrayIcon | undefined;
  const open = async (view?: string) => {
    if (server.liveConnections && !view) return server.notify({ type: "show" });
    if (server.liveConnections && view) return server.notify({ type: "show", view });
    const pick = await openWindow(windowUrl(server, view));
    log(`opened the window with ${pick.kind}`);
  };
  server = await serve(world, "tray", f, log, { onShow: (v) => void open(v) });
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    log("tray: quit");
    tray?.stop();
    clearUiInfo(world.uiDir);
    await server.close().catch(() => undefined);
    await world.close().catch(() => undefined);
    setTimeout(() => process.exit(0), 300);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void quit());

  if (process.platform === "win32" && !f.noOpen) {
    let restarts = 0;
    const startIcon = () => {
      tray = new TrayIcon(process.execPath);
      tray.on("menu", (id: TrayMenuId) => void onMenu(id));
      tray.on("stderr", (t: string) => log(`tray icon: ${t.trim().slice(0, 300)}`));
      tray.on("exit", (code: number) => {
        if (quitting) return;
        log(`tray icon process ended (code ${code})`);
        if (++restarts <= 5) setTimeout(startIcon, 2000 * restarts);
        else void quit();
      });
      tray.start();
    };
    const onMenu = async (id: TrayMenuId) => {
      log(`tray menu: ${id}`);
      switch (id) {
        case "open":
          return open();
        case "setup":
          return open("setup");
        case "dashboard": {
          const r = await world.control.open("dashboard");
          if (!r.ok) tray?.balloon("HomePanel", r.error ?? "No dashboard yet: run setup first.", "Warning");
          return;
        }
        case "restart-agent": {
          const r = await world.control.act("agent", "restart");
          tray?.balloon("HomePanel", r.ok ? "The agent is restarting." : `Could not restart the agent: ${r.error}`, r.ok ? "Info" : "Warning");
          return;
        }
        case "quit":
          return quit();
      }
    };
    startIcon();
  } else {
    process.stdout.write(`HomePanel tray (no icon on this system): ${server.openUrl}\n`);
  }

  // balloons when something that was running stops
  const states = new Map<string, string>();
  const poll = async () => {
    try {
      const st = await world.control.status();
      const down = newlyStopped(states, st.items);
      for (const it of down) tray?.balloon("HomePanel", `${it.label} stopped. Open HomePanel to restart it.`, "Warning");
      const bad = st.items.filter((i) => i.state === "stopped" || i.state === "error").map((i) => i.label);
      tray?.send({ type: "tooltip", text: bad.length ? `HomePanel — ${bad.join(", ")} not running` : "HomePanel — all running" });
    } catch (e) {
      log(`status poll failed: ${(e as Error).message}`);
    }
  };
  setTimeout(() => void poll(), 5000).unref();
  setInterval(() => void poll(), 30_000).unref();
  return { code: 0, keepAlive: true };
}

/**
 * Double-click on HomePanel.exe (no arguments). Windows: hand over to a running instance, else
 * relaunch hidden (elevated when needed) so the console window goes away. Elsewhere: run `ui`.
 */
export async function doubleClickMain(): Promise<LaunchResult> {
  if (process.platform !== "win32") return uiMain([]);
  if (await handoff(uiDir())) return { code: 0, keepAlive: false };
  const elevated = await defaultOps()
    .isElevated()
    .catch(() => false);
  process.stdout.write("Opening HomePanel…\n");
  // the new process is elevated either way: inherited, or through the UAC prompt
  const code = await relaunchHidden(["ui", "--hidden", "--elevated"], !elevated);
  if (code !== 0) {
    process.stderr.write(
      "HomePanel needs administrator rights (it installs and controls background tasks).\nWindows asked for permission; run HomePanel again and click Yes.\n" +
        "(Terminal setup without the window: HomePanel.exe setup --console)\n",
    );
    return { code: 1, keepAlive: false };
  }
  return { code: 0, keepAlive: false };
}
