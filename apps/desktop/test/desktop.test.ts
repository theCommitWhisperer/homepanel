import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assetPaths, extractAssets, MANIFEST_KEY, type AssetSource } from "../src/assets.js";
import { plan } from "../src/commands.js";
import { appDirCandidates, MARKER, pickAppDir } from "../src/runtime.js";

describe("plan", () => {
  it("double-click runs setup", () => expect(plan([])).toEqual({ kind: "installer", argv: ["setup"] }));
  it("passes installer commands through", () => {
    expect(plan(["setup", "--plain"])).toEqual({ kind: "installer", argv: ["setup", "--plain"] });
    expect(plan(["doctor"])).toEqual({ kind: "installer", argv: ["doctor"] });
  });
  it("server and agent get the rest", () => {
    expect(plan(["server", "--demo"])).toEqual({ kind: "server", argv: ["--demo"] });
    expect(plan(["agent", "list-sensors", "--mock"])).toEqual({ kind: "agent", argv: ["list-sensors", "--mock"] });
    expect(plan(["agent"])).toEqual({ kind: "agent", argv: ["help"] });
  });
  it("version, help, unknown", () => {
    expect(plan(["--version"])).toMatchObject({ kind: "print", code: 0 });
    expect(plan(["--help"])).toMatchObject({ kind: "print", code: 0 });
    expect(plan(["nope"])).toMatchObject({ kind: "print", code: 2 });
  });
});

describe("app folder", () => {
  it("prefers ProgramData on Windows, then LOCALAPPDATA", () => {
    const c = appDirCandidates("0.2.0", { ProgramData: "C:\\ProgramData", LOCALAPPDATA: "C:\\Users\\k\\AppData\\Local" }, "win32", "C:\\Users\\k");
    expect(c).toEqual(["C:\\ProgramData\\HomePanel\\app\\0.2.0", "C:\\Users\\k\\AppData\\Local\\HomePanel\\app\\0.2.0"]);
  });
  it("uses ~/.homepanel elsewhere and honours HOMEPANEL_APP_DIR", () => {
    expect(appDirCandidates("0.2.0", {}, "linux", "/home/k")[0]).toBe(path.join("/home/k", ".homepanel", "app", "0.2.0"));
    expect(appDirCandidates("0.2.0", { HOMEPANEL_APP_DIR: "/opt/hp" }, "linux", "/home/k")).toEqual([path.resolve("/opt/hp")]);
  });
  it("picks the first usable candidate", () => {
    expect(pickAppDir(["a", "b"], (d) => d === "b")).toBe("b");
    expect(pickAppDir(["a", "b"], () => false)).toBe("b");
  });
});

describe("extractAssets", () => {
  const files: Record<string, string> = { "apps/kiosk/dist/index.html": "<html>", "docs/a.md": "# A" };
  const src = (hash: string): AssetSource => ({
    getAsset: (k) => {
      if (k !== MANIFEST_KEY) throw new Error(k);
      return JSON.stringify({ version: "0.2.0", hash, files: Object.keys(files) });
    },
    getRawAsset: (k) => {
      const b = Buffer.from(files[k]!);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  });

  it("extracts once per build hash", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hp-desktop-"));
    expect(extractAssets(root, src("h1"))).toBe("fresh");
    expect(fs.readFileSync(path.join(assetPaths(root).kioskDist, "index.html"), "utf8")).toBe("<html>");
    expect(fs.readFileSync(path.join(root, MARKER), "utf8").trim()).toBe("h1");
    expect(extractAssets(root, src("h1"))).toBe("cached");
    expect(extractAssets(root, src("h2"))).toBe("fresh");
  });

  it("refuses paths outside the folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hp-desktop-"));
    const bad: AssetSource = {
      getAsset: () => JSON.stringify({ version: "x", hash: "h", files: ["../evil.txt"] }),
      getRawAsset: () => new ArrayBuffer(1),
    };
    expect(() => extractAssets(root, bad)).toThrow(/bad asset path/);
  });
});
