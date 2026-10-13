// Runs `pnpm -r --no-bail test`, and on failure turns the failing lines into GitHub annotations,
// so failures are readable from the run summary without downloading logs.
import { spawn } from "node:child_process";
const p = spawn("pnpm", ["-r", "--no-bail", "test"], { shell: true, env: { ...process.env, FORCE_COLOR: "0" } });
let out = "";
for (const s of [p.stdout, p.stderr]) s.on("data", (d) => { out += d; process.stdout.write(d); });
p.on("exit", (code) => {
  if (code === 0) return process.exit(0);
  const lines = out.split(/\r?\n/);
  const picked = [];
  lines.forEach((l, i) => {
    if (/FAIL|AssertionError|Error:|×|✗|expected|Received|Expected|ELIFECYCLE|Test Files .*failed/.test(l)) picked.push(lines.slice(Math.max(0, i - 1), i + 3).join(" | "));
  });
  const msg = (picked.length ? picked : lines.slice(-60)).join("\n").slice(0, 60000);
  const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  // a few annotations: GitHub keeps 10 errors per step
  const chunks = msg.match(/[\s\S]{1,6000}/g) ?? [];
  chunks.slice(0, 8).forEach((c, i) => console.log(`::error title=Test failures ${i + 1}::${esc(c)}`));
  process.exit(code ?? 1);
});
