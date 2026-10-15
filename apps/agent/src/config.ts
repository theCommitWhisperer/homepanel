import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { keyComboError } from "./actions/keys.js";
import { slugify } from "./util.js";

/* ------------------------------------------------------------------ */
/* Action definitions (agent.yaml -> actions: { <id>: {...} })          */
/* ------------------------------------------------------------------ */
export const SYSTEM_COMMANDS = ["lock", "sleep", "restart", "shutdown", "monitors-off"] as const;
export type SystemCommand = (typeof SYSTEM_COMMANDS)[number];

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

const ActionDefSchema = z.discriminatedUnion("type", [
  /** open a folder or file in Explorer */
  z.object({ ...base, type: z.literal("open"), path: z.string().min(1) }).strict(),
  /**
   * start a program. `exe` is a full path (may contain * wildcards: the newest match wins, handy
   * for versioned folders), a program name Windows can find (PATH / App Paths), or a protocol
   * URL such as steam://open/main.
   */
  z.object({ ...base, type: z.literal("launch"), exe: noQuote("exe"), args: z.array(noQuote("argument")).default([]) }).strict(),
  /** press keys: a media key name (media_play_pause, volume_up...) or a combo like ctrl+shift+m */
  z
    .object({
      ...base,
      type: z.literal("keys"),
      keys: z.string().superRefine((v, ctx) => {
        const err = keyComboError(v);
        if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
      }),
    })
    .strict(),
  /** run a PowerShell (.ps1), batch (.cmd/.bat) or shell script listed here */
  z
    .object({
      ...base,
      type: z.literal("script"),
      script: z.string().min(1),
      args: z.array(z.string()).default([]),
      timeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
    })
    .strict(),
  /** open a web page or app link in the default handler */
  z
    .object({
      ...base,
      type: z.literal("url"),
      url: z
        .string()
        .regex(/^[a-z][a-z0-9+.-]*:\S+$/i, "must be a URL like https://... or steam://...")
        .refine((u) => !/^(file|javascript|vbscript|data):/i.test(u), "file:, javascript: and data: URLs are not allowed"),
    })
    .strict(),
  z.object({ ...base, type: z.literal("system"), command: z.enum(SYSTEM_COMMANDS) }).strict(),
]);
export { ActionDefSchema };
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
        /**
         * Other host names/IPs for the same broker, tried in turn when the one in `url` doesn't answer
         * (e.g. the IP changed). Same port and protocol as `url`. Set [] to disable.
         */
        fallbackHosts: z
          .array(z.string().regex(/^[A-Za-z0-9.\-:[\]]+$/, "must be a host name or IP"))
          .default(["homeassistant.local"]),
      })
      .strict(),
    /** shared secret from the server's admin "Add computer" dialog */
    key: z.string().min(16, "key looks too short — copy it from the HomePanel admin page"),
    /** auto = LibreHardwareMonitor on Windows, hwmon on Linux; builtin = only CPU/RAM load from the OS */
    sensorSource: z.enum(["auto", "lhm", "hwmon", "builtin"]).default("auto"),
    lhmUrl: z.string().url().default("http://localhost:8085/data.json"),
    /** only if you enabled authentication in LHM's web server */
    lhmAuth: z.object({ username: z.string(), password: z.string() }).strict().optional(),
    publishIntervalMs: z.number().int().min(500).max(600_000).default(2000),
    drivesIntervalMs: z.number().int().min(5000).max(3_600_000).default(60_000),
    /** "auto" = everything except voltages/misc and network adapters; or a list of ids / globs */
    sensors: z.union([z.literal("auto"), z.array(z.string().min(1)).min(1)]).default("auto"),
    /** publish Home Assistant MQTT discovery configs so sensors appear as HA entities */
    haDiscovery: z.boolean().default(true),
    /** which published sensors get HA entities: "default" = temperatures, loads, fans, power; or ids / globs */
    haSensors: z.union([z.literal("default"), z.array(z.string().min(1))]).default("default"),
    /** log actions instead of running them. Default: false on Windows, true elsewhere. */
    dryRun: z.boolean().optional(),
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
      `config file not found: ${path}\n  Create one with \`homepanel-agent init\` (or pass --config <file>).`,
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
