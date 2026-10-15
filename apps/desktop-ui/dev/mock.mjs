// Mock of the local UI server (UI-CONTRACT.md) for developing apps/desktop-ui without Windows.
//   pnpm --filter @homepanel/desktop-ui build && pnpm --filter @homepanel/desktop-ui mock
//   open http://127.0.0.1:8790/#k=dev
// Scripted from Kevin's real setup: HA at 192.168.1.81 (port 80, onboarded, token saved), no Mosquitto or
// HomePanel app on HA yet, this PC hosting the server + agent, LHM with 58 sensors, ZBT-1, Proxmox .251.
// MOCK_SPEED=0.2 makes everything 5× faster (screenshots).
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "dist");
const PORT = Number(process.env.PORT || 8790);
const SECRET = process.env.HP_UI_SECRET || "dev";
const SPEED = Number(process.env.MOCK_SPEED || 1);
const VERSION = "0.3.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * SPEED)));

/* ------------------------------------------------------------------ */
/* pre-checks                                                           */
/* ------------------------------------------------------------------ */
const state = {
  trayRunning: false,
  mosquittoApp: false,
  homepanelApp: false,
  items: {
    server: "running",
    agent: "running",
    sensors: "running",
    mosquitto: "running",
    tray: "stopped",
  },
};

function checks() {
  const g = (c) => ({ ...c, group: { pc: "pc", ha: "ha", homepanel: "homepanel", sensors: "sensors" }[c.id.split(".")[0]] });
  return [
    { id: "pc.windows", label: "Windows", state: "ok", detail: "Windows 11 Pro 24H2 (build 26100.6584), 64-bit", at: 250 },
    { id: "pc.admin", label: "Administrator rights", state: "ok", detail: "Running elevated, so setup can register tasks and firewall rules", at: 300 },
    { id: "pc.winget", label: "winget", state: "ok", detail: "Windows Package Manager v1.12.460", at: 900 },
    { id: "pc.network", label: "Network", state: "ok", detail: "Ethernet · 192.168.1.50 (GAMING-PC) · gateway 192.168.1.1", at: 450 },
    { id: "pc.firewall", label: "Firewall profile", state: "ok", detail: "Private: tablets can reach port 8080, PCs port 1883", at: 700 },
    { id: "pc.internet", label: "Internet", state: "ok", detail: "github.com answers in 38 ms", at: 1100 },
    { id: "pc.state", label: "Saved setup", state: "info", detail: "Host on this PC finished 12 Oct · Home Assistant setup stopped before the Mosquitto step", at: 350 },
    { id: "ha.found", label: "Home Assistant found", state: "ok", detail: "http://192.168.1.81 on port 80 (saved address; 8123 is closed)", at: 1500 },
    { id: "ha.version", label: "Version and onboarding", state: "ok", detail: "2026.10.1 · onboarded (owner kevin)", at: 1900 },
    { id: "ha.token", label: "HomePanel token", state: "ok", detail: "Saved token works (“HomePanel”, valid until 2036)", at: 2300 },
    { id: "ha.os", label: "Home Assistant OS", state: "info", detail: "HA OS 16.2 in a VM on Proxmox: apps (add-ons) are available", at: 2500 },
    state.mosquittoApp
      ? { id: "ha.mosquitto", label: "Mosquitto broker app", state: "ok", detail: "core_mosquitto 6.5.1 running · user homepanel", at: 2900 }
      : { id: "ha.mosquitto", label: "Mosquitto broker app", state: "fail", detail: "Not installed on Home Assistant (PCs talk MQTT to this PC's broker for now)", fix: { label: "Install", mode: "ha", fromStep: "mqtt" }, at: 2900 },
    { id: "ha.zbt1", label: "ZBT-1 Zigbee adapter", state: "ok", detail: "Home Assistant Connect ZBT-1 seen by ZHA (channel 15)", at: 3400 },
    { id: "ha.proxmox", label: "Proxmox host", state: "info", detail: "Proxmox VE answers at https://192.168.1.251:8006 (Home Assistant's VM host)", at: 4100 },
    state.homepanelApp
      ? { id: "homepanel.app", label: "HomePanel app on Home Assistant", state: "ok", detail: "Running · http://192.168.1.81:8080/api/health ok", at: 3100 }
      : { id: "homepanel.app", label: "HomePanel app on Home Assistant", state: "warn", detail: "Not installed yet; the dashboard runs on this PC and stops when it sleeps", fix: { label: "Install", mode: "ha", fromStep: "server" }, at: 3100 },
    { id: "homepanel.server", label: "Server on this PC", state: "ok", detail: "Task “HomePanel Server” running · http://192.168.1.50:8080 · v0.3.0", at: 1300 },
    { id: "homepanel.agent", label: "This PC's agent", state: "ok", detail: "gaming-pc registered · task running · online on the server", at: 1700 },
    state.trayRunning
      ? { id: "homepanel.tray", label: "Tray icon", state: "ok", detail: "Task “HomePanel Tray” running", at: 800 }
      : { id: "homepanel.tray", label: "Tray icon", state: "warn", detail: "Task “HomePanel Tray” is registered but not running", fix: { label: "Start", action: "tray/start" }, at: 800 },
    { id: "sensors.lhm", label: "LibreHardwareMonitor", state: "ok", detail: "Web server on :8085 answers · 58 sensors (CPU, GPU, NVMe, fans)", at: 1000 },
    { id: "sensors.pawnio", label: "PawnIO driver", state: "ok", detail: "Installed, so CPU temperatures and fans are readable", at: 600 },
  ].map(g);
}
const recommendation = () =>
  state.mosquittoApp && state.homepanelApp
    ? { mode: "move", title: "Move the server to Home Assistant", why: "The HomePanel app is running on Home Assistant. Hand this PC's layouts and agent over to it.", then: "This PC keeps its agent and buttons; the dashboard no longer depends on it being on." }
    : {
        mode: "ha",
        fromStep: "mqtt",
        title: "Finish Home Assistant setup, then move the server",
        why: "Home Assistant at 192.168.1.81 is onboarded and HomePanel has its token, but the Mosquitto and HomePanel apps aren't installed yet. Setup continues at the Mosquitto step.",
        then: "Move the server to Home Assistant, so dashboards keep working when this PC is off.",
      };

async function precheck(req, res) {
  sse(res);
  const list = checks().sort((a, b) => a.at - b.at);
  for (const c of list.slice(0, 6)) send(res, { type: "check", ...strip({ ...c, state: "running", detail: "Checking…" }) });
  let t = 0;
  for (const c of list) {
    await sleep(c.at - t);
    t = c.at;
    if (res.writableEnded) return;
    send(res, { type: "check", ...strip(c) });
  }
  await sleep(300);
  send(res, { type: "recommendation", recommendation: recommendation() });
  send(res, { type: "done" });
  res.end();
}
const strip = ({ at: _a, ...c }) => c;

/* ------------------------------------------------------------------ */
/* setup runs                                                           */
/* ------------------------------------------------------------------ */
const clients = new Set();
const live = new Set();
let run = null; // { id, mode, history, pending: Map, cancelled, ai }
let qn = 0;

function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": hello\n\n");
}
function send(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function emit(ev) {
  if (!run) return;
  // like the real server, Host/Join/Move step ids are prefixed with the mode ("host.agent")
  const pre = run.prefix;
  const fix = (id) => (pre && id && !id.includes(".") ? `${pre}.${id}` : id);
  let e = { ...ev, ts: Date.now() };
  if (pre) {
    if (e.type === "step") e.id = fix(e.id);
    if (e.stepId) e.stepId = fix(e.stepId);
    if (e.type === "steps") e.steps = e.steps.map((x) => ({ ...x, id: fix(x.id) }));
  }
  run.history.push(e);
  for (const c of clients) send(c, e);
}
class Cancelled extends Error {}

function makeCtx(r) {
  const check = () => {
    if (r.cancelled) throw new Cancelled();
  };
  const out = {
    line: (text = "") => emit({ type: "log", level: "line", text }),
    heading: (text) => emit({ type: "log", level: "heading", text }),
    info: (text) => emit({ type: "log", level: "info", text }),
    ok: (text) => emit({ type: "log", level: "ok", text }),
    warn: (text) => emit({ type: "log", level: "warn", text }),
    err: (text) => emit({ type: "log", level: "err", text }),
    code: (text) => emit({ type: "log", level: "code", text }),
    steps: (items) => emit({ type: "log", level: "steps", text: items.join("\n"), items }),
  };
  const ask = async (q) => {
    check();
    const id = `q${++qn}`;
    emit({ type: "question", id, ...q });
    for (;;) {
      const v = await new Promise((resolve, reject) => r.pending.set(id, { resolve, reject }));
      check();
      const err = q.validate?.(v);
      if (err) {
        emit({ type: "question_error", id, error: err });
        continue;
      }
      r.pending.delete(id);
      emit({ type: "answered", id });
      return v;
    }
  };
  const wait = async (ms) => {
    check();
    await sleep(ms);
    check();
  };
  const ai = (text, role = "assistant") => r.ai && emit({ type: "ai", role, text });
  return { out, ask, wait, ai, check, run: r };
}

/** detect → (show actions, ask) → run → on failure show the fix, retry/skip/stop — like runLocalSteps. */
async function runSteps(ctx, steps, { confirmAll }) {
  const { out, ask, wait } = ctx;
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    emit({ type: "step", id: s.id, state: "checking" });
    out.heading(`${i + 1}/${steps.length}  ${s.title}`);
    out.info(s.why);
    await wait(s.detectMs ?? 450);
    if (s.done) {
      out.ok(s.done);
      emit({ type: "step", id: s.id, state: "done", detail: s.done });
      results.push("done");
      continue;
    }
    out.info(s.missing);
    if (s.ai) ctx.ai(s.ai);
    out.line("  This will:");
    for (const a of s.actions) out.code(a);
    const go = confirmAll || (await ask({ kind: "confirm", message: "Do this now?", default: false, stepId: s.id }));
    if (!go) {
      out.info("Skipped. Run setup again any time to do it.");
      emit({ type: "step", id: s.id, state: "skipped", detail: "Skipped" });
      results.push("skipped");
      continue;
    }
    emit({ type: "step", id: s.id, state: "running", detail: s.runningDetail });
    let status = "failed";
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await s.run(ctx, attempt);
        status = r === "manual" ? "manual" : "done";
        if (status === "done") out.ok(`${s.title}: done.`);
        break;
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        emit({ type: "step", id: s.id, state: "failed", detail: e.message });
        out.err(e.message);
        if (e.fix?.length) {
          out.line("  How to fix:");
          out.steps(e.fix);
        }
        if (e.ai) ctx.ai(e.ai);
        const what = await ask({
          kind: "select",
          message: "What now?",
          stepId: s.id,
          choices: [
            { value: "retry", name: "Try again" },
            { value: "skip", name: "Skip this step" },
            { value: "quit", name: "Stop here (progress is saved)" },
          ],
        });
        if (what === "retry") {
          emit({ type: "step", id: s.id, state: "running", detail: "Trying again…" });
          continue;
        }
        status = what === "skip" ? "failed" : "quit";
        break;
      }
    }
    if (status === "quit") return { results, quit: true };
    emit({ type: "step", id: s.id, state: status === "quit" ? "failed" : status, detail: status === "done" ? s.doneDetail ?? "Done" : status === "manual" ? s.manualDetail : "Skipped after an error" });
    results.push(status);
  }
  return { results, quit: false };
}

function fixError(message, fix, ai) {
  const e = new Error(message);
  e.fix = fix;
  e.ai = ai;
  return e;
}

async function progress(ctx, stepId, label, ms, from = 0, to = 100) {
  const n = 12;
  for (let i = 0; i <= n; i++) {
    emit({ type: "progress", stepId, label, pct: from + ((to - from) * i) / n });
    await ctx.wait(ms / n);
  }
}

const WINGET = (id, extra = "") => `winget install --id ${id} -e --accept-source-agreements --accept-package-agreements --disable-interactivity${extra}`;

function hostSteps() {
  return [
    { id: "program", title: "Install HomePanel.exe", why: "Scheduled tasks run a fixed copy in Program Files, not the file in Downloads.", done: "Running the installed copy (C:\\Program Files\\HomePanel\\HomePanel.exe)." },
    { id: "lhm", title: "LibreHardwareMonitor", why: "Reads CPU/GPU temperatures, fans and power for the dashboard.", done: "Found C:\\Program Files\\LibreHardwareMonitor\\LibreHardwareMonitor.exe" },
    { id: "pawnio", title: "PawnIO driver", why: "The signed driver LibreHardwareMonitor uses to read CPU temperatures and fans.", done: "PawnIO 2.0.1.0 is installed." },
    { id: "lhm-config", title: "LibreHardwareMonitor settings", why: "Turns on its web server (port 8085) and keeps it quietly in the tray.", done: "Web server on port 8085, starts minimized to the tray." },
    { id: "sensors-task", title: 'Start LibreHardwareMonitor at logon ("HomePanel Sensors")', why: "So temperatures are there after every reboot, without clicking anything.", done: "Task registered; http://localhost:8085/data.json answers (58 sensors)." },
    {
      id: "mosquitto",
      title: "Mosquitto MQTT broker",
      why: "PC agents send temperatures and receive button presses through it.",
      missing: "Mosquitto is not installed.",
      actions: [WINGET("EclipseFoundation.Mosquitto", " --silent")],
      ai: "Mosquitto is the message broker your PCs talk to. winget installs the official Eclipse package as a Windows service; nothing else on the PC changes.",
      async run(ctx) {
        ctx.out.info("Found Eclipse Mosquitto [EclipseFoundation.Mosquitto] Version 2.0.22");
        await progress(ctx, "mosquitto", "Downloading mosquitto-2.0.22-install-windows-x64.exe (9.8 MB)", 2600);
        ctx.out.ok("Successfully verified installer hash");
        emit({ type: "progress", stepId: "mosquitto", label: "Starting package install…" });
        await ctx.wait(1400);
        ctx.out.ok("Successfully installed");
        ctx.out.info("Found Mosquitto in C:\\Program Files\\mosquitto");
      },
      doneDetail: "Installed 2.0.22 with winget",
    },
    {
      id: "mosquitto-config",
      title: "Mosquitto: login + config",
      why: "Only HomePanel's user may connect; listens on the LAN so other PCs can join.",
      missing: "No HomePanel config yet (anonymous access is still the default).",
      actions: [
        "Write C:\\ProgramData\\HomePanel\\mosquitto\\mosquitto.conf (listener 1883 on all interfaces, allow_anonymous false, password_file)",
        'mosquitto_passwd -b C:\\ProgramData\\HomePanel\\mosquitto\\passwd homepanel <random password>',
        "Point the mosquitto service at that config and restart it",
      ],
      async run(ctx) {
        await ctx.wait(700);
        ctx.out.ok("MQTT user homepanel created (password saved in the setup folder).");
        await ctx.wait(600);
        ctx.out.ok("mosquitto service restarted; login works on 127.0.0.1:1883.");
      },
    },
    { id: "firewall", title: "Windows Firewall", why: "Lets tablets reach the dashboard (8080) and other PCs reach MQTT (1883) — home network only.", done: "Rules “HomePanel 8080” and “HomePanel MQTT 1883” exist for the Private profile." },
    {
      id: "server-config",
      title: "HomePanel server settings",
      why: "MQTT login + admin password for the server, readable only by administrators.",
      missing: "C:\\ProgramData\\HomePanel\\server\\.env needs the new MQTT login.",
      actions: ["Write C:\\ProgramData\\HomePanel\\server\\.env (MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD, ADMIN_PASSWORD)", "icacls C:\\ProgramData\\HomePanel\\server /inheritance:r /grant:r *S-1-5-32-544:(OI)(CI)F *S-1-5-18:(OI)(CI)F"],
      async run(ctx) {
        const how = await ctx.ask({
          kind: "select",
          message: "Password for the HomePanel admin page (pairing screens, editing layouts):",
          stepId: "server-config",
          choices: [
            { value: "gen", name: "Make one up for me (shown at the end and saved in the setup folder)" },
            { value: "type", name: "I'll type my own" },
          ],
        });
        if (how === "type") {
          for (;;) {
            const pw = await ctx.ask({ kind: "password", message: "Admin password (hidden):", stepId: "server-config", validate: (v) => (String(v).length < 6 ? "At least 6 characters" : /["\\\r\n]/.test(v) ? "No quotes or backslashes, please" : null) });
            const again = await ctx.ask({ kind: "password", message: "Again:", stepId: "server-config" });
            if (again === pw) {
              run.adminPassword = pw;
              break;
            }
            ctx.out.warn("They don't match, try again.");
          }
        } else {
          run.adminPassword = "Kq7vT2-mWfz9-Lp4x";
          ctx.out.ok(`Admin password: ${run.adminPassword}   (also shown at the end)`);
        }
        await ctx.wait(500);
        ctx.out.ok("Wrote C:\\ProgramData\\HomePanel\\server\\.env (administrators only).");
      },
    },
    { id: "server", title: 'Run the server at startup ("HomePanel Server")', why: "The dashboard runs in the background, even before anyone logs in.", done: "Task running; http://localhost:8080/api/health answers (v0.3.0)." },
    { id: "agent-config", title: "Register this PC + write agent.yaml", why: "Gives this PC its signing key and the suggested buttons (open drives, Steam, media keys…).", done: "gaming-pc is registered and C:\\ProgramData\\HomePanel\\agent.yaml matches." },
    {
      id: "agent",
      title: 'Run the agent at logon ("HomePanel Agent")',
      why: "Runs as you, in your session, so buttons can open folders and programs on your screen.",
      missing: "agent.yaml changed; the agent needs a restart.",
      actions: [
        "Write C:\\ProgramData\\HomePanel\\run-agent.cmd (runs the agent, restarts it if it stops, log in C:\\ProgramData\\HomePanel\\logs)",
        'Register scheduled task "HomePanel Agent": at logon of GAMING-PC\\kevin, highest privileges, no window',
        "Start it and wait until the server shows this PC online (up to 60 s)",
      ],
      async run(ctx, attempt) {
        ctx.out.info('Waiting for "gaming-pc" to come online…');
        if (attempt === 0) {
          for (const s of [10, 20, 30, 40, 50]) {
            emit({ type: "progress", stepId: "agent", label: `Waiting for gaming-pc… still waiting (${s} s)` });
            await ctx.wait(500);
            if (s % 20 === 0) ctx.out.info(`still waiting (${s} s)…`);
          }
          throw fixError(
            '"gaming-pc" did not come online within 60 s.',
            [
              "Read the log: C:\\ProgramData\\HomePanel\\logs\\agent.log",
              'Run it by hand to see errors:  "C:\\Program Files\\HomePanel\\HomePanel.exe" agent run --config C:\\ProgramData\\HomePanel\\agent.yaml',
              "“Not authorized” = wrong MQTT password in agent.yaml; “ECONNREFUSED/timeout” = broker not reachable on port 1883.",
              "Then choose Retry.",
            ],
            "The agent log says “Connection refused: not authorized”. The broker was restarted with the new homepanel login a moment ago and agent.yaml was rewritten at the same time, so the agent may have read the old password. Retry usually fixes it.",
          );
        }
        emit({ type: "progress", stepId: "agent", label: "Waiting for gaming-pc…" });
        await ctx.wait(1300);
        ctx.out.ok('"gaming-pc" is online in HomePanel.');
      },
    },
    {
      id: "browser",
      title: "Open the dashboard on this PC",
      why: "Pairs this PC's browser with the desk-monitor layout, no code to type.",
      missing: "This browser is not paired yet.",
      actions: ["Create a screen token for “gaming-pc browser” with the desk-monitor layout", "Open http://localhost:8080/?token=… in your default browser"],
      async run(ctx) {
        await ctx.wait(600);
        ctx.out.ok("Opened the dashboard in Microsoft Edge.");
      },
    },
  ];
}

async function hostFlow(ctx) {
  const { out, ask } = ctx;
  const steps = hostSteps();
  emit({ type: "steps", steps: steps.map((s) => ({ id: s.id, title: s.title, summary: s.why })) });
  out.heading("Host HomePanel on this PC");
  out.info("Server, MQTT broker and this PC's agent, all on this PC. Tablets open http://192.168.1.50:8080.");
  out.line();
  out.line("  Steps (each one is checked first and skipped when it's already done):");
  out.steps(steps.map((s) => s.title));
  ctx.ai("Hi Kevin. This PC already hosts HomePanel, so most steps will be checked and skipped. Mosquitto looks missing, which is why the agent can't report temperatures right now.");
  const how = await ask({
    kind: "select",
    message: "How do you want to go?",
    choices: [
      { value: "ask", name: "Show me each step and ask before doing it (recommended the first time)" },
      { value: "all", name: "Do all of them — I've read the list (exact actions are still printed)" },
      { value: "quit", name: "Not now" },
    ],
  });
  if (how === "quit") return { cancelled: true };
  const res = await runSteps(ctx, steps, { confirmAll: how === "all" });
  if (res.quit) return { failed: true };
  out.heading("Summary");
  emit({
    type: "summary",
    items: [
      { label: "Dashboard on this PC", value: "http://localhost:8080", href: "http://localhost:8080" },
      { label: "Admin page", value: "http://localhost:8080/admin", href: "http://localhost:8080/admin" },
      { label: "Admin password", value: run.adminPassword ?? "Kq7vT2-mWfz9-Lp4x", secret: true },
      { label: "Tablets and phones", value: "http://192.168.1.50:8080", href: "http://192.168.1.50:8080" },
      { label: "Other PCs", value: "http://192.168.1.50:8080/download/HomePanel.exe", href: "http://192.168.1.50:8080/download/HomePanel.exe" },
      { label: "MQTT password", value: "r8Fz2QmX0pLw7cVn4TsY9eKd", secret: true },
      { label: "Secrets saved in", value: "C:\\ProgramData\\HomePanel\\setup\\secrets.json" },
    ],
  });
  ctx.ai("Done. Write down the admin password; tablets show a 6-digit code that you approve under Admin → Screens.");
  return { failed: res.results.includes("failed") };
}

function haSteps() {
  return [
    { id: "detect", title: "Find Home Assistant", why: "Looks for Home Assistant on your network (mDNS, the saved address, ports 8123 and 80).", done: "Home Assistant at http://192.168.1.81 (port 80)." },
    { id: "host", title: "Install Home Assistant", why: "Home Assistant OS on Proxmox, a mini PC, a Pi or a VM.", done: "Already running: Home Assistant OS 16.2 (VM 100 on Proxmox 192.168.1.251)." },
    { id: "onboard", title: "Create your Home Assistant account", why: "The owner account, location and units.", done: "Onboarded (owner kevin)." },
    {
      id: "token",
      title: "Create a HomePanel token in Home Assistant",
      why: "Create a long-lived access token named HomePanel (valid 10 years).",
      missing: "Saved token is rejected or HA is unreachable.",
      actions: ["Connect to Home Assistant's WebSocket API and create a long-lived access token named 'HomePanel' (10 years)"],
      async run(ctx) {
        const how = await ctx.ask({
          kind: "select",
          message: "To create the token the installer must log in to Home Assistant once. How?",
          stepId: "token",
          choices: [
            { value: "login", name: "Log in with my HA username + password (typed here, hidden)" },
            { value: "paste", name: "I'll paste a long-lived token I created in HA (Profile → Security)" },
          ],
        });
        if (how === "paste") {
          await ctx.ask({
            kind: "password",
            message: "Home Assistant long-lived token:",
            stepId: "token",
            validate: (v) => (String(v).replace(/\s+/g, "").length < 100 ? `Home Assistant at http://192.168.1.81 did not accept that token. It is ${String(v).length} characters long (HA tokens are about 180); copy it again.` : null),
          });
          ctx.out.ok("Token saved.");
        } else {
          await ctx.ask({ kind: "input", message: "HA username:", default: "kevin", stepId: "token" });
          await ctx.ask({ kind: "password", message: "Home Assistant password:", stepId: "token" });
          await ctx.wait(600);
          ctx.out.ok("Created long-lived token 'HomePanel'.");
        }
        ctx.out.info("This is Home Assistant OS — apps (add-ons) are available.");
      },
    },
    {
      id: "mqtt",
      title: "MQTT (Mosquitto)",
      why: "Installs the Mosquitto broker app and a homepanel MQTT user.",
      missing: "The Mosquitto broker app is not installed.",
      actions: ["Install the “Mosquitto broker” app (core_mosquitto) from the official store", "Create the Home Assistant user homepanel for MQTT", "Start it and turn on Start on boot + Watchdog", "Add the MQTT integration to Home Assistant"],
      ai: "Next is the Mosquitto broker app on Home Assistant. Your PC agents will later connect to 192.168.1.81:1883 instead of this PC.",
      async run(ctx) {
        ctx.out.info("Installing core_mosquitto 6.5.1 …");
        await progress(ctx, "mqtt", "Installing Mosquitto broker 6.5.1", 3000);
        ctx.out.ok("Mosquitto broker app installed and started (Start on boot, Watchdog on).");
        ctx.out.ok("MQTT user homepanel created.");
        ctx.out.ok("MQTT integration added.");
        state.mosquittoApp = true;
      },
    },
    {
      id: "server",
      title: "Install the HomePanel server",
      why: "The HomePanel app on Home Assistant: dashboards keep working when your PC is off.",
      missing: "The HomePanel app is not installed.",
      actions: ["Add the app repository https://github.com/theCommitWhisperer/homepanel", "Install the “HomePanel” app (builds locally on HA, 3–6 min on an N100)", "Set its options (MQTT login, admin password) and start it"],
      async run(ctx) {
        ctx.out.ok("Repository added.");
        for (let m = 1; m <= 3; m++) {
          emit({ type: "progress", stepId: "server", label: `Building the HomePanel app image… still preparing (${m} min)`, pct: m * 28 });
          await ctx.wait(900);
        }
        await progress(ctx, "server", "Starting HomePanel 0.3.0", 900, 84, 100);
        ctx.out.ok("HomePanel app running · http://192.168.1.81:8080/api/health ok");
        state.homepanelApp = true;
      },
    },
    { id: "env", title: "Server settings (.env)", why: "Only needed when HomePanel runs in Docker; the app uses its options.", done: "Not needed: HomePanel runs as a Home Assistant app." },
    { id: "zigbee", title: "Zigbee with the ZBT-1", why: "Use the Home Assistant Connect ZBT-1 with ZHA.", done: "ZBT-1 is set up in ZHA (channel 15)." },
    {
      id: "doorbells",
      title: "Doorbells (Reolink / Eufy)",
      why: "Ring → full-screen camera on every tablet.",
      missing: "No doorbell configured.",
      actions: ["Add the doorbell's integration to Home Assistant", "Point HomePanel's doorbell takeover at its ring sensor and camera"],
      async run(ctx) {
        const which = await ctx.ask({
          kind: "select",
          message: "Which doorbell do you have?",
          stepId: "doorbells",
          choices: [
            { value: "reolink-poe", name: "Reolink Video Doorbell (PoE)", description: "Local, instant ring events through the Reolink integration" },
            { value: "reolink-wifi", name: "Reolink Video Doorbell (Wi-Fi)", description: "Same integration; keep it on a strong 2.4 GHz signal" },
            { value: "eufy-e340", name: "Eufy Video Doorbell E340", description: "Needs the Eufy Security add-on and HACS integration" },
            { value: "eufy-dual", name: "Eufy Video Doorbell Dual", description: "Works through HomeBase 2 with the Eufy Security add-on" },
            { value: "ring", name: "Ring (through Ring-MQTT)", description: "Cloud events; the camera opens a few seconds later" },
            { value: "unifi", name: "UniFi G4 Doorbell", description: "UniFi Protect integration" },
            { value: "none", name: "None for now", description: "Set it up later from this step" },
          ],
        });
        if (which === "none") return "manual";
        await ctx.wait(800);
        ctx.out.ok("Doorbell takeover points at binary_sensor.front_door_visitor and camera.front_door.");
      },
      manualDetail: "Set up later",
    },
    { id: "remote", title: "Remote access (Tailscale)", why: "Reach HomePanel away from home without port forwarding.", missing: "Tailscale is not installed on Home Assistant.", actions: ["Install the Tailscale app on Home Assistant", "Log in with your Tailscale account"], async run(ctx) { await ctx.wait(500); return "manual"; }, manualDetail: "Log in to Tailscale on HA" },
    { id: "screens", title: "Set up screens", why: "Pair your iPad and Fire tablets.", done: "3 screens paired (kitchen iPad, desk monitor, Fire HD 8)." },
    { id: "pcs", title: "Monitor a PC (agent)", why: "Temperatures and buttons for your PCs.", done: "gaming-pc reports to this server." },
    { id: "health", title: "Health check", why: "Everything talks to everything.", done: "Home Assistant, MQTT and HomePanel answer; 1 PC online." },
  ];
}

async function haFlow(ctx, fromStep) {
  const steps = haSteps();
  emit({ type: "steps", steps: steps.map((s) => ({ id: s.id, title: s.title, summary: s.why })) });
  ctx.out.heading("Set up Home Assistant");
  if (fromStep) ctx.out.info(`Continuing at “${steps.find((s) => s.id === fromStep)?.title ?? fromStep}”. Earlier steps are checked quickly.`);
  const idx = fromStep ? Math.max(0, steps.findIndex((s) => s.id === fromStep)) : 0;
  // token is saved in Kevin's setup; a fresh start re-checks it and asks
  const list = steps.map((s, i) => (i < idx ? { ...s, detectMs: 120, done: s.done ?? "Already done." } : fromStep && s.id === "token" ? { ...s, done: "Token works." } : s));
  const res = await runSteps(ctx, list, { confirmAll: false });
  if (res.quit) return { failed: true };
  emit({
    type: "summary",
    items: [
      { label: "Dashboard", value: "http://192.168.1.81:8080", href: "http://192.168.1.81:8080" },
      { label: "Admin page", value: "http://192.168.1.81:8080/admin", href: "http://192.168.1.81:8080/admin" },
      { label: "Admin password", value: "Kq7vT2-mWfz9-Lp4x", secret: true },
      { label: "MQTT broker", value: "mqtt://192.168.1.81:1883 · user homepanel" },
      { label: "MQTT password", value: "m3Qa9-Hw2Lr-Zx81", secret: true },
      { label: "Home Assistant", value: "http://192.168.1.81", href: "http://192.168.1.81" },
      { label: "Next", value: "Move the server to Home Assistant (HomePanel → Setup)" },
    ],
  });
  return { failed: res.results.includes("failed") };
}

async function joinFlow(ctx) {
  const steps = hostSteps().filter((s) => ["program", "lhm", "pawnio", "lhm-config", "sensors-task", "agent-config", "agent"].includes(s.id)).map((s) => (s.id === "agent" ? { ...s, done: '"gaming-pc" is online in HomePanel.' } : s));
  emit({ type: "steps", steps: steps.map((s) => ({ id: s.id, title: s.title, summary: s.why })) });
  ctx.out.heading("Join this PC to my HomePanel");
  await ctx.ask({ kind: "select", message: "Which HomePanel?", choices: [{ value: "http://192.168.1.50:8080", name: "http://192.168.1.50:8080 (GAMING-PC)" }, { value: "other", name: "Another address…" }] });
  const res = await runSteps(ctx, steps, { confirmAll: true });
  emit({ type: "summary", items: [{ label: "This PC reports to", value: "http://192.168.1.50:8080", href: "http://192.168.1.50:8080/admin" }] });
  return { failed: res.quit };
}

async function moveFlow(ctx) {
  const steps = [
    { id: "register", title: "Register this PC with the new server + point agent.yaml at Home Assistant", why: "This PC's buttons and temperatures move to the HomePanel app.", done: "gaming-pc registered on http://192.168.1.81:8080." },
    { id: "restart-agent", title: 'Restart the agent ("HomePanel Agent") and wait until the new server shows it online', why: "", done: "gaming-pc is online on the new server." },
    { id: "layouts", title: "Copy your layouts and server settings to the new server", why: "", done: "3 layouts, 3 screens copied." },
    { id: "retire", title: "Retire the server on this PC", why: "", done: "HomePanel Server task disabled; Mosquitto service stopped." },
    { id: "browser", title: "Open the new dashboard on this PC", why: "", done: "Opened http://192.168.1.81:8080." },
  ];
  emit({ type: "steps", steps: steps.map((s) => ({ id: s.id, title: s.title })) });
  await runSteps(ctx, steps, { confirmAll: true });
  emit({ type: "summary", items: [{ label: "Dashboard", value: "http://192.168.1.81:8080", href: "http://192.168.1.81:8080" }] });
  return {};
}

async function startRun(mode, ai, fromStep) {
  const r = { id: `run-${Date.now().toString(36)}`, mode, history: [], pending: new Map(), cancelled: false, ai: !!ai, prefix: mode === "ha" ? "" : mode };
  run = r;
  emit({ type: "run", runId: r.id, mode, state: "running" });
  const ctx = makeCtx(r);
  (async () => {
    try {
      const flow = mode === "host" ? hostFlow : mode === "ha" ? haFlow : mode === "join" ? joinFlow : moveFlow;
      const res = await flow(ctx, fromStep);
      emit({ type: "run", runId: r.id, mode, state: res.cancelled ? "cancelled" : res.failed ? "failed" : "done" });
    } catch (e) {
      if (e instanceof Cancelled) {
        ctx.out.warn("Setup stopped. Everything done so far is kept.");
        emit({ type: "run", runId: r.id, mode, state: "cancelled" });
      } else {
        console.error(e);
        emit({ type: "log", level: "err", text: String(e?.message ?? e) });
        emit({ type: "run", runId: r.id, mode, state: "failed" });
      }
    } finally {
      r.ended = true;
    }
  })();
  return r.id;
}

const AI_REPLIES = [
  [/password|secret|token/i, "I never see passwords or tokens: the window sends them straight to the installer. If you lose the admin password, it's in C:\\ProgramData\\HomePanel\\setup\\secrets.json (administrators only)."],
  [/why|fail|error|online/i, "The agent connects to Mosquitto with the homepanel user. It failed because the broker restarted with the new login a few seconds after the agent read agent.yaml. Choose “Try again”: the agent re-reads the file on restart."],
  [/skip/i, "Skipping is safe: the step stays unfinished and the next setup run offers it again. Nothing that's already done is undone."],
  [/.*/, "Good question. This step only touches what's listed under “This will”, and every change waits for your Yes. Ask me about any line in the log."],
];

/* ------------------------------------------------------------------ */
/* control                                                              */
/* ------------------------------------------------------------------ */
const AGENT_YAML_PATH = "C:\\ProgramData\\HomePanel\\agent.yaml";
let agentYaml = readFileSync(join(here, "..", "test", "fixtures", "agent.yaml"), "utf8")
  .replace("mqtt://homeassistant.local:1883", "mqtt://192.168.1.50:1883")
  .replace("password: 'change-me'", "password: 'r8Fz2QmX0pLw7cVn4TsY9eKd'")
  .replace("key: 'paste-the-key-from-homepanel-admin'", "key: '9c1f4e7a2b8d6f3e0a5c9b7d1e4f2a6c'");
let tick = 0;

function status() {
  tick++;
  const j = (base, amp) => Math.round((base + Math.sin(tick * 1.3 + base) * amp) * 10) / 10;
  const it = state.items;
  const word = (s) => s;
  return {
    version: VERSION,
    role: "host",
    pcId: "gaming-pc",
    serverUrl: "http://192.168.1.50:8080",
    dashboardUrl: "http://localhost:8080",
    adminUrl: "http://localhost:8080/admin",
    agentOnline: it.agent === "running",
    items: [
      { id: "server", label: "Server", state: word(it.server), detail: it.server === "running" ? "Task “HomePanel Server” · :8080 · up 2 d 4 h" : "Task “HomePanel Server” is stopped", canStart: true, canStop: true, canRestart: true },
      { id: "agent", label: "PC agent", state: it.agent, detail: it.agent === "running" ? "gaming-pc · online · 19 buttons" : "Task “HomePanel Agent” is stopped", canStart: true, canStop: true, canRestart: true },
      { id: "sensors", label: "Sensors", state: it.sensors, detail: "LibreHardwareMonitor · :8085 · 58 sensors", canStart: true, canStop: true, canRestart: true },
      { id: "mosquitto", label: "Mosquitto", state: it.mosquitto, detail: "Windows service · :1883 · 2 clients", canStart: true, canStop: true, canRestart: true },
      { id: "tray", label: "Tray icon", state: state.trayRunning ? "running" : "stopped", detail: state.trayRunning ? "Task “HomePanel Tray” running" : "Registered, not running", canStart: true, canStop: true, canRestart: true },
      { id: "ha", label: "Home Assistant", state: "running", detail: "http://192.168.1.81 · 2026.10.1 · token ok" },
    ],
    sensors: {
      ok: it.sensors === "running",
      count: 58,
      top: [
        { name: "CPU Package", value: j(71.5, 3), unit: "°C" },
        { name: "CPU Core Max", value: j(91, 1.5), unit: "°C" },
        { name: "GPU Core", value: j(64, 2), unit: "°C" },
        { name: "GPU Hot Spot", value: j(82.5, 1.5), unit: "°C" },
        { name: "NVMe 0 (C:)", value: j(47, 1), unit: "°C" },
        { name: "CPU Load", value: Math.round(j(38, 9)), unit: "%" },
      ],
    },
  };
}

const LOG_SEED = {
  server: [
    "[server] HomePanel 0.3.0 listening on http://0.0.0.0:8080",
    "[ha] connected to http://192.168.1.81 (Home Assistant 2026.10.1), 412 entities",
    "[mqtt] connected to mqtt://127.0.0.1:1883 as homepanel",
    "[pairing] screen “Kitchen iPad” connected (profile ipad)",
    "[pairing] screen “Desk monitor” connected (profile desk)",
    "[pcs] gaming-pc online (19 actions, 58 sensors)",
    "[ws] 3 screens connected",
  ],
  agent: [
    "[agent] HomePanel agent 0.3.0 · pcId gaming-pc · config C:\\ProgramData\\HomePanel\\agent.yaml",
    "[agent] sensors: LibreHardwareMonitor http://localhost:8085/data.json (58 sensors)",
    "[mqtt] connecting to mqtt://192.168.1.50:1883 as homepanel",
    "[mqtt] connected; subscribed to homepanel/pc/gaming-pc/cmd",
    "[ha] published discovery for 31 entities",
    "[action] open-drive-d → explorer.exe \"D:\\\" (from Desk monitor)",
    "[action] media-playpause → media_play_pause (from Kitchen iPad)",
    "WARN [drives] E: is not ready (removable drive without media)",
  ],
  sensors: ["LibreHardwareMonitor 0.9.4 started minimized", "Remote web server listening on http://+:8085/", "PawnIO driver loaded"],
  mosquitto: [
    "1760440000: mosquitto version 2.0.22 starting",
    "1760440000: Config loaded from C:\\ProgramData\\HomePanel\\mosquitto\\mosquitto.conf.",
    "1760440000: Opening ipv4 listen socket on port 1883.",
    "1760440002: New client connected from 127.0.0.1:52144 as homepanel-server (p2, c1, k60, u'homepanel').",
    "1760440011: New client connected from 127.0.0.1:52190 as homepanel-gaming-pc (p2, c1, k30, u'homepanel').",
  ],
  tray: ["[tray] UI server on 127.0.0.1:49833", "[tray] notify icon ready"],
};
const logs = Object.fromEntries(Object.entries(LOG_SEED).map(([k, v]) => [k, v.map((l, i) => `2026-10-14 19:${String(20 + i).padStart(2, "0")}:0${i % 10} ${l}`)]));

function validateAgentYaml(text) {
  const doc = parseDocument(text);
  if (doc.errors.length) return [`(root): invalid YAML: ${doc.errors[0].message.split("\n")[0]}`];
  const cfg = doc.toJSON() ?? {};
  const errs = [];
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(cfg.pcId ?? "")) errs.push("pcId: use lowercase letters, digits and dashes (e.g. gaming-pc)");
  for (const [id, a] of Object.entries(cfg.actions ?? {})) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) errs.push(`actions.${id}: action ids: lowercase letters, digits, - and _ (max 64)`);
    const need = { open: "path", launch: "exe", keys: "keys", script: "script", url: "url", system: "command" }[a?.type];
    if (!need) errs.push(`actions.${id}.type: Invalid discriminator value. Expected 'open' | 'launch' | 'keys' | 'script' | 'url' | 'system'`);
    else if (!a[need]) errs.push(`actions.${id}.${need}: Required`);
    if (a?.type === "url" && a.url && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(a.url)) errs.push(`actions.${id}.url: must be a URL like https://... or steam://...`);
  }
  return errs;
}

function describe(a, id) {
  switch (a.type) {
    case "open": return `Dry run: would open ${a.path} in Explorer.`;
    case "launch": return `Dry run: would start ${a.exe}${a.args?.length ? " " + a.args.join(" ") : ""}.`;
    case "keys": return `Dry run: would press ${a.keys}.`;
    case "script": return `Dry run: would run ${a.script} (timeout ${(a.timeoutMs ?? 30000) / 1000} s).`;
    case "url": return `Dry run: would open ${a.url}.`;
    case "system": return `Dry run: would ${a.command} this PC${a.guard ? ` (guard: ${a.guard})` : ""}.`;
    default: return `Unknown action ${id}`;
  }
}

/* ------------------------------------------------------------------ */
/* http                                                                 */
/* ------------------------------------------------------------------ */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

function authed(req) {
  if (req.headers["x-hp-ui"] === SECRET) return true;
  const c = req.headers.cookie ?? "";
  return c.split(";").some((p) => p.trim() === `hpui=${SECRET}`);
}
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
async function body(req) {
  let s = "";
  for await (const c of req) s += c;
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  if (!p.startsWith("/api/")) {
    const file = normalize(join(DIST, p === "/" ? "index.html" : p));
    const f = file.startsWith(DIST) && existsSync(file) && statSync(file).isFile() ? file : join(DIST, "index.html");
    if (!existsSync(f)) {
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end("Build the UI first: pnpm --filter @homepanel/desktop-ui build");
    }
    res.writeHead(200, { "content-type": MIME[extname(f)] ?? "application/octet-stream", "cache-control": "no-store" });
    return res.end(readFileSync(f));
  }
  if (!authed(req)) return json(res, 401, { error: "unauthorized" });
  const m = req.method;
  try {
    // setup
    if (p === "/api/setup/precheck" && m === "GET") return void (await precheck(req, res));
    if (p === "/api/setup/modes" && m === "GET")
      return json(res, 200, {
        installed: true,
        version: VERSION,
        modes: [
          { id: "host", title: "Host on this PC", summary: "Server, MQTT broker and this PC's agent, all on this PC.", available: true, why: "Done 12 Oct · server and agent are running" },
          { id: "join", title: "Join this PC to my HomePanel", summary: "Temperatures and buttons for this PC, reporting to a server elsewhere.", available: false, why: "This PC is the server. Move it to Home Assistant first." },
          { id: "ha", title: "Set up Home Assistant", summary: "Token, Mosquitto app, HomePanel app, Zigbee, doorbells, screens.", recommended: !state.homepanelApp, available: true, why: "Mosquitto and HomePanel apps are missing" },
          { id: "move", title: "Move the server to Home Assistant", summary: "Hand this PC's server, layouts and agent over to the HomePanel app on HA.", recommended: state.homepanelApp, available: state.homepanelApp, why: state.homepanelApp ? "The HomePanel app is ready" : "Needs the HomePanel app on Home Assistant first" },
        ],
      });
    if (p === "/api/setup/start" && m === "POST") {
      const b = await body(req);
      if (run && !run.ended) return json(res, 409, { error: "A setup is already running." });
      if (!["host", "join", "ha", "move"].includes(b.mode)) return json(res, 400, { error: "unknown mode" });
      if (b.ai && b.ai.provider !== "ollama" && !b.ai.apiKey) return json(res, 400, { error: "That provider needs an API key." });
      const runId = await startRun(b.mode, b.ai, b.fromStep);
      return json(res, 200, { runId });
    }
    if (p === "/api/setup/events" && m === "GET") {
      sse(res);
      for (const e of run?.history ?? []) send(res, e);
      clients.add(res);
      const ka = setInterval(() => res.write(": ka\n\n"), 15000);
      req.on("close", () => (clients.delete(res), clearInterval(ka)));
      return;
    }
    if (p === "/api/setup/answer" && m === "POST") {
      const b = await body(req);
      const w = run?.pending.get(b.questionId);
      if (!w) return json(res, 404, { error: "No such question (already answered?)" });
      w.resolve(b.value);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/setup/cancel" && m === "POST") {
      if (run) {
        run.cancelled = true;
        for (const w of run.pending.values()) w.resolve(undefined);
      }
      return json(res, 200, { ok: true });
    }
    if (p === "/api/setup/ai/message" && m === "POST") {
      const b = await body(req);
      if (!run?.ai) return json(res, 400, { error: "This run has no AI guide." });
      const reply = AI_REPLIES.find(([re]) => re.test(b.text ?? ""))[1];
      setTimeout(() => {
        emit({ type: "ai", role: "tool", text: "read_log(step=agent, lines=40)" });
        setTimeout(() => emit({ type: "ai", role: "assistant", text: reply }), 700 * SPEED);
      }, 600 * SPEED);
      return json(res, 200, { ok: true });
    }

    // control
    if (p === "/api/control/status" && m === "GET") return json(res, 200, status());
    const act = /^\/api\/control\/([a-z-]+)\/(start|stop|restart)$/.exec(p);
    if (act && m === "POST") {
      const [, item, verb] = act;
      await sleep(900);
      if (item === "tray") state.trayRunning = verb !== "stop";
      else if (item in state.items) state.items[item] = verb === "stop" ? "stopped" : "running";
      else return json(res, 404, { ok: false, error: `Unknown item ${item}` });
      return json(res, 200, { ok: true });
    }
    const lg = /^\/api\/control\/logs\/([a-z-]+)$/.exec(p);
    if (lg && m === "GET") {
      const k = lg[1];
      const list = logs[k] ?? [];
      if (k === "agent" || k === "server") list.push(`2026-10-14 ${new Date().toTimeString().slice(0, 8)} ${k === "agent" ? "[sensors] published 58 readings (cpu_package 71.5 °C)" : "[ws] ping 3 screens"}`);
      const n = Number(url.searchParams.get("lines") || 200);
      return json(res, 200, { lines: list.slice(-n) });
    }
    if (p === "/api/control/agent-config" && m === "GET") {
      const doc = parseDocument(agentYaml).toJSON();
      return json(res, 200, { path: AGENT_YAML_PATH, yaml: agentYaml, actions: Object.entries(doc.actions ?? {}).map(([id, a]) => ({ id, ...a })) });
    }
    if (p === "/api/control/agent-config" && m === "PUT") {
      const b = await body(req);
      const errors = validateAgentYaml(String(b.yaml ?? ""));
      if (errors.length) return json(res, 422, { ok: false, errors });
      agentYaml = b.yaml;
      await sleep(700);
      return json(res, 200, { ok: true, restarted: true });
    }
    if (p === "/api/control/test-action" && m === "POST") {
      const b = await body(req);
      const a = parseDocument(agentYaml).toJSON().actions?.[b.id];
      await sleep(400);
      if (!a) return json(res, 404, { ok: false, error: `No action “${b.id}” in agent.yaml` });
      return json(res, 200, { ok: true, describe: describe(a, b.id) });
    }
    if (p === "/api/control/open" && m === "POST") return json(res, 200, { ok: true });
    if (p === "/api/control/update-check" && m === "POST") {
      await sleep(600);
      return json(res, 200, { current: VERSION, latest: "0.3.1", url: "https://github.com/theCommitWhisperer/homepanel/releases/tag/v0.3.1" });
    }
    if (p === "/api/ui/show" && m === "POST") {
      const b = await body(req);
      for (const c of live) send(c, { type: "show", ...(b.view ? { view: b.view } : {}) });
      return json(res, 200, { ok: true, windows: live.size });
    }
    if (p === "/api/ui/info" && m === "GET") return json(res, 200, { version: VERSION, installed: true, view: process.env.MOCK_VIEW || "setup", platform: "win32", fake: "Mock data (dev/mock.mjs)" });
    if (p === "/api/ui/live" && m === "GET") {
      sse(res);
      send(res, { type: "hello", version: VERSION });
      live.add(res);
      const ka = setInterval(() => res.write(": ka\n\n"), 15000);
      req.on("close", () => (live.delete(res), clearInterval(ka)));
      return;
    }
    if (p === "/api/ui/quit" && m === "POST") return json(res, 200, { ok: true });
    // test helper: forget the run and the fixed state
    if (p === "/api/mock/reset" && m === "POST") {
      if (run) run.cancelled = true;
      run = null;
      state.mosquittoApp = false;
      state.homepanelApp = false;
      state.trayRunning = false;
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: `No mock for ${m} ${p}` });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`HomePanel UI mock on http://127.0.0.1:${PORT}/#k=${SECRET}${SPEED !== 1 ? `  (speed ×${1 / SPEED})` : ""}`);
});
