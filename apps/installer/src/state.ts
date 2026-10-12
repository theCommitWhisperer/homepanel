import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HostType = "x86-bare-metal" | "raspberry-pi" | "ha-green" | "linux-docker" | "nas-proxmox" | "vm-windows";

export type StepStatus = "done" | "skipped" | "failed" | "manual";

export interface SetupState {
  version: 1;
  hostType?: HostType;
  /** e.g. http://192.168.1.20:8123 */
  haUrl?: string;
  /** true = HA OS / Supervised (apps available); false = HA Container */
  haOs?: boolean;
  /** HA host name or IP used to build other URLs */
  host?: string;
  /** where the HomePanel server lives, e.g. http://192.168.1.20:8080 */
  serverUrl?: string;
  dockerDir?: string;
  owner?: { name: string; username: string };
  location?: { country?: string; time_zone?: string; unit_system?: string; city?: string };
  mqtt?: { host: string; port: number; username: string };
  agents?: { pcId: string; name: string }[];
  doorbells?: string[];
  /** AI guide provider choice (key lives in secrets.extra.ai_api_key) */
  ai?: { provider: string; model?: string; baseUrl?: string };
  steps: Record<string, { status: StepStatus; at: string; note?: string }>;
}

/** Secrets live in their own 0600 file, never in setup-state.json. */
export interface SecretsFile {
  haToken?: string;
  /** short-lived onboarding access token (only while onboarding) */
  haAccessToken?: string;
  mqttPassword?: string;
  adminPassword?: string;
  /** values collected with ask_secret, by label */
  extra?: Record<string, string>;
}

export function homepanelHome(): string {
  return process.env.HOMEPANEL_HOME || join(homedir(), ".homepanel");
}

function writeAtomic(path: string, data: string, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, mode ? { mode } : undefined);
  renameSync(tmp, path);
  if (mode) {
    try {
      chmodSync(path, mode);
    } catch {
      /* windows */
    }
  }
}

export class StateStore {
  state: SetupState;
  secrets: SecretsFile;
  readonly statePath: string;
  readonly secretsPath: string;

  constructor(dir = homepanelHome()) {
    this.statePath = join(dir, "setup-state.json");
    this.secretsPath = join(dir, "secrets.json");
    this.state = readJson<SetupState>(this.statePath) ?? { version: 1, steps: {} };
    if (!this.state.steps) this.state.steps = {};
    this.secrets = readJson<SecretsFile>(this.secretsPath) ?? {};
  }

  update(patch: Partial<SetupState>) {
    Object.assign(this.state, patch);
    this.save();
  }

  mark(step: string, status: StepStatus, note?: string) {
    this.state.steps[step] = { status, at: new Date().toISOString(), ...(note ? { note } : {}) };
    this.save();
  }

  isDone(step: string) {
    const s = this.state.steps[step]?.status;
    return s === "done" || s === "skipped";
  }

  setSecret<K extends keyof Omit<SecretsFile, "extra">>(key: K, value: SecretsFile[K]) {
    this.secrets[key] = value;
    this.saveSecrets();
  }

  save() {
    writeAtomic(this.statePath, JSON.stringify(this.state, null, 2) + "\n");
  }
  saveSecrets() {
    writeAtomic(this.secretsPath, JSON.stringify(this.secrets, null, 2) + "\n", 0o600);
  }

  reset() {
    this.state = { version: 1, steps: {} };
    this.save();
  }
}

function readJson<T>(p: string): T | undefined {
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Registry of secret values that must never reach the AI model. Each value gets a placeholder
 * ($SECRET_1, …); `redact` replaces every occurrence in outgoing text.
 */
export class SecretVault {
  private byPlaceholder = new Map<string, { label: string; value: string }>();

  add(label: string, value: string): string {
    for (const [ph, v] of this.byPlaceholder) if (v.value === value) return ph;
    const ph = `$SECRET_${this.byPlaceholder.size + 1}`;
    this.byPlaceholder.set(ph, { label, value });
    return ph;
  }

  /** Register every secret in a SecretsFile (so tool output containing them is redacted too). */
  addAll(s: SecretsFile) {
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === "string" && v) this.add(k, v);
      else if (k === "extra" && v) for (const [l, x] of Object.entries(v as Record<string, string>)) if (x) this.add(l, x);
    }
  }

  get(placeholder: string): string | undefined {
    return this.byPlaceholder.get(placeholder)?.value;
  }

  /** Resolve $SECRET_n placeholders inside a string (used when the AI passes a placeholder to a tool). */
  resolve(text: string): string {
    return text.replace(/\$SECRET_\d+/g, (m) => this.byPlaceholder.get(m)?.value ?? m);
  }

  redact = (text: string): string => {
    let out = text;
    // longest first so a secret containing another secret is fully replaced
    const entries = [...this.byPlaceholder].sort((a, b) => b[1].value.length - a[1].value.length);
    for (const [ph, { value }] of entries) {
      if (value.length < 3) continue;
      out = out.split(value).join(ph);
      // also catch JSON-escaped forms
      const esc = JSON.stringify(value).slice(1, -1);
      if (esc !== value) out = out.split(esc).join(ph);
    }
    return out;
  };

  list() {
    return [...this.byPlaceholder].map(([ph, v]) => ({ placeholder: ph, label: v.label }));
  }
}
