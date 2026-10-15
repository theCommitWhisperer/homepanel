import { findReachableHa } from "./ha/address.js";
import { HaClient } from "./ha/client.js";
import { serverHealth } from "./steps/server.js";
import { adminLogin } from "./steps/pcs.js";
import type { StateStore } from "./state.js";
import type { Out } from "./ui.js";
import { MOSQUITTO_SLUG } from "./constants.js";

export interface Check {
  name: string;
  ok: boolean | "skip";
  detail: string;
  fix?: string;
}

export async function runChecks(store: StateStore, fetchImpl: typeof fetch = globalThis.fetch): Promise<Check[]> {
  const checks: Check[] = [];
  const st = store.state;
  const sec = store.secrets;

  // 1. HA reachable
  if (!st.haUrl) {
    checks.push({ name: "Home Assistant address", ok: false, detail: "not configured", fix: "Run `homepanel setup` (step: detect)." });
  } else {
    const client = new HaClient(st.haUrl, { fetchImpl, token: sec.haToken });
    const s = await client.onboardingStatus(2500);
    if (s.state === "unreachable") {
      const alt = await findReachableHa(fetchImpl, st.haUrl, 1500);
      const hint = alt && alt !== st.haUrl ? ` (found Home Assistant answering at ${alt})` : "";
      const fix =
        alt && alt !== st.haUrl
          ? `Run \`homepanel ha-address ${alt}\` to switch to it, or \`homepanel setup --step staticip\` to fix its IP.`
          : "Is it powered on and on the network? Check the IP in your router (HA OS also shows it on an attached monitor), " +
            "then run `homepanel ha-address <ip>`. Keep it fixed with `homepanel setup --step staticip`.";
      checks.push({
        name: "Home Assistant reachable",
        ok: false,
        detail: `${st.haUrl}: ${s.error}${hint}`,
        fix,
      });
    } else {
      checks.push({ name: "Home Assistant reachable", ok: true, detail: `${st.haUrl} (${s.state})` });
      // 2. token valid
      if (!sec.haToken) {
        checks.push({ name: "HA token", ok: false, detail: "none saved", fix: "Run `homepanel setup` (step: token)." });
      } else if (await client.apiOk()) {
        checks.push({ name: "HA token", ok: true, detail: "accepted" });
        // 3. MQTT integration + broker
        try {
          const entries = await client.withWs(async (ws) => {
            const mqtt = await ws.configEntries("mqtt");
            let broker: string | undefined;
            if (st.haOs) {
              broker = await ws.supervisor(`/addons/${MOSQUITTO_SLUG}/info`, "get").then(
                (i: any) => i?.state as string,
                () => undefined,
              );
            }
            return { mqtt, broker };
          });
          const mqttOk = entries.mqtt.length > 0 && entries.mqtt.every((e) => e.state === "loaded");
          checks.push({
            name: "MQTT",
            ok: mqttOk && (entries.broker === undefined || entries.broker === "started"),
            detail:
              (entries.mqtt.length ? `integration ${entries.mqtt[0]!.state}` : "no MQTT integration") +
              (entries.broker ? `, Mosquitto app ${entries.broker}` : ""),
            fix: mqttOk ? "Start the Mosquitto broker app in HA → Settings → Apps." : "Run `homepanel setup` (step: mqtt).",
          });
        } catch (e) {
          checks.push({ name: "MQTT", ok: false, detail: (e as Error).message, fix: "Run `homepanel setup` (step: mqtt)." });
        }
      } else {
        checks.push({
          name: "HA token",
          ok: false,
          detail: "rejected",
          fix: "The token was revoked or HA was reset. Run `homepanel setup` and redo the token step.",
        });
      }
    }
  }

  // 4. HomePanel server
  if (!st.serverUrl) {
    checks.push({ name: "HomePanel server", ok: "skip", detail: "address not configured", fix: "Run `homepanel setup` (step: server)." });
  } else {
    const h = await serverHealth(fetchImpl, st.serverUrl);
    if (!h.ok) {
      checks.push({
        name: "HomePanel server",
        ok: false,
        detail: `${st.serverUrl}: ${h.error}`,
        fix: st.haOs === false ? "cd to your Docker folder and run `docker compose logs homepanel`." : "HA → Settings → Apps → HomePanel → Log.",
      });
    } else {
      checks.push({ name: "HomePanel server", ok: true, detail: `${st.serverUrl} v${h.version ?? "?"}` });
      checks.push({
        name: "Server ↔ Home Assistant",
        ok: h.ha === "connected" || h.ha === "demo",
        detail: String(h.ha),
        fix: "Check HA_URL/HA_TOKEN in the server config (Docker .env) or restart the HomePanel app.",
      });
      checks.push({
        name: "Server ↔ MQTT",
        ok: h.mqtt === "connected" || h.mqtt === "demo",
        detail: String(h.mqtt),
        fix: "Check the Mosquitto broker is running and MQTT_URL/USER/PASS are right.",
      });
      // 5. agents
      if (sec.adminPassword) {
        try {
          const session = await adminLogin(fetchImpl, st.serverUrl, sec.adminPassword);
          const r = await fetchImpl(`${st.serverUrl}/api/admin/agents`, {
            headers: { authorization: `Bearer ${session}` },
            signal: AbortSignal.timeout(5000),
          });
          const agents = (await r.json()) as { pcId: string; status: string }[];
          if (!agents.length) checks.push({ name: "PC agents", ok: "skip", detail: "none registered" });
          for (const a of agents)
            checks.push({
              name: `Agent ${a.pcId}`,
              ok: a.status === "online",
              detail: a.status,
              fix: "Is the PC on? Is the agent running (Task Scheduler → HomePanel Agent)? Is LibreHardwareMonitor's web server on?",
            });
        } catch (e) {
          checks.push({ name: "PC agents", ok: "skip", detail: (e as Error).message });
        }
      }
    }
  }
  return checks;
}

export async function doctor(store: StateStore, out: Out, fetchImpl?: typeof fetch): Promise<number> {
  out.heading("HomePanel doctor");
  const checks = await runChecks(store, fetchImpl);
  let failed = 0;
  for (const c of checks) {
    if (c.ok === true) out.ok(`${c.name}: ${c.detail}`);
    else if (c.ok === "skip") out.info(`${c.name}: ${c.detail}`);
    else {
      failed++;
      out.err(`${c.name}: ${c.detail}`);
      if (c.fix) out.line(`    fix: ${c.fix}`);
    }
  }
  out.line();
  if (failed) out.warn(`${failed} problem(s) found.`);
  else out.ok("All checks passed.");
  return failed ? 1 : 0;
}
