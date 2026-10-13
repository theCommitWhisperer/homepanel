import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { plainApp } from "./helpers.js";

describe("GET /download/HomePanel.exe", () => {
  const saved = process.env.HOMEPANEL_EXE;
  afterEach(() => {
    if (saved === undefined) delete process.env.HOMEPANEL_EXE;
    else process.env.HOMEPANEL_EXE = saved;
  });

  it("is 404 when not running from the exe", async () => {
    delete process.env.HOMEPANEL_EXE;
    const { app } = await plainApp();
    const r = await app.inject({ method: "GET", url: "/download/HomePanel.exe" });
    expect(r.statusCode).toBe(404);
    expect(r.body).toContain("releases");
    await app.close();
  });

  it("serves the running exe", async () => {
    const { app, dir } = await plainApp();
    const exe = path.join(dir, "HomePanel.exe");
    fs.writeFileSync(exe, Buffer.from("MZ fake exe"));
    process.env.HOMEPANEL_EXE = exe;
    const r = await app.inject({ method: "GET", url: "/download/HomePanel.exe" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toContain("HomePanel.exe");
    expect(r.rawPayload.toString()).toBe("MZ fake exe");
    await app.close();
  });
});
