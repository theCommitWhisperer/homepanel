/**
 * The four setup modes behind the start menu (PACKAGING.md): host, join, Home Assistant (existing
 * wizard), move (coming next). Host and join are built on local/flow.ts.
 */
import { hostname } from "node:os";
import { MQTT_PORT, SERVER_PORT } from "../constants.js";
import { StateStore } from "../state.js";
import type { Out, Prompter } from "../ui.js";
import { color } from "../ui.js";
import { findRepoRoot } from "../context.js";
import { isSea, runningExe } from "../runtime.js";
import { normalizeServerUrl, ServerApi } from "./api.js";
import {
  MQTT_USER,
  defaultPaths,
  chooseAskMode,
  findServers,
  hostSteps,
  joinSteps,
  primaryInterface,
  printSummary,
  realMqttCheck,
  runLocalSteps,
  type LocalCtx,
  type LocalPaths,
} from "./flow.js";
import { defaultOps, type WinOps } from "./ops.js";

export function makeLocalCtx(o: {
  out: Out;
  prompt: Prompter;
  yes: boolean;
  ops?: WinOps;
  paths?: LocalPaths;
  store?: StateStore;
  fetchImpl?: typeof fetch;
}): LocalCtx {
  const ops = o.ops ?? defaultOps();
  const paths = o.paths ?? defaultPaths(ops.platform);
  return {
    out: o.out,
    prompt: o.prompt,
    yes: o.yes,
    ops,
    paths,
    store: o.store ?? new StateStore(paths.setupDir),
    fetchImpl: o.fetchImpl ?? globalThis.fetch,
    sea: isSea(),
    runningExe: runningExe(),
    repoRoot: findRepoRoot(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    mqttCheck: realMqttCheck,
    net: () => ({ ...primaryInterface(), hostname: hostname() }),
    timeouts: { lhm: 60_000, server: 90_000, agent: 60_000, pollMs: 2000 },
  };
}

export async function hostFlow(ctx: LocalCtx): Promise<number> {
  const { out } = ctx;
  out.heading("Host HomePanel on this PC");
  out.line(
    "  This PC becomes your HomePanel server: dashboard on port 8080, an MQTT broker for PC agents,\n" +
      "  and this PC's own temperatures + buttons. Home Assistant can be connected later.",
  );
  out.info(`Progress and passwords: ${ctx.store.statePath}`);
  ctx.store.updateLocal({ mode: "host", serverUrl: `http://127.0.0.1:${SERVER_PORT}`, mqttHost: "127.0.0.1", mqttUser: MQTT_USER });
  await ctx.ops.restrictAcl(ctx.paths.setupDir, { dir: true });
  const steps = hostSteps(ctx.ops.platform);
  if (!(await chooseAskMode(ctx, steps.map((s) => s.title)))) return 0;
  const res = await runLocalSteps(ctx, steps, "host");
  printSummary(ctx, res, "host");
  return res.code;
}

async function pickServer(ctx: LocalCtx, given?: string): Promise<string | undefined> {
  const { out, prompt } = ctx;
  if (given) return normalizeServerUrl(given);
  const saved = ctx.store.state.local?.mode === "join" ? ctx.store.state.local.serverUrl : undefined;
  out.info("Looking for HomePanel on your network (a few seconds)…");
  const found = await findServers(ctx, { extra: saved ? [saved] : [] });
  if (ctx.yes && found.length === 1) return found[0];
  const choices = [
    ...found.map((u) => ({ value: u, name: u })),
    { value: "__type", name: "Type the address of the PC that runs HomePanel" },
    { value: "__quit", name: "Quit" },
  ];
  if (!found.length) out.warn("No HomePanel server answered. Is the host PC on and set up (mode 1 on that PC)?");
  const pick = await prompt.select<string>({ message: "Which HomePanel?", choices, default: found[0] });
  if (pick === "__quit") return undefined;
  if (pick !== "__type") return pick;
  for (;;) {
    const v = await prompt.input({ message: "Address (e.g. 192.168.1.20 or gaming-pc.local):" });
    try {
      const u = normalizeServerUrl(v);
      if ((await new ServerApi(u, ctx.fetchImpl).health())?.ok !== undefined) return u;
      out.warn(`${u}/api/health did not answer.`);
    } catch {
      out.warn("That is not an address.");
    }
    if (!(await prompt.confirm({ message: "Try another address?", default: true }))) return undefined;
  }
}

export async function joinFlow(ctx: LocalCtx, o: { server?: string } = {}): Promise<number> {
  const { out, prompt, store } = ctx;
  out.heading("Join this PC to my HomePanel");
  out.line("  Adds this PC's temperatures, drives and buttons to a HomePanel server that runs on another computer.");
  const url = await pickServer(ctx, o.server);
  if (!url) return 0;
  const s = new ServerApi(url, ctx.fetchImpl);
  const h = await s.health();
  if (!h) {
    out.err(`${url} does not answer. Check the address and that the other PC is on.`);
    return 1;
  }
  out.ok(`Found HomePanel ${h.version ?? ""} at ${url}`);

  // admin password (reuse the saved one if it still works)
  let pw = store.state.local?.serverUrl === url ? store.secrets.adminPassword : undefined;
  pw ??= process.env.HOMEPANEL_ADMIN_PASSWORD || undefined;
  for (;;) {
    if (!pw) pw = await prompt.password({ message: "HomePanel admin password (hidden; shown at the end of setup on the server PC):" });
    try {
      await s.login(pw);
      break;
    } catch (e) {
      out.warn((e as Error).message);
      pw = undefined;
      if (!(await prompt.confirm({ message: "Try again?", default: true }))) return 1;
    }
  }
  store.setSecret("adminPassword", pw);

  // MQTT login for this PC's agent: same broker host as the server
  const mqttHost = new URL(url).hostname;
  let user = store.state.local?.mqttUser ?? MQTT_USER;
  let mpw = store.state.local?.mqttHost === mqttHost ? store.secrets.mqttPassword : undefined;
  mpw ??= process.env.HOMEPANEL_MQTT_PASSWORD || undefined;
  for (;;) {
    if (!mpw) {
      if (!ctx.yes) user = (await prompt.input({ message: "MQTT username:", default: user })).trim() || MQTT_USER;
      mpw = await prompt.password({
        message: "MQTT password (hidden; the server PC's setup summary shows it — or your Home Assistant 'homepanel' user):",
      });
    }
    try {
      await ctx.mqttCheck(`mqtt://${mqttHost}:${MQTT_PORT}`, user, mpw);
      out.ok(`MQTT login works on ${mqttHost}:${MQTT_PORT}.`);
      break;
    } catch (e) {
      out.warn(`MQTT login to ${mqttHost}:${MQTT_PORT} failed: ${(e as Error).message}`);
      out.info("“Not authorized” = wrong user/password. A timeout = port 1883 blocked (the host's firewall step) or no broker.");
      const what = await prompt.select<"again" | "keep" | "quit">({
        message: "What now?",
        choices: [
          { value: "again", name: "Type the password again" },
          { value: "keep", name: "Keep it and continue anyway" },
          { value: "quit", name: "Quit" },
        ],
      });
      if (what === "quit") return 1;
      if (what === "keep") break;
      mpw = undefined;
    }
  }
  store.setSecret("mqttPassword", mpw);
  store.updateLocal({ mode: "join", serverUrl: url, mqttHost, mqttUser: user });
  await ctx.ops.restrictAcl(ctx.paths.setupDir, { dir: true });

  const steps = joinSteps(ctx.ops.platform);
  if (!(await chooseAskMode(ctx, steps.map((x) => x.title)))) return 0;
  const res = await runLocalSteps(ctx, steps, "join");
  printSummary(ctx, res, "join");
  return res.code;
}

export { moveFlow } from "./move.js";
