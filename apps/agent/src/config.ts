import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { slugify } from "./util.js";

/* ------------------------------------------------------------------ */
/* Action definitions (agent.yaml -> actions: { <id>: {...} })          */
/* ------------------------------------------------------------------ */
export const MEDIA_KEYS = [
  "media_play_pause",
  "media_next",
  "media_prev",
  "volume_up",
  "volume_down",
  "volume_mute",
] as const;
export type MediaKey = (typeof MEDIA_KEYS)[number];

export const SYSTEM_OPS = ["lock", "sleep", "restart", "shutdown", "monitors_off", "mute_mic"] as const;
export type SystemOp = (typeof SYSTEM_OPS)[number];

/** Characters cmd.exe treats specially even inside our quoting; refused in launch exe/args. */
const noQuote = (what: string) =>
  z.string().min(1).refine((s) => !s.includes('"') && !/[\r\n\0]/.test(s), {
    message: `${what} must not contain double quotes or line breaks`,
  });

const base = {
  label: z.string().min(1).optional(),
  icon: z.string().optional(),
  guard: z.enum(["confirm", "home-only", "confirm+home-only"]).optional(),
};

const ActionUnion = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("open"), path: z.string().min(1) }).strict(),
  z
    .object({
      ...base,
      type: z.literal("launch"),
      /** program path or a name Windows can resolve (PATH / App Paths) */
      exe: noQuote("exe").optional(),
      /** wildcard path; the newest match (by modification time) is launched, e.g. Roblox Studio */
      find: noQuote("find").optional(),
      args: z.array(noQuote("argument")).default([]),
    })
    .strict(),
  z.object({ ...base, type: z.literal("keys"), key: z.enum(MEDIA_KEYS) }).strict(),
  z
    .object({
      ...base,
      type: z.literal("script"),
      file: z.string().min(1),
      shell: z.enum(["powershell", "cmd", "sh"]).optional(),
      args: z.array(z.string()).default([]),
      timeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("url"),
      url: z
        .string()
        .url()
        .refine((u) => /^(https?|steam|roblox-studio|discord|spotify|ms-settings):/i.test(u), {
          message: "must be http(s) or a known app scheme (steam:, discord:, spotify:, ms-settings:, roblox-studio:)",
        }),
    })
    .strict(),
  z.object({ ...base, type: z.literal("system"), op: z.enum(SYSTEM_OPS) }).strict(),
  /** Test hook: only honoured when the agent runs with --mock. Replies ok without touching the PC. */
  z.object({ ...base, type: z.literal("echo") }).strict(),
]);
export const ActionDefSchema = ActionUnion.superRefine((a, ctx) => {
  if (a.type === "launch" && !!a.exe === !!a.find) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "launch needs exactly one of `exe` or `find`" });
  }
});
export type ActionDef = z.infer<typeof ActionDefSchema>;

const ACTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/* ------------------------------------------------------------------ */
/* agent.yaml                                                           */
/* ------------------------------------------------------------------ */
export const AgentConfigSchema = z
  .object({
    pcId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "use lowercase letters, digits and dashes (e.g. gaming-pc)"),
    name: z.string().min(1).optional(),
    mqtt: z
      .object({
        url: z.string().regex(/^(mqtts?|wss?|tcp|ssl):\/\//, "must look like mqtt://host:1883"),
        username: z.string().optional(),
        password: z.string().optional(),
        clientId: z.string().optional(),
        /** for mqtts with a self-signed broker certificate */
        rejectUnauthorized: z.boolean().default(true),
      })
      .strict(),
    /** shared secret from the server's admin "Add computer" dialog */
    key: z.string().min(16, "key looks too short — copy it from the HomePanel admin page"),
    sensorSource: z.enum(["auto", "lhm", "hwmon", "mock"]).default("auto"),
    lhmUrl: z.string().url().default("http://localhost:8085/data.json"),
    lhmAuth: z.object({ username: z.string(), password: z.string() }).optional(),
    publishIntervalMs: z.number().int().min(500).max(600_000).default(2000),
    drivesIntervalMs: z.number().int().min(5000).max(3_600_000).default(60_000),
    /** "auto" = everything except voltages/misc and network adapters; or a list of ids / globs */
    sensors: z.union([z.literal("auto"), z.array(z.string().min(1)).min(1)]).default("auto"),
    /** which sensors get Home Assistant MQTT discovery entities */
    ha_sensors: z
      .union([z.literal("default"), z.literal("none"), z.array(z.string().min(1))])
      .default("default"),
    log: z
      .object({
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        file: z.string().optional(),
      })
      .default({}),
    actions: z
      .record(z.string(), ActionDefSchema)
      .default({})
      .superRefine((rec, ctx) => {
        for (const id of Object.keys(rec)) {
          if (!ACTION_ID.test(id))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [id],
              message: "action ids: lowercase letters, digits, - and _ (max 64)",
            });
        }
      }),
  })
  .strict();
export type AgentConfig = z.infer<typeof AgentConfigSchema> & { name: string };

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(issues.length ? `${message}\n  - ${issues.join("\n  - ")}` : message);
  }
}

export function parseConfig(text: string, source = "agent.yaml"): AgentConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`${source}: invalid YAML: ${(e as Error).message}`);
  }
  const res = AgentConfigSchema.safeParse(raw ?? {});
  if (!res.success) {
    throw new ConfigError(
      `${source} is not valid`,
      res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return { ...res.data, name: res.data.name ?? res.data.pcId };
}

export function loadConfig(path: string): AgentConfig {
  if (!existsSync(path)) {
    throw new ConfigError(
      `config file not found: ${path}\n  Copy agent.example.yaml there (or pass --config <file>).`,
    );
  }
  return parseConfig(readFileSync(path, "utf8"), path);
}

/** Where the platform default config lives. */
export function defaultConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    return join(env.ProgramData ?? env.PROGRAMDATA ?? "C:\\ProgramData", "HomePanel", "agent.yaml");
  }
  const xdg = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config");
  return join(xdg, "homepanel", "agent.yaml");
}

/**
 * Config resolution order:
 *   1. --config <file>
 *   2. HOMEPANEL_AGENT_CONFIG env var
 *   3. agent.yaml next to the agent program (portable installs)
 *   4. platform default (%ProgramData%\HomePanel\agent.yaml, ~/.config/homepanel/agent.yaml)
 */
export function resolveConfigPath(
  explicit: string | undefined,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; programDir?: string; exists?: (p: string) => boolean } = {},
): string {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  if (explicit) return resolve(explicit);
  if (env.HOMEPANEL_AGENT_CONFIG) return resolve(env.HOMEPANEL_AGENT_CONFIG);
  const programDir = opts.programDir ?? (process.argv[1] ? dirname(resolve(process.argv[1])) : undefined);
  if (programDir) {
    const local = join(programDir, "agent.yaml");
    if (exists(local)) return local;
  }
  return defaultConfigPath(opts.platform ?? process.platform, env);
}

export const suggestedPcId = () => slugify(hostname()).replace(/_/g, "-").slice(0, 48) || "my-pc";

/** Label shown on buttons when the config doesn't give one. */
export function defaultLabel(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}
