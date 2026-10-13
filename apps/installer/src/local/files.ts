/**
 * Pure file-content helpers for the local (this PC) setup: LibreHardwareMonitor settings,
 * Mosquitto config, server .env, agent.yaml patching.
 */
import YAML from "yaml";

/* ------------------------------------------------------------------ */
/* LibreHardwareMonitor                                                 */
/* ------------------------------------------------------------------ */

/**
 * Settings LHM reads at start from `LibreHardwareMonitor.config` next to its exe
 * (MainForm.cs: `_settings.Load(Path.ChangeExtension(Application.ExecutablePath, ".config"))`;
 * PersistentSettings.cs writes `<configuration><appSettings><add key value/>`; booleans are
 * "true"/"false", compared with `== "true"`). Key names from UserOption(...) calls in MainForm.cs.
 */
export const LHM_SETTINGS: Record<string, string> = {
  /** Options → Remote Web Server → Run */
  runWebServerMenuItem: "true",
  /** Options → Remote Web Server → Port (HttpServer listener port) */
  listenerPort: "8085",
  /** Options → Start Minimized */
  startMinMenuItem: "true",
  /** Options → Minimize To Tray */
  minTrayMenuItem: "true",
  /** Options → Minimize On Close (closing the window keeps it running in the tray) */
  minCloseMenuItem: "true",
};

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlUnesc = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function parseLhmConfig(xml: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!xml) return m;
  const re = /<add\s+key="([^"]*)"\s+value="([^"]*)"\s*\/>/g;
  for (const x of xml.matchAll(re)) m.set(xmlUnesc(x[1]!), xmlUnesc(x[2]!));
  return m;
}

/** Existing settings (window positions, sensor choices…) are kept; ours are set. */
export function lhmConfigXml(existing: string | undefined, settings = LHM_SETTINGS): string {
  const m = parseLhmConfig(existing);
  for (const [k, v] of Object.entries(settings)) m.set(k, v);
  const rows = [...m].map(([k, v]) => `    <add key="${xmlEsc(k)}" value="${xmlEsc(v)}" />`);
  return ['<?xml version="1.0" encoding="utf-8"?>', "<configuration>", "  <appSettings>", ...rows, "  </appSettings>", "</configuration>", ""].join("\r\n");
}

export function lhmConfigured(existing: string | undefined, settings = LHM_SETTINGS): boolean {
  const m = parseLhmConfig(existing);
  return Object.entries(settings).every(([k, v]) => m.get(k) === v);
}

/* ------------------------------------------------------------------ */
/* Mosquitto                                                            */
/* ------------------------------------------------------------------ */

export function mosquittoConf(o: { passwordFile: string; logFile?: string; port?: number }): string {
  if (/\s/.test(o.passwordFile)) throw new Error(`Mosquitto can't use a password file path with spaces: ${o.passwordFile}`);
  return [
    "# Written by HomePanel setup. Logins are in the password file next to this one.",
    `listener ${o.port ?? 1883} 0.0.0.0`,
    "allow_anonymous false",
    `password_file ${o.passwordFile}`,
    ...(o.logFile && !/\s/.test(o.logFile) ? [`log_dest file ${o.logFile}`] : []),
    "log_type error",
    "log_type warning",
    "log_type notice",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* server .env                                                          */
/* ------------------------------------------------------------------ */

/** KEY=value lines; values with spaces, # or ' are double-quoted; " and \\ are refused (server parseDotEnv understands it). */
export function dotEnv(vars: Record<string, string | undefined>): string {
  const lines = ["# HomePanel server settings, written by HomePanel setup. Keep this file private."];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) continue;
    const s = String(v).replace(/[\r\n]/g, "");
    if (/["\\]/.test(s)) throw new Error(`${k}: quotes and backslashes are not supported in .env values`);
    lines.push(/[\s#']/.test(s) ? `${k}="${s}"` : `${k}=${s}`);
  }
  return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* agent.yaml                                                           */
/* ------------------------------------------------------------------ */

export interface AgentConn {
  pcId: string;
  name?: string;
  mqttUrl: string;
  mqttUser: string;
  mqttPass: string;
  key: string;
}

/** Read the connection part of an existing agent.yaml (undefined if unreadable). */
export function readAgentConn(text: string | undefined): Partial<AgentConn> | undefined {
  if (!text) return undefined;
  try {
    const d = YAML.parse(text) as Record<string, any>;
    if (!d || typeof d !== "object") return undefined;
    return {
      pcId: d.pcId,
      name: d.name,
      mqttUrl: d.mqtt?.url,
      mqttUser: d.mqtt?.username,
      mqttPass: d.mqtt?.password,
      key: d.key,
    };
  } catch {
    return undefined;
  }
}

/** Update the connection fields of an existing agent.yaml, keeping comments and the buttons. */
export function patchAgentYaml(text: string, c: AgentConn): string {
  const doc = YAML.parseDocument(text);
  doc.set("pcId", c.pcId);
  if (c.name) doc.set("name", c.name);
  doc.setIn(["mqtt", "url"], c.mqttUrl);
  doc.setIn(["mqtt", "username"], c.mqttUser);
  doc.setIn(["mqtt", "password"], c.mqttPass);
  doc.set("key", c.key);
  return doc.toString();
}

export function agentConnMatches(text: string | undefined, c: AgentConn): boolean {
  const r = readAgentConn(text);
  return !!r && r.pcId === c.pcId && r.mqttUrl === c.mqttUrl && r.mqttUser === c.mqttUser && r.mqttPass === c.mqttPass && r.key === c.key;
}

/** lowercase id from a host name: "KEVIN-RIG_01" → "kevin-rig-01" */
export function sanitizePcId(s: string): string {
  const id = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return /^[a-z0-9]/.test(id) ? id : "pc";
}
