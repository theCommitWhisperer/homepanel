// Files HomePanel.exe carries, as { key, file }: key = path relative to the app folder (forward
// slashes, mirrors the repo layout, see src/runtime.ts), file = absolute source path.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const REPO = join(import.meta.dirname, "..", "..", "..");

/** [repo-relative path, required?] */
const SOURCES = [
  ["pnpm-workspace.yaml", true], // marker for the installer's findRepoRoot()
  ["apps/kiosk/dist", true],
  ["apps/agent/dist/windows", true],
  ["apps/server/data-example", true],
  ["docs", true],
  ["deploy", true],
  ["LICENSE", false],
];

function walk(abs, out) {
  const st = statSync(abs);
  if (st.isDirectory()) for (const n of readdirSync(abs).sort()) walk(join(abs, n), out);
  else if (st.isFile()) out.push(abs);
}

export function collectAssets() {
  const files = [];
  for (const [rel, required] of SOURCES) {
    const abs = join(REPO, rel);
    if (!existsSync(abs)) {
      if (required) throw new Error(`missing ${rel} — run \`pnpm -r build\` first`);
      continue;
    }
    walk(abs, files);
  }
  return files.map((file) => ({ key: relative(REPO, file).split(sep).join("/"), file }));
}

export function hashAssets(assets, extra = "") {
  const h = createHash("sha256").update(extra);
  for (const a of assets) h.update(a.key).update("\0").update(readFileSync(a.file)).update("\0");
  return h.digest("hex").slice(0, 16);
}
