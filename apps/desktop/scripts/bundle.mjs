// pnpm build → dist/homepanel.cjs: server + agent + installer + AI in ONE CommonJS file (Node SEA
// needs CJS), plus dist/assets.json / dist/__manifest.json describing the files embedded by
// build-sea.mjs. Run it with plain node too: `node dist/homepanel.cjs server --demo`.
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectAssets, hashAssets, REPO } from "./assets.mjs";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const agentPkg = JSON.parse(readFileSync(join(REPO, "apps/agent/package.json"), "utf8"));
const out = join(dist, "homepanel.cjs");

const installerMain = join(REPO, "apps/installer/src/main.ts");
const installerCli = join(REPO, "apps/installer/src/cli.ts");
const hasInstallerMain = existsSync(installerMain);

/** @homepanel/installer/main → apps/installer/src/main.ts (or empty); /cli only as the fallback. */
const installerPlugin = {
  name: "homepanel-installer",
  setup(b) {
    b.onResolve({ filter: /^@homepanel\/installer\/(main|cli)$/ }, (args) => {
      const which = args.path.endsWith("/main") ? "main" : "cli";
      if (which === "main") return hasInstallerMain ? { path: installerMain } : { path: "main", namespace: "hp-empty" };
      return hasInstallerMain ? { path: "cli", namespace: "hp-empty" } : { path: installerCli };
    });
    b.onLoad({ filter: /.*/, namespace: "hp-empty" }, () => ({ contents: "export {};", loader: "js" }));
  },
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await build({
  entryPoints: [join(root, "src", "entry.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: false, // readable stack traces in bug reports
  keepNames: true,
  legalComments: "none",
  // prefer the Node (CJS-friendly) entry of dual packages
  mainFields: ["main", "module"],
  conditions: ["node", "require", "default"],
  define: {
    "import.meta.url": "globalThis.__HOMEPANEL_META_URL__",
    __HOMEPANEL_VERSION__: JSON.stringify(pkg.version),
    __AGENT_VERSION__: JSON.stringify(agentPkg.version),
  },
  // optional native speedups of `ws`; ws works without them (it try/catches the require)
  external: ["bufferutil", "utf-8-validate"],
  plugins: [installerPlugin],
  metafile: true,
  logLevel: "warning",
});
writeFileSync(join(dist, "meta.json"), JSON.stringify(result.metafile));

const assets = collectAssets();
const hash = hashAssets(assets, readFileSync(out, "utf8"));
writeFileSync(join(dist, "assets.json"), JSON.stringify(assets, null, 2));
writeFileSync(join(dist, "__manifest.json"), JSON.stringify({ version: pkg.version, hash, files: assets.map((a) => a.key) }));

console.log(
  `bundled ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB), ${assets.length} asset files, build ${hash}` +
    (hasInstallerMain ? "" : " [installer: legacy cli fallback]"),
);
