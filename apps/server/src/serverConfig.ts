import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ServerConfigFileSchema, type ServerConfigFile } from "@homepanel/protocol";
import { writeFileAtomic } from "./util.js";

export type ConfigResult = { ok: true; config: ServerConfigFile } | { ok: false; errors: string[] };

export function parseServerConfig(text: string): ConfigResult {
  let doc: unknown;
  try {
    const d = YAML.parseDocument(text);
    if (d.errors.length) return { ok: false, errors: d.errors.map((e) => e.message) };
    doc = d.toJS() ?? {};
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  const r = ServerConfigFileSchema.safeParse(doc);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  return { ok: true, config: r.data };
}

const REDACTED = "***";

/** Deep-copy with secrets replaced. */
export function redactConfig(c: ServerConfigFile): ServerConfigFile {
  const copy: ServerConfigFile = JSON.parse(JSON.stringify(c));
  if (copy.assistant.apiKey) copy.assistant.apiKey = REDACTED;
  for (const k of Object.keys(copy.fully_kiosk)) copy.fully_kiosk[k]!.password = REDACTED;
  return copy;
}

/** DATA_DIR/config.yaml. Emits "changed". */
export class ServerConfigStore extends EventEmitter {
  readonly file: string;
  config: ServerConfigFile;
  text: string;

  constructor(dataDir: string, log?: { warn: (o: object, m: string) => void }) {
    super();
    this.file = path.join(dataDir, "config.yaml");
    this.text = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
    const r = parseServerConfig(this.text);
    if (r.ok) this.config = r.config;
    else {
      log?.warn({ errors: r.errors }, "config.yaml invalid; using defaults");
      this.config = ServerConfigFileSchema.parse({});
    }
  }

  /**
   * Replace config.yaml. Redacted secrets ("***") in the new text keep their previous values,
   * so the admin UI can round-trip the redacted config.
   */
  put(text: string): ConfigResult {
    const r = parseServerConfig(text);
    if (!r.ok) return r;
    const next = r.config;
    let finalText = text;
    let restored = false;
    if (next.assistant.apiKey === REDACTED) {
      next.assistant.apiKey = this.config.assistant.apiKey;
      restored = true;
    }
    for (const [k, v] of Object.entries(next.fully_kiosk)) {
      if (v.password === REDACTED) {
        v.password = this.config.fully_kiosk[k]?.password ?? "";
        restored = true;
      }
    }
    if (restored) {
      const doc = YAML.parseDocument(text);
      if (next.assistant.apiKey !== undefined && doc.hasIn(["assistant", "apiKey"])) doc.setIn(["assistant", "apiKey"], next.assistant.apiKey);
      for (const [k, v] of Object.entries(next.fully_kiosk)) {
        if (doc.hasIn(["fully_kiosk", k, "password"])) doc.setIn(["fully_kiosk", k, "password"], v.password);
      }
      finalText = doc.toString();
    }
    writeFileAtomic(this.file, finalText, 0o600);
    this.text = finalText;
    this.config = next;
    this.emit("changed", next);
    return { ok: true, config: next };
  }

  /** Programmatic edit that keeps comments (used by the assistant's add_doorbell). */
  update(mutator: (doc: YAML.Document) => void): ConfigResult {
    const doc = YAML.parseDocument(this.text || "{}\n");
    mutator(doc);
    return this.put(doc.toString());
  }
}
