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
    demo,
    trustProxy: truthy(env.TRUST_PROXY),
    wolBroadcast: env.WOL_BROADCAST || "255.255.255.255",
    logLevel: env.LOG_LEVEL || "info",
    ai: { provider: env.AI_PROVIDER, apiKey: env.AI_API_KEY, model: env.AI_MODEL, baseUrl: env.AI_BASE_URL },
  };
}
