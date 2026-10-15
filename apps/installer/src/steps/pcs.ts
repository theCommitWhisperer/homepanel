import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { haHost } from "../ha/address.js";
import { homepanelHome } from "../state.js";
import type { Step, StepContext } from "./types.js";

export async function adminLogin(fetchImpl: typeof fetch, serverUrl: string, password: string): Promise<string> {
  const r = await fetchImpl(`${serverUrl}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(r.status === 401 ? "HomePanel admin password rejected" : `admin login HTTP ${r.status}`);
  const j = (await r.json()) as { session?: string };
  if (!j.session) throw new Error("admin login returned no session");
  return j.session;
}

export async function registerAgent(
  fetchImpl: typeof fetch,
  serverUrl: string,
  session: string,
  agent: { pcId: string; name: string; mac?: string },
): Promise<{ pcId: string; key: string }> {
  const r = await fetchImpl(`${serverUrl}/api/admin/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
    body: JSON.stringify(agent),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`register agent HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as { pcId: string; key: string };
}

export function agentYaml(o: {
  pcId: string;
  name: string;
  mqttUrl: string;
  mqttUser?: string;
  mqttPass?: string;
  key: string;
}): string {
  const doc = {
    pcId: o.pcId,
    name: o.name,
    mqtt: { url: o.mqttUrl, ...(o.mqttUser ? { username: o.mqttUser } : {}), ...(o.mqttPass ? { password: o.mqttPass } : {}) },
    key: o.key,
    sensorSource: "auto",
    actions: {},
  };
  return (
    "# HomePanel PC agent config. Windows: C:\\ProgramData\\HomePanel\\agent.yaml  Linux: ~/.config/homepanel/agent.yaml\n" +
    "# Add allowlisted actions under `actions:` — see the agent README.\n" +
    YAML.stringify(doc)
  );
}

export const pcsStep: Step = {
  id: "pcs",
  title: "Monitor a PC (agent)",
  summary: "Register a PC (e.g. the gaming PC) with HomePanel and produce its agent.yaml.",
  plan: () =>
    "Log in to the HomePanel admin API with the saved admin password, POST /api/admin/agents to register the PC id/name " +
    "you type (returns a signing key), and write agent-<pcId>.yaml with the MQTT login and key into ~/.homepanel/ for you to copy to that PC.",
  explain:
    "The HomePanel agent runs on each PC you want to see on a screen (temperatures via LibreHardwareMonitor, drive " +
    "space, and buttons that run allowlisted actions). It connects to the MQTT broker. Each PC has its own key; " +
    "commands from HomePanel are signed with it, and the PC only runs actions you listed in its agent.yaml.",
  async detect(ctx) {
    const a = ctx.store.state.agents ?? [];
    return a.length
      ? { done: true, detail: `Registered: ${a.map((x) => x.pcId).join(", ")}` }
      : { done: false, detail: "No PCs registered yet." };
  },
  async run(ctx) {
    const { out, prompt } = ctx;
    const pcId = (
      await prompt.input({
        message: "Short id for the PC (lowercase, e.g. gaming-pc):",
        default: "gaming-pc",
        validate: (v) => (/^[a-z0-9][a-z0-9-]{0,47}$/.test(v.trim()) ? true : "lowercase letters, digits, dashes"),
      })
    ).trim();
    const name = await prompt.input({ message: "Display name:", default: pcId === "gaming-pc" ? "Gaming PC" : pcId });
    const mac = (await prompt.input({ message: "MAC address for Wake-on-LAN (optional, Enter to skip):", default: "" })).trim();

    const serverUrl = ctx.store.state.serverUrl;
    let key: string | undefined;
    if (serverUrl && ctx.store.secrets.adminPassword) {
      try {
        const session = await adminLogin(ctx.fetchImpl, serverUrl, ctx.store.secrets.adminPassword);
        const r = await registerAgent(ctx.fetchImpl, serverUrl, session, { pcId, name, ...(mac ? { mac } : {}) });
        key = r.key;
        ctx.vault.add(`agent key ${pcId}`, key);
        out.ok(`Registered ${pcId} with the HomePanel server.`);
      } catch (e) {
        out.warn(`Could not register with the server (${(e as Error).message}).`);
      }
    }
    if (!key) {
      out.info(`Register it by hand: ${serverUrl ?? "http://<server>:8080"}/admin → Computers → Add, then copy the key into agent.yaml.`);
    }
    const m = ctx.store.state.mqtt;
    const yaml = agentYaml({
      pcId,
      name,
      mqttUrl: `mqtt://${m?.host === "127.0.0.1" ? (ctx.store.state.serverUrl ? new URL(ctx.store.state.serverUrl).hostname : "<server-ip>") : (m?.host ?? haHost(ctx.store))}:${m?.port ?? 1883}`,
      mqttUser: m?.username,
      mqttPass: ctx.store.secrets.mqttPassword,
      key: key ?? "PASTE-KEY-FROM-ADMIN-PAGE",
    });
    const dir = homepanelHome();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `agent-${pcId}.yaml`);
    writeFileSync(file, yaml, { mode: 0o600 });
    out.ok(`Wrote ${file} (contains the MQTT password and key — copy it, don't share it).`);
    out.info("On the PC (Windows):");
    out.steps([
      "Install LibreHardwareMonitor, run it as admin, Options → Remote Web Server → Run (port 8085). Options → Run on Windows startup.",
      "Download the HomePanel agent (Windows build from the HomePanel releases page, or `pnpm --filter @homepanel/agent bundle` from a checkout).",
      `Copy ${file} to C:\\ProgramData\\HomePanel\\agent.yaml on that PC.`,
      "In an admin PowerShell, run the agent's install script (apps/agent/install) — it registers the agent to start at logon. See the agent README for the exact command.",
      `The PC shows as online in ${serverUrl ?? "HomePanel"}/admin → Computers within a few seconds.`,
    ]);
    ctx.store.update({ agents: [...(ctx.store.state.agents ?? []).filter((a) => a.pcId !== pcId), { pcId, name }] });
    return key ? "done" : "manual";
  },
};
