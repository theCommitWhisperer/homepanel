/**
 * How this program is running (HomePanel.exe single executable, or node from a checkout) and how to
 * build command lines that run HomePanel subcommands (used for scheduled tasks / systemd units).
 * See PACKAGING.md. No side effects on import.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "./context.js";

export function isSea(): boolean {
  try {
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const sea = getBuiltin?.("node:sea") as { isSea(): boolean } | undefined;
    return !!sea?.isSea();
  } catch {
    return false;
  }
}

/** Path of the running HomePanel.exe (SEA), else null. */
export function runningExe(): string | null {
  return isSea() ? process.env.HOMEPANEL_EXE || process.execPath : null;
}

/** Entry scripts in a source checkout (after `pnpm -r build`). */
export function sourceEntries(repoRoot = findRepoRoot()): { server: string; agent: string; installer: string } {
  const root = repoRoot ?? process.cwd();
  return {
    server: join(root, "apps", "server", "dist", "index.js"),
    agent: join(root, "apps", "agent", "dist", "homepanel-agent.mjs"),
    installer: join(root, "apps", "installer", "dist", "cli.js"),
  };
}

/**
 * Command line that runs a HomePanel subcommand with the *installed* binary.
 * SEA: `file` = installed exe (or the running exe when none is installed) and args = [sub, ...args].
 * Source checkout: `file` = node and args = [<repo>/apps/server/dist/index.js | <repo>/apps/agent/dist/homepanel-agent.mjs, ...args].
 */
export function selfCommand(
  installedExe: string | null,
  sub: "server" | "agent",
  args: string[],
  o: { sea?: boolean; repoRoot?: string } = {},
): { file: string; args: string[] } {
  const sea = o.sea ?? isSea();
  if (sea) return { file: installedExe ?? runningExe() ?? process.execPath, args: [sub, ...args] };
  const e = sourceEntries(o.repoRoot);
  return { file: process.execPath, args: [sub === "server" ? e.server : e.agent, ...args] };
}

/** Command line that re-runs the setup wizard itself (for elevation). */
export function selfSetupCommand(args: string[], o: { sea?: boolean } = {}): { file: string; args: string[] } {
  if (o.sea ?? isSea()) return { file: runningExe() ?? process.execPath, args: ["setup", ...args] };
  // node <script> setup ...   (process.argv[1] is cli.js, or the desktop bundle when run with plain node)
  const script = process.argv[1] && existsSync(process.argv[1]) ? process.argv[1] : sourceEntries().installer;
  return { file: process.execPath, args: [script, "setup", ...args] };
}
