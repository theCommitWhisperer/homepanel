/**
 * Imported first by main.ts, so it runs before any other module of the bundle evaluates.
 *
 * The bundle is CommonJS (Node SEA needs that), where `import.meta.url` does not exist. The bundler
 * replaces every `import.meta.url` with `globalThis.__HOMEPANEL_META_URL__`, which this module sets
 * to the URL of `<root>/apps/server/dist/index.js`. <root> is the extracted asset folder inside
 * HomePanel.exe, or the repo checkout when the bundle runs with plain node. Code that resolves
 * files relative to its package (server PKG_ROOT, installer findRepoRoot) then finds them.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appDirCandidates, isSea, pickAppDir } from "./runtime.js";
import { VERSION } from "./version.js";

declare global {
  // eslint-disable-next-line no-var
  var __HOMEPANEL_META_URL__: string;
  // eslint-disable-next-line no-var
  var __HOMEPANEL_ROOT__: string;
  // eslint-disable-next-line no-var
  var HOMEPANEL_EXE: string | undefined;
}

const sea = isSea();
// non-SEA: the bundle lives at apps/desktop/dist/homepanel.cjs → repo root is three levels up
const root = sea ? pickAppDir(appDirCandidates(VERSION)) : path.resolve(__dirname, "..", "..", "..");

globalThis.__HOMEPANEL_ROOT__ = root;
globalThis.__HOMEPANEL_META_URL__ = pathToFileURL(path.join(root, "apps", "server", "dist", "index.js")).href;
if (sea) {
  globalThis.HOMEPANEL_EXE = process.execPath;
  process.env.HOMEPANEL_EXE = process.execPath;
}
