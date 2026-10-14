// Builds the Home Assistant app (deploy/ha-app/homepanel) the way the Supervisor does — `docker build`
// of that folder, which fetches and builds HomePanel from git — then starts the container without a
// Supervisor and checks /api/health, the kiosk page and the agent bootstrap.
// On failure it prints `::error::` annotations with the tail of the output, so the cause is readable
// from the run summary without downloading logs.
//
//   BASE=<image|default> GIT=<repo url> REF=<sha> node .github/scripts/ha-app-check.mjs
import { spawn, spawnSync } from "node:child_process";

const base = process.env.BASE && process.env.BASE !== "default" ? process.env.BASE : undefined;
const tag = `homepanel-ha-app:ci-${process.pid}`;
const name = `hp-ha-app-${process.pid}`;
const label = base ? base.split("/").pop() : "Dockerfile default base";

const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
function annotate(title, text) {
  const tail = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).filter(Boolean).slice(-80).join("\n").slice(-30000);
  const chunks = tail.match(/[\s\S]{1,6000}/g) ?? [""];
  chunks.slice(-4).forEach((c, i) => console.log(`::error title=${title} (${label}) ${i + 1}::${esc(c)}`));
}

function run(cmd, args) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(cmd, args, { env: { ...process.env, DOCKER_BUILDKIT: "1", BUILDKIT_PROGRESS: "plain" } });
    for (const s of [p.stdout, p.stderr]) s.on("data", (d) => ((out += d), process.stdout.write(d)));
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: String(e) };
  }
}

const args = ["build", "--progress=plain", "-t", tag];
if (base) args.push("--build-arg", `BUILD_FROM=${base}`);
if (process.env.GIT) args.push("--build-arg", `HOMEPANEL_GIT=${process.env.GIT}`);
if (process.env.REF) args.push("--build-arg", `HOMEPANEL_REF=${process.env.REF}`);
args.push("deploy/ha-app/homepanel");
console.log(`docker ${args.join(" ")}`);
const b = await run("docker", args);
if (b.code !== 0) {
  annotate("HA app docker build failed", b.out);
  process.exit(1);
}

let failure;
const r = await run("docker", ["run", "-d", "--name", name, "-p", "18080:8080", "-e", "ADMIN_PASSWORD=ci-admin", tag]);
if (r.code !== 0) failure = `docker run failed:\n${r.out}`;
else {
  let health;
  for (let i = 0; i < 90 && !health; i++) {
    await sleep(1000);
    const h = await get("http://127.0.0.1:18080/api/health");
    if (h.status === 200) health = h.text;
    const st = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], { encoding: "utf8" }).stdout.trim();
    if (st === "false") break;
  }
  if (!health) failure = "the container did not answer /api/health within 90 s";
  else {
    console.log(`health: ${health}`);
    const k = await get("http://127.0.0.1:18080/");
    const a = await get("http://127.0.0.1:18080/agent/install.ps1");
    const l = await get("http://127.0.0.1:18080/api/admin/login");
    if (!/<title>HomePanel/.test(k.text)) failure = `kiosk page not served (HTTP ${k.status})`;
    else if (a.status !== 200) failure = `agent bootstrap /agent/install.ps1: HTTP ${a.status} ${a.text.slice(0, 200)}`;
    else if (l.status === 0) failure = "admin API not answering";
    else console.log("HA app smoke test OK: health, kiosk, agent bootstrap");
  }
}
const logs = spawnSync("docker", ["logs", "--tail", "120", name], { encoding: "utf8" });
const logText = `${logs.stdout ?? ""}${logs.stderr ?? ""}`;
console.log(logText);
spawnSync("docker", ["rm", "-f", name]);
if (failure) {
  annotate("HA app container check failed", `${failure}\n--- container log ---\n${logText}`);
  process.exit(1);
}
