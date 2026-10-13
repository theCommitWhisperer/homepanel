// pnpm --filter @homepanel/desktop sea → dist/HomePanel(.exe): a Node single executable application
// (https://nodejs.org/api/single-executable-applications.html) holding dist/homepanel.cjs and every
// file from dist/assets.json. Run `pnpm -r build` first (bundle + kiosk/agent builds).
//
//   node scripts/build-sea.mjs [--node <node binary>] [--out <file>]
//
// Steps: sea-config.json → `node --experimental-sea-config` (blob) → copy the node binary →
// (Windows) strip its signature with signtool if present, set icon + version info with rcedit →
// postject the blob with the NODE_SEA_FUSE sentinel → (macOS) ad-hoc sign.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const REPO = join(root, "..", "..");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const nodeBin = resolve(arg("--node") ?? process.execPath);
const out = resolve(arg("--out") ?? join(dist, isWin ? "HomePanel.exe" : "HomePanel"));
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const bundle = join(dist, "homepanel.cjs");
if (!existsSync(bundle) || !existsSync(join(dist, "assets.json"))) {
  console.error("dist/homepanel.cjs is missing: run `pnpm -r build` (or `pnpm --filter @homepanel/desktop build`) first.");
  process.exit(1);
}
if (!readFileSync(nodeBin).includes(SENTINEL)) {
  console.error(`${nodeBin} has no SEA fuse; use an official Node.js 22 binary (--node <path>).`);
  process.exit(1);
}

/* 1. SEA blob */
const assets = JSON.parse(readFileSync(join(dist, "assets.json"), "utf8"));
const seaConfig = {
  main: bundle,
  output: join(dist, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: Object.fromEntries([["__manifest.json", join(dist, "__manifest.json")], ...assets.map((a) => [a.key, a.file])]),
};
writeFileSync(join(dist, "sea-config.json"), JSON.stringify(seaConfig, null, 2));
execFileSync(nodeBin, ["--experimental-sea-config", join(dist, "sea-config.json")], { stdio: "inherit" });

/* 2. copy node */
mkdirSync(join(out, ".."), { recursive: true });
rmSync(out, { force: true });
copyFileSync(nodeBin, out);
chmodSync(out, 0o755);

/* 3. platform prep */
function findSigntool() {
  const which = spawnSync("where", ["signtool"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0];
  const kits = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (!existsSync(kits)) return undefined;
  const versions = readdirSync(kits).filter((d) => /^10\./.test(d)).sort().reverse();
  for (const v of versions) {
    const p = join(kits, v, "x64", "signtool.exe");
    if (existsSync(p)) return p;
  }
  return undefined;
}

if (isWin) {
  const signtool = findSigntool();
  if (signtool) {
    const r = spawnSync(signtool, ["remove", "/s", out], { stdio: "inherit" });
    if (r.status !== 0) console.warn("signtool remove failed; continuing (the exe is unsigned either way)");
  } else console.warn("signtool not found; skipping signature removal (postject still works)");

  try {
    const ico = join(dist, "HomePanel.ico");
    writeIco(join(REPO, "apps/kiosk/public/icon-192.png"), ico);
    const rcedit = require("rcedit");
    const v = pkg.version.replace(/-.*$/, "");
    await rcedit(out, {
      icon: ico,
      "file-version": v,
      "product-version": v,
      "version-string": {
        ProductName: "HomePanel",
        FileDescription: "HomePanel setup, server and PC agent",
        CompanyName: "HomePanel",
        OriginalFilename: "HomePanel.exe",
        InternalFilename: "HomePanel",
        LegalCopyright: "HomePanel contributors",
      },
    });
    console.log("set icon and version info");
  } catch (e) {
    console.warn(`rcedit skipped: ${e.message}`);
  }
}
if (isMac) spawnSync("codesign", ["--remove-signature", out], { stdio: "inherit" });

/* 4. inject */
const { inject } = require("postject");
await inject(out, "NODE_SEA_BLOB", readFileSync(seaConfig.output), {
  sentinelFuse: SENTINEL,
  ...(isMac ? { machoSegmentName: "NODE_SEA" } : {}),
  overwrite: true,
});
if (isMac) spawnSync("codesign", ["--sign", "-", out], { stdio: "inherit" });

console.log(`built ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB, ${assets.length} embedded files)`);

/** Minimal .ico holding one PNG image (Windows Vista+ reads PNG-in-ICO). */
function writeIco(png, file) {
  const data = readFileSync(png);
  const w = data.readUInt32BE(16);
  const h = data.readUInt32BE(20);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(w >= 256 ? 0 : w, 6);
  header.writeUInt8(h >= 256 ? 0 : h, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(data.length, 14);
  header.writeUInt32LE(22, 18);
  writeFileSync(file, Buffer.concat([header, data]));
}
