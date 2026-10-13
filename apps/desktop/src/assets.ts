/**
 * Extract the files embedded in HomePanel.exe (SEA assets) to the app folder, once per build.
 * The build writes `__manifest.json` (asset keys + build hash); every other asset key is a path
 * relative to the app folder, using forward slashes.
 */
import fs from "node:fs";
import path from "node:path";
import { MARKER } from "./runtime.js";

export const MANIFEST_KEY = "__manifest.json";

export interface AssetManifest {
  version: string;
  hash: string;
  files: string[];
}

/** The subset of node:sea we use (injectable for tests). */
export interface AssetSource {
  getAsset(key: string, encoding: "utf8"): string;
  getRawAsset(key: string): ArrayBuffer;
}

export function seaAssetSource(): AssetSource {
  const sea = process.getBuiltinModule("node:sea") as unknown as AssetSource;
  return sea;
}

function safeTarget(root: string, key: string): string {
  const target = path.resolve(root, ...key.split("/"));
  const rel = path.relative(root, target);
  if (!key || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`bad asset path: ${key}`);
  return target;
}

/**
 * Make sure `root` holds this build's files. Returns "fresh" when it extracted, "cached" when the
 * marker already matched. Writes each file through a temp name + rename, the marker last.
 */
export function extractAssets(root: string, src: AssetSource = seaAssetSource()): "fresh" | "cached" {
  const manifest = JSON.parse(src.getAsset(MANIFEST_KEY, "utf8")) as AssetManifest;
  const marker = path.join(root, MARKER);
  try {
    if (fs.readFileSync(marker, "utf8").trim() === manifest.hash) return "cached";
  } catch {
    /* not extracted yet */
  }
  fs.mkdirSync(root, { recursive: true });
  for (const key of manifest.files) {
    const target = safeTarget(root, key);
    const data = Buffer.from(src.getRawAsset(key));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, target);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      // another HomePanel process may hold the file open (Windows); same size = same content
      const st = fs.statSync(target, { throwIfNoEntry: false });
      if (!st || st.size !== data.length) throw e;
    }
  }
  fs.writeFileSync(marker, manifest.hash + "\n");
  return "fresh";
}

/** Paths the server needs, inside an extracted app folder. */
export function assetPaths(root: string) {
  return {
    kioskDist: path.join(root, "apps", "kiosk", "dist"),
    agentDist: path.join(root, "apps", "agent", "dist", "windows"),
    dataExample: path.join(root, "apps", "server", "data-example"),
    docs: path.join(root, "docs"),
    deploy: path.join(root, "deploy"),
  };
}
