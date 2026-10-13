/**
 * `homepanel` / `HomePanel.exe setup` entry point. No side effects on import (PACKAGING.md):
 * cli.ts and the desktop bundle call main(argv) with argv like ["setup", "--yes"].
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aiGuide, chooseProvider } from "./ai-guide.js";
import { makeContext } from "./context.js";
import { doctor } from "./doctor.js";
import { SCREEN_GUIDES } from "./guides.js";
import { defaultPaths } from "./local/flow.js";
import { hostFlow, joinFlow, makeLocalCtx, moveFlow } from "./local/modes.js";
import { defaultOps, type WinOps } from "./local/ops.js";
import { isSea, selfSetupCommand } from "./runtime.js";
import { homepanelHome, StateStore } from "./state.js";
import { pairUrl } from "./steps/extras.js";
import { ALL_STEPS } from "./steps/index.js";
import { adminLogin, agentYaml, registerAgent } from "./steps/pcs.js";
import { color, consoleOut, inquirerPrompter, type Out, type Prompter } from "./ui.js";
import { plainWizard } from "./wizard.js";

export const VERSION = "0.2.0";

const HELP = `${color.bold("homepanel")} ${VERSION} — set up HomePanel and Home Assistant

Usage:
  homepanel setup [--mode host|join|ha|move] [--yes] [--server <url>]
  homepanel setup --mode ha [--ai | --plain] [--step <id>] [--redo] [--reset]
  homepanel agent-key <pcId> [--name <name>] [--mac <aa:bb:..>]
  homepanel screens [ipad|fire-hd8|android|pi|windows]
  homepanel doctor
  homepanel steps
  homepanel --help | --version

setup     Start menu (double-clicking HomePanel.exe does the same):
            host  Host HomePanel on this PC: LibreHardwareMonitor, Mosquitto, firewall, server,
                  this PC's agent, browser pairing (Windows; Linux: Mosquitto/server/agent via systemd)
            join  Join this PC to a HomePanel server elsewhere (LibreHardwareMonitor + agent)
            ha    Home Assistant / mini PC (bare metal, Proxmox VM, …), the guided HA wizard
            move  Move the server to Home Assistant (coming next)
          --yes        accept every "do this?" question (exact actions are still printed)
          --server     server address for join, e.g. 192.168.1.20
          --reset      forget saved progress (secrets are kept)
          HA wizard only: --step <id>, --redo, --ai, --plain
agent-key Register a PC with the HomePanel server (admin API) and write its agent.yaml.
screens   Print setup steps for a screen (iPad, Fire HD 8, Android, Pi, Windows).
doctor    Check Home Assistant, the token, MQTT, the HomePanel server and PC agents.
steps     List the Home Assistant wizard steps.

Environment: HOMEPANEL_HOME (HA wizard state, default ~/.homepanel);
             HOMEPANEL_ADMIN_PASSWORD / HOMEPANEL_MQTT_PASSWORD (join without prompts)
`;

const COMMANDS = new Set(["setup", "doctor", "steps", "screens", "agent-key", "help", "--help", "-h", "--version", "-v", "version"]);

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export type Mode = "host" | "join" | "ha" | "move" | "doctor" | "quit";

export interface MainDeps {
  out?: Out;
  prompt?: Prompter;
  ops?: WinOps;
  /** wait for Enter before the console window closes */
  pause?: () => Promise<void>;
}

async function pressEnter(): Promise<void> {
  if (!process.stdin.isTTY) return;
  process.stdout.write("\nPress Enter to close this window.");
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function startMenu(prompt: Prompter, out: Out): Promise<Mode> {
  out.line(color.bold(color.cyan(`\n  HomePanel ${VERSION} setup`)));
  out.line("  Dashboards for tablets and screens: PC temperatures, buttons, lights, doorbell camera.\n");
  return prompt.select<Mode>({
    message: "What do you want to do?",
    choices: [
      {
        value: "host",
        name: "1. Host HomePanel on this PC",
        description: "Server + MQTT broker + this PC's temperatures and buttons, all here. Fastest real setup; Home Assistant can come later.",
      },
      {
        value: "join",
        name: "2. Join this PC to my HomePanel",
        description: "Another computer already runs HomePanel: add this PC's temperatures, drives and buttons.",
      },
      {
        value: "ha",
        name: "3. Set up Home Assistant / mini PC",
        description: "Home Assistant OS on the mini PC (bare metal or a Proxmox VM), onboarding, MQTT, Zigbee ZBT-1, doorbells.",
      },
      { value: "move", name: "4. Move the server to Home Assistant (coming next)", description: "Not built yet — explains the plan." },
      { value: "doctor", name: "Check everything (doctor)", description: "Reachability of HA, MQTT, the server and PC agents." },
      { value: "quit", name: "Quit" },
    ],
  });
}

async function haWizard(rest: string[], out: Out, prompt: Prompter): Promise<number> {
  const store = new StateStore();
  if (rest.includes("--reset")) {
    store.reset();
    out.ok("Progress cleared.");
  }
  const ctx = makeContext({ store, out, prompt });
  out.line(color.bold(color.cyan("\nHomePanel setup — Home Assistant")));
  out.info(`Progress file: ${store.statePath}`);
  const only = argValue(rest, "--step");
  const redo = rest.includes("--redo");
  if (only) return plainWizard(ctx, { only, redo });
  if (!rest.includes("--plain")) {
    if (rest.includes("--ai")) out.info("AI guide mode. You can switch to the plain wizard any time by typing 'wizard'.");
    const provider = await chooseProvider(ctx);
    if (provider) {
      const r = await aiGuide(ctx, { provider });
      if (r === "exit") {
        out.info("Bye! Run setup again to continue, or `homepanel doctor` to check things.");
        return 0;
      }
    }
  }
  return plainWizard(ctx, { redo });
}

async function setup(rest: string[], deps: MainDeps, bare: boolean): Promise<number> {
  const out = deps.out ?? consoleOut();
  const ops = deps.ops ?? defaultOps();
  const win = ops.platform === "win32";
  const legacyHa = ["--plain", "--ai", "--step", "--redo"].some((f) => rest.includes(f));
  let mode = (argValue(rest, "--mode") as Mode | undefined) ?? (legacyHa ? "ha" : undefined);
  if (mode && !["host", "join", "ha", "move", "doctor"].includes(mode)) {
    out.err(`Unknown mode "${mode}". Use host, join, ha or move.`);
    return 2;
  }
  const needsAdmin = mode === undefined || mode === "host" || mode === "join";
  // Windows: relaunch elevated (UAC) for the start menu and the local modes; the new window does the work.
  if (win && needsAdmin && !rest.includes("--elevated") && !(await ops.isElevated())) {
    out.info("HomePanel setup needs administrator rights (it installs programs and scheduled tasks).");
    out.info("Windows will ask for permission — click Yes. Setup continues in the new window.");
    const cmd = selfSetupCommand([...rest, "--elevated", "--pause"]);
    const code = await ops.relaunchElevated(cmd.file, cmd.args);
    if (code !== 0) out.warn(`The administrator window ended with code ${code}. (If you clicked No, run HomePanel again and click Yes.)`);
    return code;
  }
  const pause = win && !rest.includes("--no-pause") && (bare || rest.includes("--pause"));
  try {
    const prompt = deps.prompt ?? (await inquirerPrompter());
    for (;;) {
      mode ??= await startMenu(prompt, out);
      const yes = rest.includes("--yes") || rest.includes("-y");
      let code: number;
      switch (mode) {
        case "quit":
          return 0;
        case "doctor":
          code = await doctor(doctorStore(ops), out);
          break;
        case "ha":
          return await haWizard(rest, out, prompt);
        case "move":
          code = moveFlow(out);
          break;
        case "host":
        case "join": {
          if (!win && ops.platform === "linux" && !(await ops.isElevated())) {
            out.err("On Linux this mode installs packages and systemd services: run it with sudo.");
            return 1;
          }
          const ctx = makeLocalCtx({ out, prompt, yes, ops });
          if (rest.includes("--reset")) {
            ctx.store.reset();
            out.ok("Progress cleared (passwords kept).");
          }
          code = mode === "host" ? await hostFlow(ctx) : await joinFlow(ctx, { server: argValue(rest, "--server") });
          break;
        }
      }
      // came from the menu → offer it again; from --mode → done
      if (argValue(rest, "--mode") || legacyHa) return code;
      mode = undefined;
      const again = await prompt.select<"menu" | "quit">({
        message: code === 0 ? "Anything else?" : "Something did not finish (see above). What now?",
        choices: [
          { value: "menu", name: "Back to the start menu" },
          { value: "quit", name: "Close" },
        ],
      });
      if (again === "quit") return code;
    }
  } finally {
    if (pause) await (deps.pause ?? pressEnter)();
  }
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const out = deps.out ?? consoleOut();
  // bare `HomePanel.exe` / `homepanel` (or only flags) = setup
  const bare = argv.length === 0 || (argv.length === 1 && argv[0] === "setup" && isSea());
  const args = argv.length === 0 || !COMMANDS.has(argv[0]!) ? ["setup", ...argv] : argv;
  const [cmd, ...rest] = args;
  try {
    if (cmd === "--help" || cmd === "-h" || cmd === "help") {
      out.line(HELP);
      return 0;
    }
    if (cmd === "--version" || cmd === "-v" || cmd === "version") {
      out.line(VERSION);
      return 0;
    }
    if (cmd === "steps") {
      for (const s of ALL_STEPS) out.line(`  ${color.bold(s.id.padEnd(10))} ${s.title} — ${s.summary}`);
      return 0;
    }
    if (cmd === "screens") {
      const store = new StateStore();
      const u = pairUrl({ store });
      const which = rest[0];
      const keys = which ? [which] : Object.keys(SCREEN_GUIDES);
      for (const k of keys) {
        const g = SCREEN_GUIDES[k];
        if (!g) {
          out.err(`Unknown screen "${k}". Choose: ${Object.keys(SCREEN_GUIDES).join(", ")}`);
          return 2;
        }
        out.heading(g.title);
        out.steps(g.steps(u));
      }
      out.line();
      out.info(`Pairing URL: ${u}   Approve codes at: ${u}/admin`);
      return 0;
    }
    if (cmd === "agent-key") return await agentKey(rest, out, deps);
    if (cmd === "doctor") return await doctor(doctorStore(deps.ops ?? defaultOps()), out);
    if (cmd === "setup") {
      if (rest.includes("--help") || rest.includes("-h")) {
        out.line(HELP);
        return 0;
      }
      return await setup(rest, deps, bare);
    }
    out.err(`Unknown command "${cmd}".`);
    out.line(HELP);
    return 2;
  } catch (e) {
    const err = e as Error;
    if (err?.name === "ExitPromptError") {
      out.line("\nStopped. Progress is saved — run setup again to continue.");
      return 130;
    }
    out.err(`homepanel: ${err?.stack ?? err}`);
    return 1;
  }
}

/** HA wizard progress, plus the server address/password from "Host/Join this PC" when the wizard has none (read-only use). */
function doctorStore(ops: WinOps): StateStore {
  const store = new StateStore();
  if (!store.state.serverUrl) {
    try {
      const local = new StateStore(defaultPaths(ops.platform).setupDir);
      const u = local.state.local?.serverUrl;
      if (u) {
        store.state.serverUrl = u;
        store.secrets.adminPassword ??= local.secrets.adminPassword;
      }
    } catch {
      /* no local setup */
    }
  }
  return store;
}

async function agentKey(rest: string[], out: Out, deps: MainDeps): Promise<number> {
  const pcId = rest[0];
  if (!pcId || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(pcId)) {
    out.err("Usage: homepanel agent-key <pcId>   (lowercase letters, digits, dashes, e.g. gaming-pc)");
    return 2;
  }
  const store = new StateStore();
  const prompt = deps.prompt ?? (await inquirerPrompter());
  const serverUrl = store.state.serverUrl ?? (await prompt.input({ message: "HomePanel server URL:", default: "http://homeassistant.local:8080" }));
  const password = store.secrets.adminPassword ?? (await prompt.password({ message: "HomePanel admin password (hidden):" }));
  const name = argValue(rest, "--name") ?? pcId;
  const mac = argValue(rest, "--mac");
  const base = serverUrl.replace(/\/+$/, "");
  const session = await adminLogin(fetch, base, password);
  const r = await registerAgent(fetch, base, session, { pcId, name, ...(mac ? { mac } : {}) });
  const m = store.state.mqtt;
  const host = m && m.host !== "127.0.0.1" ? m.host : new URL(serverUrl).hostname;
  const yaml = agentYaml({
    pcId,
    name,
    mqttUrl: `mqtt://${host}:${m?.port ?? 1883}`,
    mqttUser: m?.username ?? "homepanel",
    mqttPass: store.secrets.mqttPassword,
    key: r.key,
  });
  mkdirSync(homepanelHome(), { recursive: true });
  const file = join(homepanelHome(), `agent-${pcId}.yaml`);
  writeFileSync(file, yaml, { mode: 0o600 });
  store.update({ agents: [...(store.state.agents ?? []).filter((a) => a.pcId !== pcId), { pcId, name }] });
  out.ok(`Registered ${pcId}. Key: ${r.key}`);
  out.ok(`Wrote ${file} — easier: run HomePanel.exe on that PC and choose "Join this PC".`);
  return 0;
}
