import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homepanelHome } from "../state.js";
import { randomPassword } from "../sys.js";
import { envFile } from "./host.js";
import { serverHealth } from "./server.js";
import type { Step, StepContext } from "./types.js";

/* ------------------------------------------------------------------ */
/* env: write the HomePanel server's .env                               */
/* ------------------------------------------------------------------ */

/** The variables apps/server reads (see apps/server/src/config.ts). */
export function serverEnv(ctx: StepContext): Record<string, string | undefined> {
  const st = ctx.store.state;
  const sec = ctx.store.secrets;
  const m = st.mqtt;
  const mqttHost = !m ? undefined : m.host;
  return {
    HA_URL: st.haUrl,
    HA_TOKEN: sec.haToken,
    MQTT_URL: mqttHost ? `mqtt://${mqttHost}:${m!.port}` : undefined,
    MQTT_USER: m?.username,
    MQTT_PASS: sec.mqttPassword,
    ADMIN_PASSWORD: sec.adminPassword,
    DATA_DIR: undefined,
  };
}

function ensureAdminPassword(ctx: StepContext) {
  if (!ctx.store.secrets.adminPassword) {
    ctx.store.setSecret("adminPassword", randomPassword(16));
    ctx.out.info("Generated an admin password for the HomePanel admin page (shown once below).");
  }
  ctx.vault.add("adminPassword", ctx.store.secrets.adminPassword!);
}

export const envStep: Step = {
  id: "env",
  title: "Server settings (.env)",
  summary: "Write HA_URL, HA_TOKEN, MQTT and admin password for a HomePanel server you run yourself.",
  plan: () =>
    "Generate an admin password if none is saved, then write a .env file (mode 600) with HA_URL, HA_TOKEN, MQTT_URL, " +
    "MQTT_USER, MQTT_PASS and ADMIN_PASSWORD into the server data folder you choose (default ~/.homepanel/server). " +
    "If HomePanel runs as a Home Assistant app, nothing is written: it only prints the app options to set.",
  explain:
    "The HomePanel server reads its settings from environment variables. When it runs as a Home Assistant app it gets " +
    "HA and MQTT access from the Supervisor and only needs admin_password. When you run it yourself (node or Docker), " +
    "it needs a .env file next to it with the HA address, the long-lived token and the MQTT login.",
  async detect(ctx) {
    const s = ctx.store.state.steps.env;
    return s?.status === "done" ? { done: true, detail: s.note ?? "Settings written earlier." } : { done: false, detail: "Not written yet." };
  },
  async run(ctx) {
    const { out, prompt, store } = ctx;
    ensureAdminPassword(ctx);
    const where = await prompt.select({
      message: "Where does the HomePanel server run?",
      choices: [
        { value: "app", name: "As a Home Assistant app (HA OS) — just show me the options" },
        { value: "file", name: "Myself (node or Docker) — write a .env file" },
      ],
      default: store.state.haOs === false ? "file" : "app",
    });
    if (where === "app") {
      out.info("In HA → Settings → Apps → HomePanel → Configuration set:");
      out.code(`admin_password: ${store.secrets.adminPassword}`);
      out.info("HA and MQTT access come from the Supervisor (HA_URL=http://supervisor/core, HA_TOKEN=$SUPERVISOR_TOKEN).");
      return "done";
    }
    const missing = (["haUrl"] as const).filter((k) => !store.state[k]);
    if (missing.length || !store.secrets.haToken) out.warn("The HA address or token is missing; run the detect and token steps first for a complete file.");
    const dir = resolve(await prompt.input({ message: "Server data folder:", default: join(homepanelHome(), "server") }));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, ".env");
    writeFileSync(file, envFile({ ...serverEnv(ctx), DATA_DIR: dir }), { mode: 0o600 });
    out.ok(`Wrote ${file} (contains secrets — keep it private).`);
    out.info(`Admin password: ${store.secrets.adminPassword}`);
    store.mark("env", "done", `Wrote ${file}`);
    return "done";
  },
};

/* ------------------------------------------------------------------ */
/* health: one summary at the end                                       */
/* ------------------------------------------------------------------ */

export interface HealthSummary {
  ha: { reachable: boolean; version?: string; entities?: number; error?: string };
  mqtt: { integration: string; error?: string };
  zigbee?: { devices: number } | { error: string };
  server?: Awaited<ReturnType<typeof serverHealth>>;
}

export async function healthSummary(ctx: StepContext): Promise<HealthSummary> {
  const st = ctx.store.state;
  const out: HealthSummary = { ha: { reachable: false }, mqtt: { integration: "unknown" } };
  if (st.haUrl && ctx.store.secrets.haToken) {
    try {
      await ctx.ha().withWs(async (s) => {
        const cfg = await s.getConfig();
        const states = await s.getStates();
        out.ha = { reachable: true, version: cfg.version, entities: states.length };
        const mq = await s.configEntries("mqtt");
        out.mqtt = { integration: mq.length ? mq.map((e) => e.state).join(",") : "not set up" };
        const zha = await s.configEntries("zha");
        if (zha.length) {
          const devs = await s.call<unknown[]>("zha/devices").catch((e: Error) => e);
          out.zigbee = devs instanceof Error ? { error: devs.message } : { devices: devs.length };
        }
      });
    } catch (e) {
      out.ha = { reachable: false, error: (e as Error).message };
    }
  } else out.ha.error = st.haUrl ? "no token saved" : "HA address unknown";
  if (st.serverUrl) out.server = await serverHealth(ctx.fetchImpl, st.serverUrl);
  return out;
}

export const healthStep: Step = {
  id: "health",
  title: "Health check",
  summary: "Count HA entities, check MQTT, Zigbee and the HomePanel server, and print a summary.",
  plan: () => "Read-only: query Home Assistant (config, states, MQTT/ZHA entries) and GET <server>/api/health.",
  explain: "A final check that everything talks to each other. Safe to run any time (also: `homepanel doctor`).",
  async detect() {
    return { done: false, detail: "Runs every time." };
  },
  async run(ctx) {
    const { out } = ctx;
    const h = await healthSummary(ctx);
    const mark = (ok: boolean, msg: string) => (ok ? out.ok(msg) : out.warn(msg));
    mark(h.ha.reachable, h.ha.reachable ? `Home Assistant ${h.ha.version ?? ""}: ${h.ha.entities} entities` : `Home Assistant: ${h.ha.error}`);
    mark(/loaded/.test(h.mqtt.integration), `MQTT integration: ${h.mqtt.integration}`);
    if (h.zigbee) mark("devices" in h.zigbee, "devices" in h.zigbee ? `Zigbee (ZHA): ${h.zigbee.devices} devices` : `Zigbee: ${h.zigbee.error}`);
    if (h.server) mark(h.server.ok, h.server.ok ? `HomePanel server: HA ${h.server.ha}, MQTT ${h.server.mqtt}` : `HomePanel server: ${h.server.error}`);
    else out.info("HomePanel server: address not known yet.");
    const good = h.ha.reachable && (!h.server || h.server.ok);
    return good ? "done" : "manual";
  },
};
