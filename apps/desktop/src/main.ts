/**
 * HomePanel.exe — one program for everything (PACKAGING.md):
 *
 *   HomePanel.exe                     the HomePanel window (double-click): system check, setup, control
 *   HomePanel.exe ui [...]            the same window (--no-open, --fake[=scenario], --view)
 *   HomePanel.exe tray                tray icon + window server (scheduled task "HomePanel Tray")
 *   HomePanel.exe setup [--console]   terminal setup wizard (apps/installer)
 *   HomePanel.exe server [...]        HomePanel server (apps/server); kiosk + agent files come from the exe
 *   HomePanel.exe agent <cmd> [...]   PC agent (apps/agent): run, list-sensors, test-action, init, check-config
 *   HomePanel.exe --version | --help
 */
import "./boot.js"; // must stay first: sets up import.meta.url replacement + HOMEPANEL_EXE
import { main as agentMain } from "../../agent/src/main.js";
import { setAiLoader } from "../../server/src/assistant/service.js";
import { main as serverMain } from "../../server/src/main.js";
import { assetPaths, extractAssets } from "./assets.js";
import { runInstaller } from "./installer-shim.js";
import { isSea } from "./runtime.js";
import { plan } from "./commands.js";
import { doubleClickMain, trayMain, uiMain } from "./ui/launch.js";

/** In HomePanel.exe: unpack the kiosk/agent/docs/desktop-ui files once per build and point the server at them. */
export function prepareAssets(): void {
  if (!isSea()) return;
  const root = globalThis.__HOMEPANEL_ROOT__;
  extractAssets(root);
  const p = assetPaths(root);
  process.env.KIOSK_DIST ||= p.kioskDist;
  process.env.AGENT_DIST ||= p.agentDist;
}

/**
 * Run a HomePanel command. Resolves with the exit code; `keepAlive` is true when the command
 * started something long-running (server, agent run) and the process must not exit on success.
 */
export async function main(argv: string[]): Promise<{ code: number; keepAlive: boolean }> {
  const p = plan(argv);
  switch (p.kind) {
    case "print":
      (p.code ? process.stderr : process.stdout).write(p.text.endsWith("\n") ? p.text : p.text + "\n");
      return { code: p.code, keepAlive: false };
    case "ui":
      prepareAssets(); // desktop-ui, docs/ and deploy/
      return p.doubleClick ? doubleClickMain() : uiMain(p.argv);
    case "tray":
      prepareAssets();
      return trayMain(p.argv);
    case "installer":
      prepareAssets(); // docs/ and deploy/ for the wizard and the AI guide
      return { code: await runInstaller(p.argv), keepAlive: false };
    case "server":
      prepareAssets();
      setAiLoader(() => import("@homepanel/ai") as never);
      await serverMain(p.argv);
      return { code: 0, keepAlive: true };
    case "agent":
      return { code: await agentMain(p.argv), keepAlive: true };
  }
}
