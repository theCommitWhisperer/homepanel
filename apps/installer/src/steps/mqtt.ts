import { MOSQUITTO_SLUG, MQTT_HA_USERNAME } from "../constants.js";
import { haHost } from "../ha/address.js";
import type { FlowResult, HaClient, HaSocket } from "../ha/client.js";
import { randomPassword } from "../sys.js";
import type { Step, StepContext } from "./types.js";

/** Install + start an app (add-on) via the Supervisor API passthrough. Returns state. */
export async function ensureAppRunning(
  s: HaSocket,
  slug: string,
  log: (msg: string) => void,
): Promise<"started" | "installed-not-started"> {
  let info: any;
  try {
    info = await s.supervisor(`/store/addons/${slug}`, "get");
  } catch {
    info = undefined;
  }
  const installed = info ? Boolean(info.installed) : await s.supervisor(`/addons/${slug}/info`, "get").then(() => true, () => false);
  if (!installed) {
    log(`Installing app ${slug} (can take a few minutes)…`);
    await s.supervisor(`/store/addons/${slug}/install`, "post", undefined, 900);
  }
  const ai = await s.supervisor(`/addons/${slug}/info`, "get");
  if (ai?.state !== "started") {
    log(`Starting ${slug}…`);
    await s.supervisor(`/addons/${slug}/start`, "post", undefined, 300);
  }
  try {
    await s.supervisor(`/addons/${slug}/options`, "post", { boot: "auto", watchdog: true });
  } catch {
    /* not critical */
  }
  const after = await s.supervisor(`/addons/${slug}/info`, "get");
  return after?.state === "started" ? "started" : "installed-not-started";
}

/** Create (or reset the password of) the local HA user the broker login uses. */
export async function ensureMqttUser(
  s: HaSocket,
  username: string,
  password: string,
  /** asked before resetting the password of a user this installer didn't create; false = keep it */
  allowReset: () => Promise<boolean> = async () => true,
): Promise<"created" | "updated" | "kept"> {
  const users = await s.listUsers();
  const existing = users.find((u) => u.username === username);
  if (existing) {
    if (!(await allowReset())) return "kept";
    await s.changeLocalUserPassword(existing.id, password);
    return "updated";
  }
  await s.createLocalUser("HomePanel MQTT", username, password, ["system-users"]);
  return "created";
}

/**
 * Add the MQTT integration. Prefers a discovered flow (Mosquitto app → "hassio" source), else starts a
 * user flow and fills the broker form. Returns a message, or throws with a reason.
 */
export async function addMqttIntegration(
  client: HaClient,
  broker?: { host: string; port: number; username: string; password: string },
): Promise<string> {
  const existing = await client.withWs((s) => s.configEntries("mqtt")).catch(() => []);
  if (existing.length) return "MQTT integration is already set up.";

  const flows = await client.flowsInProgress().catch(() => []);
  const disc = flows.find((f) => f.handler === "mqtt");
  let r: FlowResult;
  if (disc) {
    r = await client.continueFlow(disc.flow_id, {});
  } else {
    r = await client.startFlow("mqtt");
  }
  for (let i = 0; i < 6; i++) {
    if (r.type === "create_entry") return "MQTT integration added.";
    if (r.type === "abort") {
      if (/already_configured|single_instance/.test(r.reason ?? "")) return "MQTT integration is already set up.";
      throw new Error(`MQTT setup aborted: ${r.reason}`);
    }
    if (r.type === "menu") {
      const opts = Array.isArray(r.menu_options) ? r.menu_options : Object.keys(r.menu_options ?? {});
      const pick = opts.find((o) => o === "broker") ?? opts[0];
      r = await client.continueFlow(r.flow_id, { next_step_id: pick });
      continue;
    }
    if (r.type === "form") {
      if (r.errors && Object.keys(r.errors).length) throw new Error(`MQTT setup error: ${JSON.stringify(r.errors)}`);
      const fields = (r.data_schema ?? []).map((f) => f.name);
      if (r.step_id === "hassio_confirm" || fields.length === 0) {
        r = await client.continueFlow(r.flow_id, {});
        continue;
      }
      if (fields.includes("broker")) {
        if (!broker) {
          await client.abortFlow(r.flow_id).catch(() => undefined);
          throw new Error("MQTT broker details needed");
        }
        r = await client.continueFlow(r.flow_id, {
          broker: broker.host,
          port: broker.port,
          username: broker.username,
          password: broker.password,
        });
        continue;
      }
      await client.abortFlow(r.flow_id).catch(() => undefined);
      throw new Error(`Unexpected MQTT form step "${r.step_id}"`);
    }
    throw new Error(`Unexpected MQTT flow result "${r.type}"`);
  }
  throw new Error("MQTT flow did not finish");
}

function printManual(ctx: StepContext) {
  const { out } = ctx;
  out.info("Do it by hand (2 minutes):");
  if (ctx.store.state.haOs) {
    out.steps([
      "HA → Settings → Apps (Add-ons) → App store → Mosquitto broker → Install → Start (turn on 'Start on boot').",
      `HA → Settings → People → Users (enable Advanced mode in your profile) → Add user '${MQTT_HA_USERNAME}', 'Can only log in from the local network', not admin. Note the password.`,
      "HA → Settings → Devices & services: the MQTT integration is discovered → Configure → Submit.",
      "Re-run `homepanel setup` and pick this step, or type the password when the PC agent step asks.",
    ]);
  } else {
    out.steps([
      "Make sure the mosquitto container is running: docker compose ps",
      "HA → Settings → Devices & services → Add integration → MQTT → broker 127.0.0.1, port 1883, username homepanel, password from the .env file (MQTT_PASS).",
    ]);
  }
}

export const mqttStep: Step = {
  id: "mqtt",
  title: "MQTT (Mosquitto)",
  summary: "Install the Mosquitto broker app, create a broker login and add the MQTT integration.",
  plan: (ctx) =>
    ctx.store.state.haOs === false
      ? "Add Home Assistant's MQTT integration pointing at the Mosquitto container (127.0.0.1:1883, user 'homepanel')."
      : `Through the Supervisor API: install + start the Mosquitto broker app (${MOSQUITTO_SLUG}), set it to start on boot; ` +
        `create a non-admin, local-only HA user '${MQTT_HA_USERNAME}' with a random password (used by PC agents to log in ` +
        "to the broker); then accept the discovered MQTT integration in Home Assistant.",
  explain:
    "PC agents (temperatures, drives, buttons) talk to HomePanel over MQTT. On HA OS the Mosquitto broker app is the " +
    "easy choice; it lets any HA user log in, so we make a dedicated user for HomePanel/agents. HA also gets the MQTT " +
    "integration so PC sensors show up as HA entities via discovery.",
  async detect(ctx) {
    if (!ctx.store.secrets.haToken) return { done: false, detail: "Needs the HA token first." };
    try {
      const entries = await ctx.ha().withWs((s) => s.configEntries("mqtt"));
      if (entries.length && ctx.store.secrets.mqttPassword) return { done: true, detail: "MQTT integration present, broker login saved." };
      return { done: false, detail: entries.length ? "MQTT integration present but no HomePanel broker login saved." : "No MQTT integration yet." };
    } catch (e) {
      return { done: false, detail: `Can't check: ${(e as Error).message}` };
    }
  },
  async run(ctx) {
    const { out } = ctx;
    if (!ctx.store.secrets.haToken) {
      out.err("Create the HA token first (token step).");
      return "failed";
    }
    const client = ctx.ha();
    if (ctx.store.state.haOs === false) {
      try {
        out.ok(
          await addMqttIntegration(client, {
            host: "127.0.0.1",
            port: 1883,
            username: "homepanel",
            password: ctx.store.secrets.mqttPassword ?? "",
          }),
        );
        return "done";
      } catch (e) {
        out.warn((e as Error).message);
        printManual(ctx);
        return "manual";
      }
    }

    let ok = true;
    try {
      await client.withWs(async (s) => {
        const st = await ensureAppRunning(s, MOSQUITTO_SLUG, (m) => out.info(m));
        out.ok(st === "started" ? "Mosquitto broker app is running." : "Mosquitto installed (not started yet).");
        const saved = ctx.store.secrets.mqttPassword;
        const pw = saved ?? randomPassword();
        const r = await ensureMqttUser(s, MQTT_HA_USERNAME, pw, async () =>
          // our own earlier run: resetting to the saved password is a no-op; otherwise ask
          saved
            ? true
            : ctx.prompt.confirm({
                message: `HA already has a user '${MQTT_HA_USERNAME}'. Reset its password so HomePanel can use it for MQTT?`,
                default: false,
              }),
        );
        if (r === "kept") throw new Error(`kept the existing '${MQTT_HA_USERNAME}' password; enter it manually below`);
        ctx.store.setSecret("mqttPassword", pw);
        ctx.vault.add("mqttPassword", pw);
        out.ok(`HA user '${MQTT_HA_USERNAME}' ${r} for broker logins.`);
      });
      ctx.store.update({ mqtt: { host: haHost(ctx.store), port: 1883, username: MQTT_HA_USERNAME } });
    } catch (e) {
      ok = false;
      out.warn(`Automatic Mosquitto setup failed: ${(e as Error).message}`);
    }
    // give the hassio discovery a moment to appear after a fresh Mosquitto start
    if (ok && !ctx.noWait) await new Promise((r) => setTimeout(r, 3000));
    try {
      out.ok(await addMqttIntegration(client));
    } catch (e) {
      ok = false;
      out.warn(`Could not add the MQTT integration automatically: ${(e as Error).message}`);
    }
    if (!ok) {
      printManual(ctx);
      return "manual";
    }
    return "done";
  },
};
