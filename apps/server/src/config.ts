import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the server package (works from both src/ and dist/). */
export const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DATA_EXAMPLE_DIR = path.join(PKG_ROOT, "data-example");

export interface EnvConfig {
  port: number;
  host: string;
  dataDir: string;
  haUrl?: string;
  haToken?: string;
  /** running as an HA app (add-on) under the Supervisor */
  supervisor: boolean;
  mqttUrl?: string;
  mqttUser?: string;
  mqttPass?: string;
  adminPassword?: string;
  kioskDist: string;
  /** built PC agent for Windows (served at /agent/*) */
  agentDist: string;
  demo: boolean;
  trustProxy: boolean;
  wolBroadcast: string;
  logLevel: string;
  ai: { provider?: string; apiKey?: string; model?: string; baseUrl?: string };
}

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v);

export function loadEnv(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): EnvConfig {
  const demo = truthy(env.DEMO) || argv.includes("--demo");
  const supervisorToken = env.SUPERVISOR_TOKEN;
  const useSupervisor = !!supervisorToken && !env.HA_TOKEN;
  const haUrl = (env.HA_URL || (useSupervisor ? "http://supervisor/core" : "")).replace(/\/+$/, "") || undefined;
  const haToken = env.HA_TOKEN || supervisorToken || undefined;
  const dataDir = path.resolve(env.DATA_DIR || (demo ? "./.demo-data" : "./data"));
  const kioskDist = env.KIOSK_DIST ? path.resolve(env.KIOSK_DIST) : path.resolve(PKG_ROOT, "../kiosk/dist");
  return {
    port: Number(env.PORT || 8080),
    host: env.HOST || "0.0.0.0",
    dataDir,
    haUrl,
    haToken,
    supervisor: !!supervisorToken,
    mqttUrl: env.MQTT_URL || undefined,
    mqttUser: env.MQTT_USER || undefined,
    mqttPass: env.MQTT_PASS || undefined,
    adminPassword: env.ADMIN_PASSWORD || (demo ? "demo" : undefined),
    kioskDist,
    agentDist: env.AGENT_DIST ? path.resolve(env.AGENT_DIST) : path.resolve(PKG_ROOT, "../agent/dist/windows"),
    demo,
    trustProxy: truthy(env.TRUST_PROXY),
    wolBroadcast: env.WOL_BROADCAST || "255.255.255.255",
    logLevel: env.LOG_LEVEL || "info",
    ai: { provider: env.AI_PROVIDER, apiKey: env.AI_API_KEY, model: env.AI_MODEL, baseUrl: env.AI_BASE_URL },
  };
}

/** Parse a dotenv file: KEY=value lines, # comments, optional quotes, optional `export `. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) {
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]!] = v;
  }
  return out;
}

/**
 * Merge DATA_DIR/.env (written by the installer) into `env`. Real environment variables win.
 * DATA_DIR itself comes from the environment (or the default), never from the file.
 */
export function withDataDirEnv(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): NodeJS.ProcessEnv {
  const demo = truthy(env.DEMO) || argv.includes("--demo");
  const dataDir = path.resolve(env.DATA_DIR || (demo ? "./.demo-data" : "./data"));
  const file = path.join(dataDir, ".env");
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseDotEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return env;
  }
  delete fromFile.DATA_DIR;
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [k, v] of Object.entries(fromFile)) if (merged[k] === undefined || merged[k] === "") merged[k] = v;
  return merged;
}
