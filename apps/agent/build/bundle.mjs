// Bundles the agent into ONE CommonJS file (dist/agent.cjs) that runs with a plain `node`
// (22+), and assembles dist/release/ — the folder that goes into the Windows/Linux zip:
//
//   dist/release/
//     agent.cjs                 the whole agent, no node_modules needed
//     agent.example.yaml
//     install-windows.ps1 / uninstall-windows.ps1
//     homepanel-agent.service   systemd --user unit (Linux)
//     scripts/*.ps1             example user scripts
//     README.md
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "dist", "agent.cjs");

await build({
  entryPoints: [join(root, "src", "cli.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: false, // keep stack traces readable for bug reports
  sourcemap: false,
  legalComments: "none",
  define: { __AGENT_VERSION__: JSON.stringify(pkg.version) },
  // optional native speedups of the `ws` package (only used for ws:// brokers) — fine without
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "warning",
});

const release = join(root, "dist", "release");
rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });
cpSync(out, join(release, "agent.cjs"));
cpSync(join(root, "agent.example.yaml"), join(release, "agent.example.yaml"));
cpSync(join(root, "install", "install-windows.ps1"), join(release, "install-windows.ps1"));
cpSync(join(root, "install", "uninstall-windows.ps1"), join(release, "uninstall-windows.ps1"));
cpSync(join(root, "install", "homepanel-agent.service"), join(release, "homepanel-agent.service"));
cpSync(join(root, "install", "install-linux.sh"), join(release, "install-linux.sh"));
cpSync(join(root, "scripts"), join(release, "scripts"), { recursive: true });
cpSync(join(root, "README.md"), join(release, "README.md"));

const kb = (statSync(out).size / 1024).toFixed(0);
console.log(`bundled ${out} (${kb} KB), release folder: ${release}`);
