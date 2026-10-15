/**
 * homepanel-agent — command line (the implementation; cli.ts just calls main()).
 * No side effects on import. HomePanel.exe calls main() for `HomePanel.exe agent <cmd>`.
 *
 *   homepanel-agent run [--config f] [--mock] [--dry-run] [--supervise]
 *   homepanel-agent list-sensors [--all] [--json] [--mock]
 *   homepanel-agent test-action <id> [--really]
 *   homepanel-agent init [--pc-id x --name x --mqtt-url x --mqtt-user x --mqtt-pass x --key x] [--force]
 *   homepanel-agent check-config | config-path | version
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { Agent } from "./agent.js";
import { ActionDispatcher } from "./actions/dispatcher.js";
import { planAction } from "./actions/plan.js";
import { ConfigError, loadConfig, parseConfig, resolveConfigPath, suggestedPcId, type AgentConfig } from "./config.js";
import { defaultConfigYaml } from "./defaults.js";
import { decodePowershell, describeCommand, NodeSpawner } from "./exec.js";
import { createSensorSource, filterSensors, haSensors } from "./sensors/index.js";
import { AGENT_VERSION, configureLogger, log } from "./util.js";

import { parseArgs, sensorTable, str, type Parsed } from "./args.js";

function isSeaBinary(): boolean {
  try {
    const req = createRequire(import.meta.url);
    return (req("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

const HELP = `HomePanel PC agent ${AGENT_VERSION}

Usage: homepanel-agent <command> [options]

Commands:
  run                 connect to MQTT and publish sensors, drives and actions (default)
      --mock          fake hardware (LHM fixture with drift), fake drives, actions dry-run
      --dry-run       log actions instead of running them
      --supervise     restart the agent if it crashes (used by the Windows scheduled task)
  list-sensors        print the sensors this PC reports (id, name, value)
      --all           include hidden ones (voltages, per-thread loads...)   --json   JSON output
      --mock          use the fixture instead of LibreHardwareMonitor
  test-action <id>    show what an action from agent.yaml would run (dry run)
      --really        actually run it
  init                write a default agent.yaml with suggested buttons
      --pc-id --name --mqtt-url --mqtt-user --mqtt-pass --key    pre-fill values
      --force         overwrite an existing file
  check-config        validate agent.yaml
  config-path         print which agent.yaml would be used
  version

Common options:
  -c, --config <file> agent.yaml to use. Default: next to the program, else
                      %ProgramData%\\HomePanel\\agent.yaml (Windows) / ~/.config/homepanel/agent.yaml
`;

/** Thrown by commands to end with an exit code; main() turns it into its return value. */
class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function loadOrExit(flags: Parsed["flags"]): { cfg: AgentConfig; path: string } {
  const path = resolveConfigPath(str(flags.config));
  try {
    return { cfg: loadConfig(path), path };
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      throw new Exit(2);
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* commands                                                             */
/* ------------------------------------------------------------------ */
async function cmdRun(p: Parsed) {
  if (p.flags.supervise) return supervise();
  const { cfg, path } = loadOrExit(p.flags);
  configureLogger({ level: cfg.log.level, file: cfg.log.file });
  log.info(`config: ${path}`);
  const agent = new Agent({
    config: cfg,
    configPath: path,
    mock: !!p.flags.mock,
    ...(p.flags["dry-run"] ? { dryRun: true } : {}),
  });
  const shutdown = async (sig: string) => {
    log.info(`${sig} received, going offline`);
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  process.on("unhandledRejection", (e) => log.error("unhandled rejection", e as Error));
  process.on("uncaughtException", (e) => {
    log.error(`fatal: ${e.stack ?? e.message}`);
    process.exit(1);
  });
  void agent.start();
}

/** Parent process: re-run ourselves without --supervise, restart on crash with backoff. */
function supervise() {
  // from a script: argv = [node, script, ...]; inside HomePanel.exe (SEA) argv[1] is the exe again
  // and the exe is the program, so only the arguments after it are passed on.
  const args = (isSeaBinary() ? process.argv.slice(2) : process.argv.slice(1)).filter((a) => a !== "--supervise");
  let delay = 2000;
  let child: ChildProcess | undefined;
  let stopping = false;
  const start = () => {
    const startedAt = Date.now();
    child = spawn(process.execPath, args, { stdio: "inherit", windowsHide: true });
    child.on("exit", (code, signal) => {
      if (stopping) return process.exit(0);
      if (code === 2) {
        console.error("agent.yaml is invalid; not restarting. Fix it, then restart the agent.");
        return process.exit(2);
      }
      if (Date.now() - startedAt > 60_000) delay = 2000;
      console.error(`agent exited (${signal ?? code}); restarting in ${delay / 1000} s`);
      setTimeout(start, delay);
      delay = Math.min(delay * 2, 60_000);
    });
  };
  const stop = () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill("SIGTERM");
    else process.exit(0);
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGBREAK", stop);
  start();
}

async function cmdListSensors(p: Parsed) {
  let cfg: Pick<AgentConfig, "lhmUrl" | "lhmAuth" | "sensorSource" | "sensors" | "haSensors" | "haDiscovery">;
  try {
    cfg = loadConfig(resolveConfigPath(str(p.flags.config)));
  } catch {
    // works without a config: list-sensors is the first thing people run
    cfg = { lhmUrl: "http://localhost:8085/data.json", sensorSource: "auto", sensors: "auto", haSensors: "default", haDiscovery: true };
  }
  if (str(p.flags["lhm-url"])) cfg = { ...cfg, lhmUrl: str(p.flags["lhm-url"])! };
  const source = createSensorSource(cfg, { mock: !!p.flags.mock });
  await source.read(); // first read primes the CPU-load deltas
  await new Promise((r) => setTimeout(r, 500));
  const all = await source.read();
  if (source.lastPrimaryError) {
    console.error(`! ${source.lastPrimaryError.message}`);
    console.error("  Showing built-in sensors only.\n");
  }
  const published = filterSensors(all, cfg.sensors);
  const pub = new Set(published.map((s) => s.id));
  const ha = new Set(cfg.haDiscovery ? haSensors(published, cfg.haSensors).map((s) => s.id) : []);
  const rows = p.flags.all ? all : all.filter((s) => pub.has(s.id));
  if (p.flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(`Source: ${source.name}   (P = published, H = Home Assistant entity)\n`);
  console.log(sensorTable(rows, pub, ha));
  console.log(`\n${rows.length} sensor(s).${p.flags.all ? "" : " Use --all to include hidden ones."}`);
}

async function cmdTestAction(p: Parsed) {
  const id = p.positional[0];
  if (!id) {
    console.error("usage: homepanel-agent test-action <id> [--really]");
    throw new Exit(1);
  }
  const { cfg, path } = loadOrExit(p.flags);
  const def = Object.prototype.hasOwnProperty.call(cfg.actions, id) ? cfg.actions[id] : undefined;
  if (!def) {
    console.error(`No action "${id}" in ${path}.\nKnown: ${Object.keys(cfg.actions).join(", ") || "(none)"}`);
    throw new Exit(1);
  }
  const ctx = { platform: process.platform, env: process.env, configDir: dirname(path) };
  try {
    const plan = planAction(def, ctx);
    console.log(`Action "${id}" (${def.type}): ${plan.describe}`);
    for (const s of plan.steps) {
      console.log(`  $ ${describeCommand(s)}`);
      const ps = decodePowershell(s);
      if (ps) console.log(ps.split("\n").map((l) => "      " + l).join("\n"));
    }
  } catch (e) {
    console.error(`Cannot run: ${(e as Error).message}`);
    throw new Exit(1);
  }
  if (!p.flags.really) {
    console.log("\nDry run: nothing was started. Add --really to run it.");
    return;
  }
  const d = new ActionDispatcher(cfg.actions, new NodeSpawner(), ctx);
  const r = await d.run(id);
  if (r.ok) console.log(`OK${r.output ? `: ${r.output}` : ""}`);
  else {
    console.error(`FAILED: ${r.error}`);
    throw new Exit(1);
  }
}

function cmdInit(p: Parsed) {
  const path = str(p.flags.config) ?? resolveConfigPath(undefined, { exists: () => false });
  if (existsSync(path) && !p.flags.force) {
    console.error(`${path} already exists. Use --force to overwrite it.`);
    throw new Exit(1);
  }
  const key = str(p.flags.key) ?? (process.env.HOMEPANEL_INIT_KEY || undefined);
  const yaml = defaultConfigYaml({
    pcId: str(p.flags["pc-id"]) ?? suggestedPcId(),
    name: str(p.flags.name) ?? (process.env.HOMEPANEL_INIT_NAME || hostname()),
    mqttUrl: str(p.flags["mqtt-url"]) ?? "mqtt://192.168.1.81:1883",
    mqttUser: str(p.flags["mqtt-user"]) ?? "homepanel",
    // install.ps1 passes secrets via the environment (PowerShell 5.1 argument quoting is lossy)
    mqttPass: str(p.flags["mqtt-pass"]) ?? process.env.HOMEPANEL_INIT_MQTT_PASS ?? "",
    key: key ?? "paste-the-key-from-homepanel-admin",
  });
  try {
    parseConfig(yaml, "generated config");
  } catch (e) {
    console.error((e as Error).message);
    throw new Exit(2);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml, { encoding: "utf8", mode: 0o600 });
  console.log(`Wrote ${path}`);
  if (!key) console.log("Next: paste the key from HomePanel admin → PCs into it, and check the mqtt section.");
}

function cmdCheckConfig(p: Parsed) {
  const { cfg, path } = loadOrExit(p.flags);
  console.log(
    `${path}: OK — pc "${cfg.pcId}" (${cfg.name}), broker ${cfg.mqtt.url}, ${Object.keys(cfg.actions).length} action(s)`,
  );
}

async function dispatch(argv: string[]): Promise<void> {
  const p = parseArgs(argv);
  if (p.flags.help || p.flags.h || p.command === "help") return void console.log(HELP);
  if (p.flags.version || p.flags.v || p.command === "version") return void console.log(AGENT_VERSION);
  switch (p.command) {
    case "run":
      return cmdRun(p);
    case "list-sensors":
      return cmdListSensors(p);
    case "test-action":
      return cmdTestAction(p);
    case "init":
      return cmdInit(p);
    case "check-config":
      return cmdCheckConfig(p);
    case "config-path":
    case "print-config-path":
      return void console.log(resolveConfigPath(str(p.flags.config)));
    default:
      console.error(`Unknown command "${p.command}".\n`);
      console.log(HELP);
      throw new Exit(1);
  }
}

/**
 * Run an agent command. `argv` are the arguments after the program name, e.g. `["run", "--mock"]`.
 * Resolves with the exit code. `run` resolves 0 once the agent is started and keeps the process
 * alive (MQTT connection, timers), so callers must not exit on 0.
 */
export async function main(argv: string[]): Promise<number> {
  try {
    await dispatch(argv);
    return 0;
  } catch (e) {
    if (e instanceof Exit) return e.code;
    console.error(e instanceof Error ? e.message : e);
    return 1;
  }
}
