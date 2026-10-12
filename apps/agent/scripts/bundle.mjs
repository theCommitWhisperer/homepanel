// pnpm build → dist/homepanel-agent.mjs: the whole agent (mqtt, yaml, zod, protocol inlined) in
// ONE ES module that runs with plain `node` 22+. Also assembles dist/windows/, the folder
// install.ps1 copies to %ProgramFiles%\HomePanel\agent:
//
//   dist/windows/homepanel-agent.mjs   install.ps1   uninstall.ps1   scripts/*.ps1   README.md
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dist = join(root, "dist");
const out = join(dist, "homepanel-agent.mjs");
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [join(root, "src", "cli.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: false, // readable stack traces in bug reports
  legalComments: "none",
  define: { __AGENT_VERSION__: JSON.stringify(pkg.version) },
  // some CJS deps call require(): give the ESM bundle one
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __hpCreateRequire } from 'node:module'; const require = __hpCreateRequire(import.meta.url);",
  },
  // optional native speedups of `ws` (only for ws:// brokers) — fine without; no native modules
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "warning",
});

const win = join(dist, "windows");
mkdirSync(join(win, "scripts"), { recursive: true });
cpSync(out, join(win, "homepanel-agent.mjs"));
for (const f of ["install.ps1", "uninstall.ps1"]) cpSync(join(root, "scripts", f), join(win, f));
for (const f of ["audio-switch.ps1", "mic-mute.ps1"]) cpSync(join(root, "scripts", f), join(win, "scripts", f));
cpSync(join(root, "README.md"), join(win, "README.md"));
cpSync(join(root, "agent.example.yaml"), join(win, "agent.example.yaml"));

console.log(`bundled ${out} (${(statSync(out).size / 1024).toFixed(0)} KB); Windows folder: ${win}`);
