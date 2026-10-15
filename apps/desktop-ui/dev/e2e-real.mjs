// End-to-end against the real window server (apps/desktop), not the mock:
//   pnpm -r build && node apps/desktop-ui/dev/e2e-real.mjs
// Starts `homepanel.cjs ui --no-open --fake`, drives the UI with Playwright through the system check,
// the recommended action, a full Host run and every Control tab, and saves screenshots/real-*.png.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const cjs = join(root, "apps", "desktop", "dist", "homepanel.cjs");
const OUT = join(here, "..", "screenshots");
mkdirSync(OUT, { recursive: true });
if (!existsSync(cjs)) throw new Error("Build first: pnpm -r build");

const srv = spawn(process.execPath, [cjs, "ui", "--no-open", "--fake"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let srvLog = "";
srv.stderr.on("data", (d) => (srvLog += d));
const url = await new Promise((res, rej) => {
  let buf = "";
  srv.stdout.on("data", (d) => {
    buf += d;
    srvLog += d;
    const m = /HomePanel window: (http:\/\/127\.0\.0\.1:\d+\/#k=\S+)/.exec(buf);
    if (m) res(m[1]);
  });
  srv.on("exit", (c) => rej(new Error(`server exited ${c}\n${srvLog}`)));
  setTimeout(() => rej(new Error("no URL from the server\n" + srvLog)), 30000);
});
const base = url.replace(/\/#k=.*/, "");
console.log("window server:", base);

const browser = await launch();
const errors = [];
const shots = [];
async function shot(page, name, settle = 400) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(settle);
  await page.screenshot({ path: join(OUT, `real-${name}.png`) });
  shots.push(name);
  console.log("  ✓ real-" + name);
}

/** Answer questions until the run ends. Policy: Yes, first choice, defaults, a fixed password; skip after 2 retries. */
async function driveRun(page, tag) {
  const seen = new Set();
  let retries = 0;
  for (let i = 0; i < 200; i++) {
    const state = await page.waitForFunction(
      () => (document.querySelector(".summary-screen") ? "summary" : document.querySelector(".question h3") ? "question" : null),
      null,
      { timeout: 120000, polling: 100 },
    );
    if ((await state.jsonValue()) === "summary") return;
    const q = page.locator(".question").first();
    const msg = (await q.locator("h3").innerText()).trim();
    const failed = await q.evaluate((el) => el.classList.contains("q-failed"));
    const kind = (await q.locator(".choices").count()) ? "buttons" : (await q.locator(".choice-list").count()) ? "list" : (await q.locator(".confirm").count()) ? "confirm" : (await q.locator('input[type="password"]').count()) ? "password" : "text";
    const key = failed ? "failed" : kind;
    if (!seen.has(key)) {
      seen.add(key);
      await shot(page, `${tag}-${key}`);
    }
    if (kind === "confirm") await page.getByRole("button", { name: /^Yes/ }).click();
    else if (kind === "buttons") {
      if (/What now/i.test(msg)) {
        retries++;
        await q.locator(".choice").nth(retries > 2 ? 1 : 0).click();
      } else {
        // never "Not now"/"Stop": prefer "Do all" style and generate-for-me answers
        const names = await q.locator(".choice-title").allInnerTexts();
        let idx = names.findIndex((n) => /^Do all/i.test(n));
        if (idx < 0) idx = 0;
        await q.locator(".choice").nth(idx).click();
      }
    } else if (kind === "list") await page.getByRole("button", { name: "Continue" }).click();
    else if (kind === "password") {
      await q.locator("input").fill("hunter2-desk");
      await page.keyboard.press("Enter");
    } else {
      const input = q.locator("input");
      if (!(await input.inputValue())) await input.fill(/address|url/i.test(msg) ? "http://127.0.0.1:8080" : "gaming-pc");
      await page.keyboard.press("Enter");
    }
    await page.waitForFunction((m) => document.querySelector(".question h3")?.textContent?.trim() !== m || !!document.querySelector(".summary-screen"), msg, { timeout: 120000, polling: 50 }).catch(() => undefined);
  }
  throw new Error("run never finished");
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));

  // installed → the server says view "control"; ?view=setup opens on the system check
  await page.goto(url.replace("/#k=", "/?view=setup#k="));
  await page.locator(".rec-card.ready").waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Check again" }).waitFor();
  await shot(page, "01-system-check");

  // recommended action
  await page.locator(".rec-go").click();
  await page.locator(".run").waitFor();
  await page.waitForTimeout(800);
  await shot(page, "02-recommended-run");
  await driveRun(page, "03-ha");
  await shot(page, "04-ha-summary");

  // full Host run from the mode picker
  await page.getByRole("button", { name: "Check again" }).click();
  await page.locator(".rec-card.ready").waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Choose something else" }).click();
  await page.locator('[data-mode="host"]').click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.locator(".run").waitFor();
  await driveRun(page, "05-host");
  await shot(page, "06-host-summary");
  await page.getByRole("button", { name: "Show steps and log" }).click();
  await shot(page, "07-host-steps");

  // Control
  await page.getByRole("button", { name: "Control", exact: true }).click();
  await page.locator(".tile").first().waitFor();
  await page.locator(".action-row, .empty-state").first().waitFor({ timeout: 20000 });
  await shot(page, "08-control");
  const row = page.locator(".action-row").first();
  await row.locator(".action-main").click();
  await page.locator(".drawer").waitFor();
  await page.locator(".drawer input").nth(1).fill("Games drive");
  await shot(page, "09-buttons-drawer");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.locator(".save-bar").waitFor();
  await page.getByRole("button", { name: "Save and restart agent" }).click();
  await page.locator(".save-bar.good, .save-bar.bad").waitFor({ timeout: 30000 });
  await shot(page, "10-buttons-saved");
  // bad YAML → inline errors from the server (422)
  await page.getByRole("tab", { name: /Edit YAML/ }).click();
  const ta = page.locator(".yaml-text");
  await ta.fill((await ta.inputValue()).replace(/^pcId: .*$/m, "pcId: Not Valid!"));
  await page.getByRole("button", { name: "Save and restart agent" }).click();
  await page.locator(".save-bar.bad").waitFor({ timeout: 30000 });
  await shot(page, "11-buttons-yaml-error");
  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("tab", { name: "Visual" }).click();

  await page.getByRole("tab", { name: "Logs" }).click();
  await page.locator(".logbox").waitFor();
  await page.waitForTimeout(1500);
  await shot(page, "12-logs");
  await page.getByRole("tab", { name: "Setup" }).click();
  await shot(page, "13-setup-tab");
  await page.getByRole("tab", { name: "About" }).click();
  await page.getByRole("button", { name: "Check for updates" }).click();
  await page.waitForTimeout(2500);
  await shot(page, "14-about");

  // default view from /api/ui/info (installed → Control) and a "show" push from a second launch
  const p2 = await ctx.newPage();
  await p2.goto(url);
  await p2.locator(".control-screen").waitFor({ timeout: 20000 });
  await p2.request.post(base + "/api/ui/show", { headers: { "x-hp-ui": url.split("#k=")[1] }, data: { view: "setup" } });
  await p2.locator(".check-screen").waitFor({ timeout: 10000 });
  console.log("  ✓ /api/ui/info view + live show event");
  await ctx.close();
} finally {
  await browser.close();
  srv.kill();
}
console.log(errors.length ? "Browser errors:\n  " + errors.join("\n  ") : "No browser console errors.");
console.log(`${shots.length} screenshots`);
