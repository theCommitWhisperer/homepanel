/** Bundle entry point (dist/homepanel.cjs → HomePanel.exe). */
import { main } from "./main.js";

const argv = process.argv.slice(2);
const doubleClicked = argv.length === 0 && process.platform === "win32";

/** Keep the console window open after a double-click so the user can read what happened. */
async function pauseIfDoubleClicked(): Promise<void> {
  if (!doubleClicked || !process.stdin.isTTY) return;
  process.stdout.write("\nPress Enter to close this window.");
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });
}

main(argv).then(
  async ({ code, keepAlive }) => {
    if (keepAlive && code === 0) return;
    if (code !== 0) await pauseIfDoubleClicked();
    process.exit(code);
  },
  async (e: Error) => {
    if (e?.name === "ExitPromptError") {
      process.stdout.write("\nStopped.\n");
      process.exit(130);
    }
    process.stderr.write(`HomePanel: ${e?.stack ?? e}\n`);
    await pauseIfDoubleClicked();
    process.exit(1);
  },
);
