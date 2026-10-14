/**
 * Mode 4, "Move the server to Home Assistant": for a PC that ran "Host on this PC" once the HomePanel
 * app runs on Home Assistant (http://<ha-ip>:8080).
 *
 *   1. register this PC with the new server and point agent.yaml at HA's broker, restart the agent
 *   2. wait until the new server shows this PC online
 *   3. copy the layouts (profiles/*.yaml) and config.yaml from the local server's data folder
 *   4. retire the local server: remove the "HomePanel Server" task, stop Mosquitto (Manual start;
 *      uninstall offered), remove the two firewall rules
 *   5. pair this PC's browser with the new server; print the new URL and the re-pair note for screens
 *
 * Every step is a LocalStep (detect → show actions → ask → run), so a second run only does what is left.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MQTT_HA_USERNAME, MQTT_PORT, SERVER_PORT } from "../constants.js";
import { StateStore } from "../state.js";
import { showCmd } from "../sys.js";
import { color } from "../ui.js";
import { normalizeServerUrl, ServerApi } from "./api.js";
import {
  FW_RULES,
  FixError,
  MOSQUITTO_ID,
  TASK_AGENT,
  TASK_SERVER,
  agentConfigStep,
  agentTaskStep,
  chooseAskMode,
  findServers,
  runLocalSteps,
  stopTaskTree,
  type LocalCtx,
  type LocalStep,
  type RunResult,
} from "./flow.js";

export interface MoveOptions {
  /** --server: the new server address */
  server?: string;
  /** the Home Assistant wizard's state (server URL, admin + MQTT passwords from mode 3); default ~/.homepanel */
  haStore?: StateStore;
}

function isThisPc(ctx: LocalCtx, url: string): boolean {
  const h = new URL(url).hostname.toLowerCase();
  const net = ctx.net();
  return ["127.0.0.1", "localhost", "[::1]", "::1", (net.ip ?? "").toLowerCase(), net.hostname.toLowerCase(), `${net.hostname.toLowerCase()}.local`].includes(h);
}

/** True when this PC runs "Host on this PC" (its setup says so, or the "HomePanel Server" task exists). */
export async function hostsServerHere(ctx: Pick<LocalCtx, "store" | "ops">): Promise<boolean> {
  if (ctx.store.state.local?.mode === "host") return true;
  try {
    return (await ctx.ops.taskInfo(TASK_SERVER)).exists;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* the steps                                                            */
/* ------------------------------------------------------------------ */

function newServer(ctx: LocalCtx): string {
  return ctx.store.state.local!.serverUrl!;
}

async function newApi(ctx: LocalCtx): Promise<ServerApi> {
  const a = new ServerApi(newServer(ctx), ctx.fetchImpl);
  try {
    await a.login(ctx.store.secrets.adminPassword ?? "");
  } catch (e) {
    throw new FixError(`Could not log in to ${a.url}: ${(e as Error).message}`, [
      `Is the HomePanel app running on Home Assistant? Open ${a.url}/api/health in a browser.`,
      "Run this mode again and type the admin password of the HomePanel app (HA → Settings → Apps → HomePanel → Configuration).",
    ]);
  }
  return a;
}

const moveAgentConfigStep: LocalStep = {
  ...agentConfigStep,
  title: "Register this PC with the new server + point agent.yaml at Home Assistant",
  why: "Gives this PC a signing key on the new server and switches its MQTT login to Home Assistant's broker (your buttons are kept).",
};

const moveAgentTaskStep: LocalStep = {
  ...agentTaskStep,
  title: `Restart the agent ("${TASK_AGENT}") and wait until the new server shows it online`,
  why: "The agent reads agent.yaml when it starts.",
};

function localLayouts(ctx: LocalCtx): { id: string; file: string; yaml: string }[] {
  const dir = join(ctx.paths.serverDir, "profiles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((f) => ({ id: f.replace(/\.ya?ml$/i, ""), file: join(dir, f), yaml: readFileSync(join(dir, f), "utf8") }));
}

const localConfigPath = (ctx: LocalCtx) => join(ctx.paths.serverDir, "config.yaml");
const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();

export const copyLayoutsStep: LocalStep = {
  id: "layouts",
  title: "Copy your layouts and server settings to the new server",
  why: "Dashboards (profiles) and config.yaml (doorbells, Fully Kiosk, assistant) from this PC's server, via the admin API.",
  async detect(ctx) {
    const mine = localLayouts(ctx);
    const hasConfig = existsSync(localConfigPath(ctx));
    if (!mine.length && !hasConfig) return { done: true, detail: `Nothing to copy (no layouts in ${ctx.paths.serverDir}).` };
    let theirs: { id: string; yaml: string }[];
    try {
      theirs = await (await newApi(ctx)).profileTexts();
    } catch (e) {
      return { done: false, detail: (e as Error).message };
    }
    const missing = mine.filter((p) => norm(theirs.find((t) => t.id === p.id)?.yaml ?? "") !== norm(p.yaml)).map((p) => p.id);
    if (missing.length) return { done: false, detail: `Not on the new server yet (or different there): ${missing.join(", ")}.` };
    if (hasConfig && !ctx.store.state.local?.configCopied) return { done: false, detail: "Layouts are there; config.yaml not copied yet." };
    return { done: true, detail: `All ${mine.length} layout(s)${hasConfig ? " and config.yaml" : ""} are on the new server.` };
  },
  async actions(ctx) {
    const url = newServer(ctx);
    const a = localLayouts(ctx).map((p) => `PUT ${url}/api/admin/profiles/${p.id}   ← ${p.file}`);
    if (existsSync(localConfigPath(ctx))) a.push(`PUT ${url}/api/admin/config   ← ${localConfigPath(ctx)}`);
    a.push("(same ids on the new server are replaced; this PC's files are not changed)");
    return a;
  },
  async run(ctx) {
    const api = await newApi(ctx);
    const failed: string[] = [];
    for (const p of localLayouts(ctx)) {
      try {
        await api.putProfile(p.id, p.yaml);
        ctx.out.ok(`Layout "${p.id}" copied.`);
      } catch (e) {
        failed.push(`${p.id}: ${(e as Error).message}`);
      }
    }
    if (existsSync(localConfigPath(ctx))) {
      try {
        await api.putConfig(readFileSync(localConfigPath(ctx), "utf8"));
        ctx.store.updateLocal({ configCopied: true });
        ctx.out.ok("config.yaml copied.");
      } catch (e) {
        failed.push(`config.yaml: ${(e as Error).message}`);
      }
    }
    if (failed.length)
      throw new FixError(`Some files were not accepted by the new server:\n  ${failed.join("\n  ")}`, [
        `Open ${newServer(ctx)}/admin → Profiles, paste the layout from ${join(ctx.paths.serverDir, "profiles")} and fix what it reports.`,
        "Or choose Skip; the files stay on this PC.",
      ]);
  },
};

const win = (ctx: LocalCtx) => ctx.ops.platform === "win32";

export const retireServerStep: LocalStep = {
  id: "retire",
  title: "Retire the server on this PC",
  why: "Two servers would compete for the same PCs. Your old data folder is kept as a backup.",
  async detect(ctx) {
    const left: string[] = [];
    if ((await ctx.ops.taskInfo(TASK_SERVER)).exists) left.push(`the "${TASK_SERVER}" task`);
    if ((await ctx.ops.serviceInfo("mosquitto")).running) left.push("the Mosquitto service");
    if (win(ctx)) for (const r of FW_RULES) if (await ctx.ops.firewallRuleExists(r.name)) left.push(`firewall rule ${r.name}`);
    return left.length ? { done: false, detail: `Still here: ${left.join(", ")}.` } : { done: true, detail: "No local server, broker or firewall rules left." };
  },
  async actions(ctx) {
    const a = [
      win(ctx) ? `Stop and delete the scheduled task "${TASK_SERVER}" (Unregister-ScheduledTask)` : "systemctl disable --now homepanel-server.service; remove the unit",
      win(ctx) ? "Stop the Mosquitto service and set it to Manual start (Set-Service mosquitto -StartupType Manual)" : "systemctl disable --now mosquitto",
    ];
    if (win(ctx)) a.push(`Remove firewall rules ${FW_RULES.map((r) => r.name).join(" and ")}`);
    a.push(`Keep ${ctx.paths.serverDir} (old layouts, paired screens) as a backup`);
    return a;
  },
  async run(ctx) {
    const h = await new ServerApi(newServer(ctx), ctx.fetchImpl).health();
    if (!h?.ok)
      throw new FixError(`The new server ${newServer(ctx)} does not answer, so the local one stays for now.`, [
        "Start the HomePanel app in Home Assistant (Settings → Apps → HomePanel → Start), then Retry.",
      ]);
    await stopTaskTree(ctx, TASK_SERVER, "server");
    const u = await ctx.ops.unregisterTask(TASK_SERVER);
    if (u.code !== 0) throw new FixError(`Could not remove "${TASK_SERVER}": ${(u.stderr || u.stdout).trim().slice(0, 300)}`, ["Run setup as administrator, then retry."]);
    const m = await ctx.ops.disableService("mosquitto");
    if (m.code !== 0) ctx.out.warn(`Stopping Mosquitto said: ${(m.stderr || m.stdout).trim().slice(0, 200)}`);
    if (win(ctx))
      for (const r of FW_RULES) {
        const x = await ctx.ops.removeFirewallRule(r.name);
        if (x.code !== 0) ctx.out.warn(`Removing firewall rule ${r.name}: ${x.stderr.trim().slice(0, 200)}`);
      }
    if (!ctx.yes) {
      const cmd = ctx.ops.uninstallPackageCommand(MOSQUITTO_ID);
      if (await ctx.prompt.confirm({ message: `Also uninstall Mosquitto from this PC (${showCmd(cmd[0]!, cmd.slice(1))})? It is not needed any more.`, default: false })) {
        const r = await ctx.ops.uninstallPackage(MOSQUITTO_ID);
        if (r.code === 0) ctx.out.ok("Mosquitto uninstalled.");
        else ctx.out.warn(`Uninstall said exit ${r.code}; uninstall it from Settings → Apps if it is still listed.`);
      }
    }
  },
};

export const moveBrowserStep: LocalStep = {
  id: "browser",
  title: "Open the new dashboard on this PC",
  why: "This PC's browser was paired with the old server; pairs it with the new one (no code to type).",
  async detect(ctx) {
    const l = ctx.store.state.local;
    return l?.browserServer === newServer(ctx) && ctx.store.secrets.deviceToken
      ? { done: true, detail: "This PC's browser is paired with the new server." }
      : { done: false, detail: "Not paired with the new server yet." };
  },
  async actions(ctx) {
    return [`Pair "${ctx.net().hostname} (this PC)" on ${newServer(ctx)} with your desk layout and open it in your default browser`];
  },
  async run(ctx) {
    const api = await newApi(ctx);
    let profile = "desk-monitor";
    try {
      const ids = await api.profiles();
      if (!ids.includes(profile) && ids[0]) profile = ids[0];
    } catch {
      /* default */
    }
    const { token } = await api.pairDevice(`${ctx.net().hostname} (this PC)`, profile);
    ctx.store.setSecret("deviceToken", token);
    ctx.store.updateLocal({ browserPaired: true, browserServer: newServer(ctx) });
    await ctx.ops.openUrl(`${newServer(ctx)}/?token=${encodeURIComponent(token)}`);
  },
};

export function moveSteps(): LocalStep[] {
  return [moveAgentConfigStep, moveAgentTaskStep, copyLayoutsStep, retireServerStep, moveBrowserStep];
}

/* ------------------------------------------------------------------ */
/* the flow                                                             */
/* ------------------------------------------------------------------ */

async function pickNewServer(ctx: LocalCtx, ha: StateStore, given?: string): Promise<string | undefined> {
  const { out, prompt } = ctx;
  if (given) return normalizeServerUrl(given);
  const known = [
    ctx.store.state.local?.movedFrom ? ctx.store.state.local.serverUrl : undefined,
    ha.state.serverUrl,
    ha.state.host ? `http://${ha.state.host}:${SERVER_PORT}` : undefined,
    ha.state.proxmox?.haIp ? `http://${ha.state.proxmox.haIp}:${SERVER_PORT}` : undefined,
  ]
    .filter((u): u is string => !!u)
    .map((u) => normalizeServerUrl(u))
    .filter((u) => !isThisPc(ctx, u));
  const live: string[] = [];
  for (const u of [...new Set(known)]) if ((await new ServerApi(u, ctx.fetchImpl).health())?.ok) live.push(u);
  if (live.length && ctx.yes) return live[0];
  if (!live.length) {
    out.info("Looking for the HomePanel app on your network (a few seconds)…");
    for (const u of await findServers(ctx, { extra: known })) if (!isThisPc(ctx, u) && !live.includes(u)) live.push(u);
  }
  if (!live.length) out.warn("No other HomePanel server answered. Install the HomePanel app on Home Assistant first (start menu → 3).");
  const pick = await prompt.select<string>({
    message: "Which server is the new one (the HomePanel app on Home Assistant)?",
    choices: [
      ...live.map((u) => ({ value: u, name: u })),
      { value: "__type", name: "Type its address (Home Assistant's IP)" },
      { value: "__quit", name: "Quit" },
    ],
    default: live[0],
  });
  if (pick === "__quit") return undefined;
  if (pick !== "__type") return pick;
  for (;;) {
    const v = await prompt.input({ message: "Home Assistant's address (e.g. 192.168.1.60):" });
    try {
      const u = normalizeServerUrl(v);
      if (isThisPc(ctx, u)) out.warn("That is this PC. Type the address of Home Assistant.");
      else if ((await new ServerApi(u, ctx.fetchImpl).health())?.ok) return u;
      else out.warn(`${u}/api/health did not answer. Is the HomePanel app started in Home Assistant?`);
    } catch {
      out.warn("That is not an address.");
    }
    if (!(await prompt.confirm({ message: "Try another address?", default: true }))) return undefined;
  }
}

export async function moveFlow(ctx: LocalCtx, o: MoveOptions = {}): Promise<number> {
  const { out, prompt, store } = ctx;
  out.heading("Move the server to Home Assistant");
  out.line(
    "  The HomePanel app on Home Assistant takes over, so dashboards keep working when this PC is off.\n" +
      "  This PC keeps its temperatures and buttons (its agent now reports to Home Assistant).",
  );
  // an unfinished move (movedFrom set) may continue even after the local server is gone
  if (!store.state.local?.movedFrom && !(await hostsServerHere(ctx))) {
    out.info(`This PC does not run a HomePanel server (no "${TASK_SERVER}" task), so there is nothing to move.`);
    out.info('To connect this PC to the server on Home Assistant, choose "Join this PC to my HomePanel".');
    return 0;
  }
  const ha = o.haStore ?? new StateStore();
  const l0 = store.state.local ?? {};
  const resuming = !!l0.movedFrom;

  const url = await pickNewServer(ctx, ha, o.server);
  if (!url) return 0;
  const api = new ServerApi(url, ctx.fetchImpl);
  const h = await api.health();
  if (!h?.ok) {
    out.err(`${url} does not answer. Install/start the HomePanel app on Home Assistant first (start menu → 3), then run this again.`);
    return 1;
  }
  out.ok(`New server: HomePanel ${h.version ?? ""} at ${url} (MQTT ${h.mqtt ?? "?"}, Home Assistant ${h.ha ?? "?"})`);

  // admin password of the NEW server: from mode 3 on this PC, an unfinished move, env, or typed
  const sameHa = !!ha.state.serverUrl && normalizeServerUrl(ha.state.serverUrl) === url;
  let pw = (sameHa ? ha.secrets.adminPassword : undefined) ?? (resuming && l0.serverUrl === url ? store.secrets.adminPassword : undefined);
  pw ??= process.env.HOMEPANEL_ADMIN_PASSWORD || undefined;
  for (;;) {
    if (!pw) pw = await prompt.password({ message: "Admin password of the HomePanel app on Home Assistant (hidden; its Configuration tab):" });
    try {
      await api.login(pw);
      break;
    } catch (e) {
      out.warn((e as Error).message);
      pw = undefined;
      if (!(await prompt.confirm({ message: "Try again?", default: true }))) return 1;
    }
  }

  // Home Assistant's MQTT broker (Mosquitto app) login for this PC's agent
  const mqttHost = new URL(url).hostname;
  let user = (sameHa ? ha.state.mqtt?.username : undefined) ?? (resuming ? l0.mqttUser : undefined) ?? MQTT_HA_USERNAME;
  let mpw = (sameHa ? ha.secrets.mqttPassword : undefined) ?? (resuming && l0.mqttHost === mqttHost ? store.secrets.mqttPassword : undefined);
  mpw ??= process.env.HOMEPANEL_MQTT_PASSWORD || undefined;
  for (;;) {
    if (!mpw) {
      if (!ctx.yes) user = (await prompt.input({ message: "Home Assistant MQTT username:", default: user })).trim() || MQTT_HA_USERNAME;
      mpw = await prompt.password({ message: `Password of the Home Assistant user "${user}" (hidden; the MQTT login HomePanel setup created):` });
    }
    try {
      await ctx.mqttCheck(`mqtt://${mqttHost}:${MQTT_PORT}`, user, mpw);
      out.ok(`MQTT login works on ${mqttHost}:${MQTT_PORT}.`);
      break;
    } catch (e) {
      out.warn(`MQTT login to ${mqttHost}:${MQTT_PORT} failed: ${(e as Error).message}`);
      out.info("“Not authorized” = wrong user/password. A timeout = the Mosquitto broker app is not running in Home Assistant.");
      const what = await prompt.select<"again" | "keep" | "quit">({
        message: "What now?",
        choices: [
          { value: "again", name: "Type the password again" },
          { value: "keep", name: "Keep it and continue anyway" },
          { value: "quit", name: "Quit (nothing was changed)" },
        ],
      });
      if (what === "quit") return 1;
      if (what === "keep") break;
      mpw = undefined;
    }
  }

  // From here on this PC is a "join" PC of the new server. The old server's data stays on disk.
  store.setSecret("adminPassword", pw);
  store.setSecret("mqttPassword", mpw);
  store.updateLocal({
    mode: "join",
    serverUrl: url,
    mqttHost,
    mqttUser: user,
    movedFrom: l0.movedFrom ?? l0.serverUrl ?? `http://127.0.0.1:${SERVER_PORT}`,
  });
  await ctx.ops.restrictAcl(ctx.paths.setupDir, { dir: true });

  const steps = moveSteps();
  if (!(await chooseAskMode(ctx, steps.map((s) => s.title)))) return 0;
  const res = await runLocalSteps(ctx, steps, "move");
  printMoveSummary(ctx, res);
  return res.code;
}

function printMoveSummary(ctx: LocalCtx, res: RunResult) {
  const { out } = ctx;
  const url = newServer(ctx);
  out.heading("Summary");
  const icon = { done: color.green("✔"), skipped: color.yellow("–"), manual: color.yellow("!"), failed: color.red("✖"), quit: color.red("■") };
  for (const r of res.results) out.line(`  ${icon[r.status]} ${r.title}${r.status === "done" ? "" : `  (${r.status})`}`);
  out.line();
  out.ok(`Dashboard now: ${color.bold(url)}   Admin: ${url}/admin`);
  out.warn("Screens paired to the old server (this PC) must pair again:");
  out.steps([
    `On each tablet / screen open ${color.bold(url)} (update the Fully Kiosk start URL / bookmark).`,
    `A 6-digit code appears: approve it in ${url}/admin → Screens and pick its layout.`,
  ]);
  out.info(
    `Other PCs that joined this PC's server: run HomePanel.exe on each → "Join this PC" → ${url} (MQTT user ${ctx.store.state.local?.mqttUser ?? MQTT_HA_USERNAME}, the password from Home Assistant setup).`,
  );
  out.info(`The old server's files stay in ${ctx.paths.serverDir} (backup; safe to delete later).`);
  if (res.results.some((r) => r.status !== "done")) out.info("Run this mode again to finish the skipped steps — finished ones are not repeated.");
}
