#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { Agent } from "./agent.js";
import { ActionDispatcher } from "./actions/dispatcher.js";
import { planAction } from "./actions/plan.js";
import { ConfigError, loadConfig, resolveConfigPath, type AgentConfig } from "./config.js";
import { decodePowershell, NodeSpawner } from "./exec.js";
import { createSensorSource, filterSensors, haSensorIds } from "./sensors/index.js";
import type { InternalSensor } from "./sensors/types.js";
import { AGENT_VERSION, configureLogger, log } from "./util.js";

function load(opts: { config?: string }): { cfg: AgentConfig; path: string } {
  const path = resolveConfigPath(opts.config);
  try {
    return { cfg: loadConfig(path), path };
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
}

const program = new Command()
  .name("homepanel-agent")
  .description("HomePanel PC agent — publishes sensors, drives and buttons for this PC over MQTT")
  .version(AGENT_VERSION, "-v, --version");

program
  .command("run", { isDefault: true })
  .description("connect to MQTT and run until stopped")
  .option("-c, --config <file>", "path to agent.yaml")
  .option("--mock", "fake sensors/drives; actions are logged, not run (for testing without hardware)")
  .option("--supervise", "restart the agent automatically if it crashes (used by the installers)")
  .action(async (opts: { config?: string; mock?: boolean; supervise?: boolean }) => {
    if (opts.supervise) return supervise();
    const { cfg, path } = load(opts);
    configureLogger({ level: cfg.log.level, file: cfg.log.file });
    log.info(`config: ${path}`);
    const agent = new Agent({ config: cfg, configPath: path, mock: !!opts.mock });
    const shutdown = async (sig: string) => {
      log.info(`${sig} received, going offline`);
      await agent.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGBREAK", () => void shutdown("SIGBREAK")); // Windows Ctrl+Break / task stop
    process.on("unhandledRejection", (e) => log.error("unhandled rejection", e as Error));
    process.on("uncaughtException", (e) => {
      log.error(`fatal: ${e.stack ?? e.message}`);
      process.exit(1);
    });
    void agent.start();
  });

/** Parent process: re-run ourselves without --supervise, restart on crash with backoff. */
function supervise() {
  const args = process.argv.slice(1).filter((a) => a !== "--supervise");
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
      if (Date.now() - startedAt > 60_000) delay = 2000; // it ran fine for a while: reset backoff
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

program
  .command("list-sensors")
  .description("print every sensor this PC reports, so you can choose ids for agent.yaml")
  .option("-c, --config <file>", "path to agent.yaml")
  .option("--mock", "use the mock sensor source")
  .option("--all", "include sensors hidden by `sensors: auto` (voltages, per-thread loads...)")
  .option("--json", "print JSON instead of a table")
  .action(async (opts: { config?: string; mock?: boolean; all?: boolean; json?: boolean }) => {
    let cfg: Pick<AgentConfig, "sensorSource" | "lhmUrl" | "lhmAuth" | "sensors" | "ha_sensors">;
    try {
      cfg = loadConfig(resolveConfigPath(opts.config));
    } catch {
      // works without a config too: list-sensors is the first thing people run
      cfg = { sensorSource: "auto", lhmUrl: "http://localhost:8085/data.json", sensors: "auto", ha_sensors: "default" };
    }
    const source = createSensorSource(cfg, { mock: opts.mock });
    let all: InternalSensor[];
    try {
      all = await source.read();
      if (source.name === "Linux hwmon") {
        await new Promise((r) => setTimeout(r, 500)); // second read for CPU load deltas
        all = await source.read();
      }
    } catch (e) {
      console.error(`Could not read sensors from ${source.name}: ${(e as Error).message}`);
      if (source.hint) console.error(source.hint);
      process.exit(1);
    }
    const published = new Set(filterSensors(all, cfg.sensors).map((s) => s.id));
    const ha = new Set(haSensorIds(filterSensors(all, cfg.sensors), cfg.ha_sensors).map((s) => s.id));
    const rows = opts.all ? all : all.filter((s) => published.has(s.id));
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    const table = rows.map((s) => ({
      id: s.id,
      name: s.name,
      value: `${s.value}`,
      unit: s.unit,
      flags: `${published.has(s.id) ? "P" : " "}${ha.has(s.id) ? "H" : " "}`,
    }));
    const w = (k: keyof (typeof table)[number]) => Math.max(k.length, ...table.map((r) => r[k].length));
    const cols = ["flags", "id", "name", "value", "unit"] as const;
    const widths = Object.fromEntries(cols.map((c) => [c, w(c)])) as Record<(typeof cols)[number], number>;
    const line = (r: Record<string, string>) =>
      cols.map((c) => (c === "value" ? r[c]!.padStart(widths[c]) : r[c]!.padEnd(widths[c]))).join("  ");
    console.log(`Source: ${source.name}   (P = published, H = Home Assistant entity)\n`);
    console.log(line({ flags: "PH", id: "id", name: "name", value: "value", unit: "unit" }));
    console.log(cols.map((c) => "-".repeat(widths[c])).join("  "));
    for (const r of table) console.log(line(r));
    console.log(`\n${rows.length} sensor(s).${opts.all ? "" : " Use --all to include hidden ones."}`);
  });

program
  .command("test-action <id>")
  .description("run one action from agent.yaml right here (no MQTT), after asking y/N")
  .option("-c, --config <file>", "path to agent.yaml")
  .option("-y, --yes", "don't ask")
  .option("--dry-run", "only print the command that would run")
  .action(async (id: string, opts: { config?: string; yes?: boolean; dryRun?: boolean }) => {
    const { cfg, path } = load(opts);
    const def = cfg.actions[id];
    if (!def) {
      console.error(`No action "${id}" in ${path}. Known: ${Object.keys(cfg.actions).join(", ") || "(none)"}`);
      process.exit(1);
    }
    const ctx = { platform: process.platform, env: process.env, configDir: dirname(path) };
    try {
      const plan = planAction(def, ctx);
      console.log(`Action "${id}" (${def.type}): ${plan.describe}`);
      for (const s of plan.steps) {
        const ps = decodePowershell(s);
        console.log(`  $ ${s.cmd} ${ps ? "-EncodedCommand <inline script below>" : s.args.map((a) => JSON.stringify(a)).join(" ")}`);
        if (ps) console.log(ps.split("\n").map((l) => "      " + l).join("\n"));
      }
    } catch (e) {
      console.error(`Cannot run: ${(e as Error).message}`);
      process.exit(1);
    }
    if (opts.dryRun) return;
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question("Run it now? [y/N] ")).trim().toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") {
        console.log("Cancelled.");
        return;
      }
    }
    const d = new ActionDispatcher(cfg.actions, new NodeSpawner(), ctx, {});
    const r = await d.run(id);
    if (r.ok) console.log(`OK${r.output ? `: ${r.output}` : ""}`);
    else {
      console.error(`FAILED: ${r.error}`);
      process.exit(1);
    }
  });

program
  .command("print-config-path")
  .description("show which agent.yaml would be used")
  .option("-c, --config <file>", "path to agent.yaml")
  .action((opts: { config?: string }) => {
    console.log(resolveConfigPath(opts.config));
  });

program
  .command("check-config")
  .description("validate agent.yaml and print a summary")
  .option("-c, --config <file>", "path to agent.yaml")
  .action((opts: { config?: string }) => {
    const { cfg, path } = load(opts);
    console.log(`${path}: OK — pc "${cfg.pcId}" (${cfg.name}), broker ${cfg.mqtt.url}, ${Object.keys(cfg.actions).length} action(s)`);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
