import { afterEach, describe, expect, it } from "vitest";
import { DeviceStore, PAIRING_TTL_MS } from "../src/devices.js";
import { sha256 } from "../src/store.js";
import { plainApp, tmpDir } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";

describe("pairing (store)", () => {
  it("issues 6-digit codes that expire after 10 minutes", () => {
    let now = 1_000_000;
    const s = new DeviceStore(tmpDir(), () => now);
    const p = s.startPairing("UA", "192.168.1.5");
    expect(p.code).toMatch(/^\d{6}$/);
    expect(p.expiresAt - now).toBe(PAIRING_TTL_MS);
    expect(s.pairingStatus(p.pairingId)).toEqual({ status: "pending" });
    now += PAIRING_TTL_MS + 1;
    expect(s.pairingStatus(p.pairingId)).toEqual({ status: "expired" });
    expect(s.approve(p.pairingId, "x", "desk-monitor")).toBeUndefined();
  });

  it("stores only the sha256 of device tokens", () => {
    const dir = tmpDir();
    const s = new DeviceStore(dir);
    const p = s.startPairing("UA", "10.0.0.2");
    s.approve(p.code, "Kitchen", "kitchen-ipad");
    const st = s.pairingStatus(p.pairingId);
    if (st?.status !== "approved") throw new Error("not approved");
    expect(Buffer.from(st.deviceToken, "base64url")).toHaveLength(32);
    const file = fs.readFileSync(path.join(dir, "devices.json"), "utf8");
    expect(file).not.toContain(st.deviceToken);
    expect(file).toContain(sha256(st.deviceToken));
    expect(s.byToken(st.deviceToken)?.name).toBe("Kitchen");
  });
});

describe("pairing (HTTP flow)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("start → admin approve → status returns token → WS welcome", async () => {
    const hp = await plainApp();
    close = () => hp.app.close();
    const { app } = hp;

    const start = await app.inject({ method: "POST", url: "/api/pair/start", headers: { "user-agent": "FireHD" } });
    expect(start.statusCode).toBe(200);
    const { pairingId, code } = start.json();

    expect((await app.inject({ url: `/api/pair/status/${pairingId}` })).json()).toEqual({ status: "pending" });

    // admin auth required
    expect((await app.inject({ url: "/api/admin/pairings" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "nope" } })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "secret" } });
    const session = login.json().session as string;
    const auth = { authorization: `Bearer ${session}` };

    const pend = (await app.inject({ url: "/api/admin/pairings", headers: auth })).json();
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ pairingId, code, userAgent: "FireHD" });

    const bad = await app.inject({ method: "POST", url: `/api/admin/pairings/${pairingId}/approve`, headers: auth, payload: { name: "Fire", profileId: "nope" } });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({ method: "POST", url: `/api/admin/pairings/${pairingId}/approve`, headers: auth, payload: { name: "Fire", profileId: "fire-hd8" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: "Fire", profileId: "fire-hd8" });

    const st = (await app.inject({ url: `/api/pair/status/${pairingId}` })).json();
    expect(st.status).toBe("approved");
    expect(typeof st.deviceToken).toBe("string");

    const devs = (await app.inject({ url: "/api/admin/devices", headers: auth })).json();
    expect(devs).toHaveLength(1);

    // device token works for camera route auth (503-ish from NullHa, but not 401)
    const cam = await app.inject({ url: `/api/camera/camera.x/snapshot?t=${encodeURIComponent(st.deviceToken)}` });
    expect(cam.statusCode).not.toBe(401);
    expect((await app.inject({ url: `/api/camera/camera.x/snapshot?t=wrong` })).statusCode).toBe(401);

    // revoke
    const del = await app.inject({ method: "DELETE", url: `/api/admin/devices/${devs[0].id}`, headers: auth });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ url: `/api/camera/camera.x/snapshot?t=${encodeURIComponent(st.deviceToken)}` })).statusCode).toBe(401);
  });

  it("rejected pairing reports rejected", async () => {
    const hp = await plainApp();
    close = () => hp.app.close();
    const { app } = hp;
    const { pairingId } = (await app.inject({ method: "POST", url: "/api/pair/start" })).json();
    const { session } = (await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "secret" } })).json();
    await app.inject({ method: "POST", url: `/api/admin/pairings/${pairingId}/reject`, headers: { authorization: `Bearer ${session}` } });
    expect((await app.inject({ url: `/api/pair/status/${pairingId}` })).json()).toEqual({ status: "rejected" });
  });
});
