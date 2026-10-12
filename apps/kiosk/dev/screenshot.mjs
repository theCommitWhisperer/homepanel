// Visual check: starts the mock server + `vite preview` on private ports, captures every screen into
// screenshots/, and reports layout problems (clipped text, page scroll, console errors).
//   pnpm build && pnpm screenshots            (all)
//   pnpm screenshots takeover                 (only names containing "takeover")
// Chromium: Playwright's own build, or CHROMIUM_PATH=/path/to/chrome when the download is blocked.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "screenshots");
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[2];
const MOCK_PORT = Number(process.env.MOCK_PORT || 8791);
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || 4791);
const BASE = `http://localhost:${PREVIEW_PORT}`;

if (!fs.existsSync(path.join(root, "dist/index.html"))) {
  console.error("dist/ missing: run `pnpm build` first");
  process.exit(1);
}

const procs = [];
function start(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(d));
  p.stderr.on("data", (d) => process.stderr.write(d));
  procs.push(p);
  return p;
}
const stopAll = () => procs.forEach((p) => { try { p.kill("SIGTERM"); } catch { /* ignore */ } });
process.on("exit", stopAll);
process.on("SIGINT", () => { stopAll(); process.exit(1); });

async function waitFor(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timed out waiting for " + url);
}

start(process.execPath, ["dev/mock-server.mjs"], { PORT: String(MOCK_PORT), RING_EVERY_S: "0" });
start(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--port", String(PREVIEW_PORT), "--strictPort"], {
  HOMEPANEL_SERVER: `http://localhost:${MOCK_PORT}`,
});
await waitFor(`http://localhost:${MOCK_PORT}/api/health`);
await waitFor(BASE + "/");

const shots = [
  { name: "desk-monitor-1920x1080", token: "demo", vp: [1920, 1080], wait: 9000 },
  { name: "desk-monitor-light-1920x1080", token: "demo", vp: [1920, 1080], wait: 4000, light: true },
  { name: "ipad-landscape-1180x820", token: "ipad", vp: [1180, 820], wait: 4000 },
  { name: "ipad-portrait-820x1180", token: "ipad", vp: [820, 1180], wait: 4000 },
  { name: "fire-hd8-lite-1280x800", token: "fire", vp: [1280, 800], wait: 4000 },
  { name: "phone-stacked-390x844", token: "ipad", vp: [390, 844], wait: 4000 },
  { name: "pc-offline-1180x820", token: "demo", vp: [1180, 820], wait: 3000, offline: true },
  { name: "pairing-1180x820", token: null, vp: [1180, 820], wait: 2500 },
  { name: "takeover-1920x1080", token: "demo", vp: [1920, 1080], wait: 3000, ring: true },
  { name: "takeover-fire-lite-1280x800", token: "fire", vp: [1280, 800], wait: 3000, ring: true },
  { name: "light-sheet-1180x820", token: "ipad", vp: [1180, 820], wait: 3000, longpress: true },
  { name: "confirm-sheet-1920x1080", token: "demo", vp: [1920, 1080], wait: 3000, confirm: true },
  { name: "admin-screens-1440x900", admin: "screens", vp: [1440, 900] },
  { name: "admin-profiles-1440x900", admin: "profiles", vp: [1440, 900] },
  { name: "admin-computers-1180x820", admin: "computers", vp: [1180, 820], addComputer: true },
  { name: "admin-assistant-1440x900", admin: "assistant", vp: [1440, 900], chat: true },
  { name: "admin-assistant-noprovider-1180x820", admin: "assistant", vp: [1180, 820], chat: "no provider please" },
];

const b = await launch();
const issues = [];
try {
  for (const s of shots) {
    if (only && !s.name.includes(only)) continue;
    const ctx = await b.newContext({ viewport: { width: s.vp[0], height: s.vp[1] }, deviceScaleFactor: 1, hasTouch: true, colorScheme: s.light ? "light" : "dark" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => issues.push(`${s.name}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && issues.push(`${s.name} console: ${m.text()}`));
    if (s.admin) {
      await page.goto(BASE + "/admin");
      await page.fill("input[type=password]", "demo");
      await page.click("button:has-text('Sign in')");
      await page.waitForSelector(".admin-top");
      await page.goto(BASE + "/admin#" + s.admin);
      await page.waitForTimeout(1200);
      if (s.addComputer) { await page.click("button:has-text('Add computer')"); await page.click(".sheet button:has-text('Add computer')"); await page.waitForTimeout(800); }
      if (s.chat) { await page.fill(".composer textarea", s.chat === true ? "Add my gaming PC's temperatures to the desk monitor" : s.chat); await page.click(".composer button"); await page.waitForTimeout(1200); }
    } else {
      if (s.token) await page.goto(BASE + "/?token=" + s.token);
      else { await page.addInitScript(() => { try { localStorage.clear(); } catch { /* ignore */ } }); await page.goto(BASE + "/"); }
      if (s.light) await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await page.waitForTimeout(s.wait);
      if (s.light) { await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light")); await page.waitForTimeout(500); }
      if (s.offline) { await page.evaluate(() => fetch("/mock/offline")); await page.waitForTimeout(1500); }
      if (s.ring) { await page.evaluate(() => fetch("/mock/ring", { method: "POST" })); await page.waitForTimeout(1500); }
      if (s.longpress) {
        const box = await (await page.$(".light >> nth=0")).boundingBox();
        await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
        await page.waitForTimeout(500);
      }
      if (s.confirm) { await page.click(".act:has-text('Sleep')"); await page.waitForTimeout(1500); }
    }
    const layout = await page.evaluate(() => {
      const clipped = [];
      document.querySelectorAll(".tile *").forEach((el) => {
        const cs = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 2 && cs.overflow !== "visible" && cs.textOverflow !== "ellipsis" && el.clientWidth > 0 && !el.matches("svg, svg *, img, video"))
          clipped.push(String(el.className) + " " + el.scrollWidth + ">" + el.clientWidth);
      });
      const hScroll = document.documentElement.scrollWidth > innerWidth + 1;
      return { clipped: clipped.slice(0, 8), hScroll };
    });
    if (layout.clipped.length || layout.hScroll) issues.push(`${s.name} layout: ${JSON.stringify(layout)}`);
    await page.screenshot({ path: path.join(OUT, s.name + ".png"), timeout: 90000 });
    console.log("saved", s.name);
    if (s.offline) await page.evaluate(() => fetch("/mock/offline"));
    await ctx.close();
  }
} finally {
  await b.close();
  stopAll();
}
if (issues.length) { console.log("ISSUES:\n" + issues.join("\n")); process.exitCode = 1; }
else console.log("no layout issues detected");
