import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ProfileSchema, type Profile } from "@homepanel/protocol";
import { writeFileAtomic } from "./store.js";

export interface ProfileEntry {
  id: string;
  name: string;
  yaml: string;
  profile: Profile;
}

export type ValidateResult = { ok: true; profile: Profile } | { ok: false; errors: string[] };

/** Parse + validate a profile YAML document. If expectedId is given, `id` defaults to / must match it. */
export function validateProfileYaml(text: string, expectedId?: string): ValidateResult {
  let doc: unknown;
  try {
    const parsed = YAML.parseDocument(text, { prettyErrors: true });
    if (parsed.errors.length) return { ok: false, errors: parsed.errors.map((e) => e.message) };
    doc = parsed.toJS();
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, errors: ["profile must be a YAML mapping"] };
  const obj = doc as Record<string, unknown>;
  if (expectedId && obj.id === undefined) obj.id = expectedId;
  const r = ProfileSchema.safeParse(obj);
  if (!r.success) {
    return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const errors: string[] = [];
  if (expectedId && r.data.id !== expectedId) errors.push(`id: must be "${expectedId}" (matches the file name)`);
  const ids = new Set<string>();
  r.data.widgets.forEach((w, i) => {
    const [c, row, wd, h] = w.at;
    if (c + wd > r.data.grid.cols || row + h > r.data.grid.rows) {
      errors.push(`widgets.${i}.at: [${w.at.join(", ")}] does not fit the ${r.data.grid.cols}x${r.data.grid.rows} grid`);
    }
    if (w.id) {
      if (ids.has(w.id)) errors.push(`widgets.${i}.id: duplicate id "${w.id}"`);
      ids.add(w.id);
    }
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, profile: r.data };
}

/**
 * Profiles in DATA_DIR/profiles/<id>.yaml. Emits "changed" (id, Profile) and "deleted" (id).
 * Watches the folder so hand edits are pushed to screens too.
 */
export class ProfileStore extends EventEmitter {
  readonly dir: string;
  private entries = new Map<string, ProfileEntry>();
  private watcher: fs.FSWatcher | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();
  readonly loadErrors = new Map<string, string[]>();

  constructor(dataDir: string, private log?: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void }) {
    super();
    this.dir = path.join(dataDir, "profiles");
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) if (/^[a-z0-9-]+\.ya?ml$/.test(f)) this.loadFile(f, false);
  }

  private loadFile(file: string, emit: boolean) {
    const id = file.replace(/\.ya?ml$/, "");
    const full = path.join(this.dir, file);
    if (!fs.existsSync(full)) {
      if (this.entries.delete(id)) emit && this.emit("deleted", id);
      return;
    }
    const text = fs.readFileSync(full, "utf8");
    if (this.entries.get(id)?.yaml === text) return;
    const r = validateProfileYaml(text, id);
    if (!r.ok) {
      this.loadErrors.set(id, r.errors);
      this.log?.warn({ profile: id, errors: r.errors }, "profile invalid; keeping previous version");
      return;
    }
    this.loadErrors.delete(id);
    this.entries.set(id, { id, name: r.profile.name, yaml: text, profile: r.profile });
    if (emit) {
      this.log?.info({ profile: id }, "profile reloaded");
      this.emit("changed", id, r.profile);
    }
  }

  watch() {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.dir, (_ev, name) => {
        if (!name || !/^[a-z0-9-]+\.ya?ml$/.test(name.toString())) return;
        const f = name.toString();
        clearTimeout(this.debounce.get(f));
        this.debounce.set(
          f,
          setTimeout(() => {
            this.debounce.delete(f);
            try {
              this.loadFile(f, true);
            } catch {
              /* file mid-write */
            }
          }, 250),
        );
      });
      this.watcher.on("error", () => undefined);
    } catch {
      /* fs.watch unsupported → PUT still reloads */
    }
  }

  close() {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.debounce.values()) clearTimeout(t);
  }

  list(): ProfileEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): Profile | undefined {
    return this.entries.get(id)?.profile;
  }

  getEntry(id: string) {
    return this.entries.get(id);
  }

  /** Fallback profile when a device points at a missing one. */
  getOrFallback(id: string): Profile {
    return (
      this.get(id) ??
      ProfileSchema.parse({
        id: "missing",
        name: "Profile not found",
        grid: { cols: 4, rows: 3 },
        widgets: [{ id: "msg", type: "text", at: [0, 0, 4, 3], text: `Profile "${id}" does not exist. Assign another one in /admin.`, size: "m" }],
      })
    );
  }

  put(id: string, text: string): ValidateResult {
    if (!/^[a-z0-9-]+$/.test(id)) return { ok: false, errors: ["id: must match ^[a-z0-9-]+$"] };
    const r = validateProfileYaml(text, id);
    if (!r.ok) return r;
    writeFileAtomic(path.join(this.dir, `${id}.yaml`), text);
    this.entries.set(id, { id, name: r.profile.name, yaml: text, profile: r.profile });
    this.loadErrors.delete(id);
    this.emit("changed", id, r.profile);
    return r;
  }

  delete(id: string): boolean {
    // the id becomes part of a file path: never let "../x" reach unlink
    if (!/^[a-z0-9-]+$/.test(id)) return false;
    let found = false;
    for (const ext of [".yaml", ".yml"]) {
      const f = path.join(this.dir, id + ext);
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        found = true;
      }
    }
    if (this.entries.delete(id)) found = true;
    if (found) this.emit("deleted", id);
    return found;
  }
}
