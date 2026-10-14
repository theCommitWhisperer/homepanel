import { describe, expect, it } from "vitest";
import { alternateHaUrl, cleanHaUrl, HaClient, hasExplicitPort, normalizeHaUrl, resolveHaUrl } from "../src/ha/client.js";
import { waitForHa } from "../src/ha/discover.js";
import { cleanPastedToken } from "../src/steps/onboard.js";

/** fake network: HA answers only on the given base URLs */
const haOn = (...bases: string[]) =>
  (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const base = `${u.protocol}//${u.host}`;
    if (!bases.includes(base)) throw new TypeError("fetch failed: ECONNREFUSED");
    if (u.pathname === "/auth/providers") return new Response('[{"type":"homeassistant"}]', { status: 200 });
    if (u.pathname === "/api/onboarding") return new Response("404: Not Found", { status: 404 });
    return new Response("<title>Home Assistant</title>", { status: 200 });
  }) as typeof fetch;

describe("Home Assistant address handling (port 8123 vs 80)", () => {
  it("keeps an explicit :80 instead of forcing :8123", () => {
    expect(hasExplicitPort("192.168.1.81:80")).toBe(true);
    expect(hasExplicitPort("http://192.168.1.81/home/overview")).toBe(false);
    expect(normalizeHaUrl("192.168.1.81:80")).toBe("http://192.168.1.81");
    expect(normalizeHaUrl("192.168.1.81")).toBe("http://192.168.1.81:8123");
    expect(cleanHaUrl("http://192.168.1.81/home/overview")).toBe("http://192.168.1.81");
    expect(new HaClient("http://192.168.1.81").url).toBe("http://192.168.1.81");
  });

  it("alternates between 8123 and 80", () => {
    expect(alternateHaUrl("http://192.168.1.81:8123")).toBe("http://192.168.1.81");
    expect(alternateHaUrl("http://192.168.1.81")).toBe("http://192.168.1.81:8123");
    expect(alternateHaUrl("http://192.168.1.81:9000")).toBeUndefined();
  });

  it("resolves a typed IP to the port Home Assistant answers on", async () => {
    expect(await resolveHaUrl("192.168.1.81", haOn("http://192.168.1.81"))).toEqual({ url: "http://192.168.1.81", reachable: true });
    expect(await resolveHaUrl("192.168.1.81", haOn("http://192.168.1.81:8123"))).toEqual({ url: "http://192.168.1.81:8123", reachable: true });
    expect(await resolveHaUrl("192.168.1.81", haOn())).toEqual({ url: "http://192.168.1.81:8123", reachable: false });
  });

  it("waitForHa follows HA to the other port", async () => {
    expect(await waitForHa("http://192.168.1.81:8123", { fetchImpl: haOn("http://192.168.1.81"), intervalMs: 1, timeoutMs: 1000 })).toBe("http://192.168.1.81");
  });

  it("cleans pasted tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ4In0.abc_DEF-123";
    expect(cleanPastedToken(`\x1b[200~${jwt}\x1b[201~`)).toBe(jwt);
    expect(cleanPastedToken(`  ${jwt.slice(0, 20)}\r\n${jwt.slice(20)}  `)).toBe(jwt);
  });
});
