// Launch Chromium for screenshots: Playwright's own build if installed, else CHROMIUM_PATH
// (e.g. @sparticuz/chromium extracted to /tmp/chromium when the Playwright CDN is blocked).
import { chromium } from "playwright";
export async function launch() {
  try {
    return await chromium.launch({ headless: true });
  } catch (e) {
    const exe = process.env.CHROMIUM_PATH;
    if (!exe) throw e;
    return chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--headless=shell"] });
  }
}
