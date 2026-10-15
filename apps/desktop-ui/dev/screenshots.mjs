// Screenshots of every main screen against the mock (dev/mock.mjs), dark + light, 1100×760 and 900×640.
//   pnpm --filter @homepanel/desktop-ui build && pnpm --filter @homepanel/desktop-ui screenshots
// Chromium: Playwright's own, else CHROMIUM_PATH or /tmp/chromium (see dev/browser.mjs).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "screenshots");
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });

const mock = spawn(process.execPath, [join(here, "mock.mjs")], { env: { ...process.env, PORT: String(PORT), MOCK_SPEED: "0.15" }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((res, rej) => {
  mock.stdout.on("data", (d) => String(d).includes("mock on") && res());
  mock.on("exit", (c) => rej(new Error(`mock exited ${c}`)));
});

const browser = await launch();
const shots = [];
async function shot(page, name, settle = 450) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(settle);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  shots.push(name);
  console.log("  ✓", name);
}
async function apiCall(page, path, body) {
  const r = await page.request.post(BASE + path, { headers: { "x-hp-ui": "dev" }, data: body ?? {} });
  return r.json();
}
async function waitQuestion(page, text) {
  await page.locator(".question h3", { hasText: text }).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(200);
}
/** Answer "Do this now?" with Yes until the wanted question shows up. */
async function yesUntil(page, text) {
  for (let i = 0; i < 40; i++) {
    const q = page.locator(".question h3");
    await q.first().waitFor({ timeout: 30000 });
    const t = await q.first().innerText();
    if (t.includes(text)) return;
    if (t.includes("Do this now?")) await page.getByRole("button", { name: /^Yes/ }).click();
    await page.waitForFunction((old) => document.querySelector(".question h3")?.textContent !== old || !document.querySelector(".question"), t, { timeout: 30000 });
    await page.waitForTimeout(80);
  }
  throw new Error(`question “${text}” never came`);
}
async function checkDone(page) {
  await page.locator(".rec-card.ready").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Check again" }).waitFor();
}

async function context(scheme, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
  return { ctx, page };
}

try {
  /* ---- dark 1100×760: the whole tour ---- */
  {
    const { ctx, page } = await context("dark", 1100, 760);
    await page.goto(`${BASE}/#k=dev`);
    await apiCall(page, "/api/mock/reset");
    await page.reload();
    await checkDone(page);
    await shot(page, "01-system-check");

    await page.getByRole("button", { name: "Choose something else" }).click();
    await page.locator(".mode-card").first().waitFor();
    await shot(page, "02-mode-picker");

    await page.locator(".ai-box .switch").click();
    await page.locator("#ai-key").fill("AIzaSyD3m0-k3y-f0r-scr33nsh0ts-0nly");
    await page.locator("#ai-key").blur();
    await page.locator(".main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await shot(page, "03-ai-guide");

    await page.locator('[data-mode="host"]').click();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await waitQuestion(page, "How do you want to go?");
    await page.waitForTimeout(400);
    await shot(page, "04-run-select");

    await page.locator(".choice").first().click();
    await waitQuestion(page, "Do this now?");
    await page.getByRole("button", { name: /^Yes/ }).click();
    await page.locator(".progress-top", { hasText: "Downloading" }).waitFor({ timeout: 20000 });
    await page.waitForFunction(() => Number(document.querySelector(".progress-top .num")?.textContent?.replace("%", "") ?? 0) >= 50, null, { timeout: 20000, polling: 20 });
    await shot(page, "05-run-progress", 0);

    await yesUntil(page, "Password for the HomePanel admin page");
    await page.locator(".choice", { hasText: "I'll type my own" }).click();
    await waitQuestion(page, "Admin password");
    await page.locator(".text-answer input").fill("abc");
    await page.keyboard.press("Enter");
    await page.locator(".field-err").waitFor();
    await page.locator(".text-answer input").fill("hunter2-desk");
    await shot(page, "06-run-password");
    await page.keyboard.press("Enter");
    await waitQuestion(page, "Again:");
    await page.locator(".text-answer input").fill("hunter2-desk");
    await page.keyboard.press("Enter");

    await yesUntil(page, "What now?");
    await page.locator(".ai-compose textarea").fill("Why did it fail?");
    await page.keyboard.press("Enter");
    await page.locator(".ai-msg.assistant", { hasText: "Try again" }).waitFor({ timeout: 20000 });
    await shot(page, "07-run-failed");

    await page.locator(".choice", { hasText: "Try again" }).click();
    await yesUntil(page, "Do this now?");
    await page.getByRole("button", { name: /^Yes/ }).click();
    await page.locator(".summary-screen").waitFor({ timeout: 30000 });
    await page.locator(".summary-row.secret").first().getByRole("button", { name: "Reveal" }).click();
    await shot(page, "08-summary");

    await page.getByRole("button", { name: "Open Control" }).click();
    await page.locator(".tile").first().waitFor();
    await page.locator(".action-row").first().waitFor();
    await shot(page, "09-control");

    await page.locator(".action-row", { hasText: "launch-steam" }).locator(".action-main").click();
    await page.locator(".drawer").waitFor();
    await shot(page, "10-buttons-drawer");
    await page.keyboard.press("Escape");

    await page.locator(".action-row", { hasText: "open-projects" }).getByRole("button", { name: "Test" }).click();
    await page.locator(".test-out").waitFor();
    await page.locator(".action-row", { hasText: "vol-down" }).getByRole("button", { name: /Move .* up/ }).click();
    await page.locator(".save-bar").waitFor();
    await shot(page, "11-buttons-unsaved");

    await page.getByRole("tab", { name: "Logs" }).click();
    await page.locator(".seg-btn", { hasText: "PC agent" }).click();
    await page.locator(".logbox .ll").first().waitFor();
    await shot(page, "12-logs");

    await page.getByRole("tab", { name: "About" }).click();
    await page.getByRole("button", { name: "Check for updates" }).click();
    await page.locator(".warn-text").waitFor();
    await shot(page, "13-about");
    await ctx.close();
  }

  /* ---- light 1100×760 ---- */
  {
    const { ctx, page } = await context("light", 1100, 760);
    await page.goto(`${BASE}/#k=dev`);
    await apiCall(page, "/api/mock/reset");
    await page.reload();
    await checkDone(page);
    await shot(page, "14-system-check-light");
    await page.getByRole("button", { name: "Control" }).click();
    await page.locator(".action-row").first().waitFor();
    await shot(page, "15-control-light");
    await ctx.close();
  }

  /* ---- dark 900×640 ---- */
  {
    const { ctx, page } = await context("dark", 900, 640);
    await page.goto(`${BASE}/#k=dev`);
    await apiCall(page, "/api/mock/reset");
    await page.reload();
    await checkDone(page);
    await shot(page, "16-system-check-900");
    await page.getByRole("button", { name: "Control" }).click();
    await page.locator(".action-row").first().waitFor();
    await shot(page, "17-control-900");
    // a recommended run from the check screen, with the AI guide panel, narrow
    await page.getByRole("button", { name: "System check" }).click();
    await checkDone(page);
    await apiCall(page, "/api/setup/start", { mode: "ha", fromStep: "mqtt", ai: { provider: "ollama" } });
    await waitQuestion(page, "Do this now?");
    await shot(page, "18-run-confirm-900");
    await yesUntil(page, "Which doorbell");
    await shot(page, "19-run-list-900");
    await ctx.close();
  }
} finally {
  await browser.close();
  mock.kill();
}
console.log(`${shots.length} screenshots in ${OUT}`);
