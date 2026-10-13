/**
 * Where HomePanel.exe keeps the files it carries (kiosk web app, agent scripts, docs, deploy files,
 * example data). Pure helpers, no side effects: boot.ts calls them once at startup.
 *
 * The extracted folder mirrors the repo layout, so code that finds files relative to its own
 * package (server data-example, kiosk dist, installer docs/ and deploy/) works unchanged:
 *
 *   <appDir>/pnpm-workspace.yaml            marker the installer's findRepoRoot() looks for
 *   <appDir>/apps/server/data-example/...   example profiles copied into a new DATA_DIR
 *   <appDir>/apps/kiosk/dist/...            KIOSK_DIST
 *   <appDir>/apps/agent/dist/windows/...    AGENT_DIST (install.ps1, scripts/*.ps1, agent.example.yaml)
 *   <appDir>/docs/...  <appDir>/deploy/...
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Name of the file written last after a complete extraction; holds the build hash. */
export const MARKER = ".homepanel-extracted";

export function isSea(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = process.getBuiltinModule?.("node:sea") as { isSea(): boolean } | undefined;
    return !!sea?.isSea();
  } catch {
    return false;
  }
}

/** Candidate folders in order of preference. */
export function appDirCandidates(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string[] {
  if (env.HOMEPANEL_APP_DIR) return [path.resolve(env.HOMEPANEL_APP_DIR)];
  if (platform === "win32") {
    const programData = env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData";
    const local = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
    return [path.win32.join(programData, "HomePanel", "app", version), path.win32.join(local, "HomePanel", "app", version)];
  }
  const hpHome = env.HOMEPANEL_HOME || path.join(home, ".homepanel");
  return [path.join(hpHome, "app", version), path.join(os.tmpdir(), `homepanel-${process.getuid?.() ?? "user"}`, "app", version)];
}

function usable(dir: string): boolean {
  try {
    if (fs.existsSync(path.join(dir, MARKER))) return true; // already extracted (maybe read-only for us)
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** First candidate that is already extracted or writable. */
export function pickAppDir(candidates: string[], isUsable: (d: string) => boolean = usable): string {
  for (const d of candidates) if (isUsable(d)) return d;
  return candidates[candidates.length - 1]!;
}
