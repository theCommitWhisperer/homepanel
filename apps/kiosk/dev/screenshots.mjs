// Screenshots of the kiosk against the mock server. Expects:
//   node dev/mock-server.mjs  (port 8080)  and  vite preview (port 4173)
// Usage: BASE=http://localhost:4173 node dev/screenshots.mjs [only-name]
import fs from "node:fs";
import { launch } from "./browser.mjs";

const BASE = process.env.BASE || "http://localhost:4173";
const OUT = new URL("../screenshots/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[2];

const shots = [
  { name: "desk-monitor-1920x1080", token: "demo", vp: [1920, 1080], wait: 9000 },
  { name: "ipad-landscape-1180x820", token: "ipad", vp: [1180, 820], wait: 5000 },
  { name: "fire-hd8-portrait-800x1280", token: "fire", vp: [800, 1280], wait: 5000 },
  { name: "desk-monitor-light-1920x1080", token: "demo", vp: [1920, 1080], wait: 4000, light: true },
  { name: "pc-offline-1180x820", token: "demo", vp: [1180, 820], wait: 3000, offline: true },
  { name: "pairing-1180x820", token: null, vp: [1180, 820], wait: 2500 },
  { name: "takeover-1920x1080", token: "demo", vp: [1920, 1080], wait: 3000, ring: true },
  { name: "takeover-fire-800x1280", token: "fire", vp: [800, 1280], wait: 3000, ring: true },
  { name: "light-sheet-1180x820", token: "ipad", vp: [1180, 820], wait: 3000, longpress: true },
  { name: "confirm-sheet-1920x1080", token: "demo", vp: [1920, 1080], wait: 3000, confirm: true },
  { name: "admin-pairing-1440x900", admin: "pairing", vp: [1440, 900] },
  { name: "admin-profiles-1440x900", admin: "profiles", vp: [1440, 900] },
  { name: "admin-computers-1180x820", admin: "computers", vp: [1180, 820], addComputer: true },
  { name: "admin-assistant-1440x900", admin: "assistant", vp: [1440, 900], chat: true },
  { name: "admin-assistant-noprovider-1180x820", admin: "assistant", vp: [1180, 820], chat: "no provider please" },
];

const b = await launch();
const errors = [];
for (const s of shots) {
  if (only && !s.name.includes(only)) continue;
  const ctx = await b.newContext({ viewport: { width: s.vp[0], height: s.vp[1] }, deviceScaleFactor: 1, hasTouch: true, colorScheme: s.light ? "light" : "dark" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${s.name}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${s.name} console: ${m.text()}`));
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
    else { await page.goto(BASE + "/"); await page.evaluate(() => localStorage.clear()); await page.goto(BASE + "/"); }
    if (s.light) await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.waitForTimeout(s.wait);
    if (s.light) { await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light")); await page.waitForTimeout(800); }
    if (s.offline) { await page.evaluate(() => fetch("/mock/offline")); await page.waitForTimeout(1500); }
    if (s.ring) { await page.evaluate(() => fetch("/mock/ring", { method: "POST" })); await page.waitForTimeout(1500); }
    if (s.longpress) {
      const el = await page.$(".light >> nth=0");
      const box = await el.boundingBox();
      await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
      await page.waitForTimeout(500);
    }
    if (s.confirm) { await page.click(".act:has-text('Sleep')"); await page.waitForTimeout(600); }
  }
  // overflow check: any element whose content is clipped horizontally inside tiles
  const overflow = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".tile *").forEach((el) => {
      const cs = getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth + 2 && cs.overflow !== "visible" && cs.textOverflow !== "ellipsis" && el.clientWidth > 0 && !el.matches("svg, svg *, img, video"))
        out.push(el.className + " " + el.scrollWidth + ">" + el.clientWidth);
    });
    const page = document.documentElement.scrollHeight > innerHeight + 1 && !document.documentElement.classList.contains("admin-mode");
    return { clipped: out.slice(0, 8), pageScroll: page };
  });
  if (overflow.clipped.length || overflow.pageScroll) errors.push(`${s.name} layout: ${JSON.stringify(overflow)}`);
  await page.screenshot({ path: OUT + s.name + ".png", timeout: 90000 });
  console.log("saved", s.name);
  if (s.offline) await page.evaluate(() => fetch("/mock/offline"));
  await ctx.close();
}
await b.close();
if (errors.length) console.log("ISSUES:\n" + errors.join("\n"));
