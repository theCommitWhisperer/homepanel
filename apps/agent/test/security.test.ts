import { describe, expect, it } from "vitest";
import { signingString } from "@homepanel/protocol";
import { createHmac } from "node:crypto";
import { CommandVerifier, sign } from "../src/security.js";

const KEY = "k3y-0123456789abcdef-test";
const NOW = 1_760_000_000_000;
const cmd = (over: Partial<{ id: string; action: string; ts: number; sig: string }> = {}) => {
  const base = { id: over.id ?? "c1", action: over.action ?? "lock", ts: over.ts ?? NOW };
  return JSON.stringify({ ...base, sig: over.sig ?? sign(KEY, base) });
};

describe("command verification", () => {
  it("sign() matches the protocol's signing string with HMAC-SHA256 hex", () => {
    const c = { id: "a", action: "b", ts: 1 };
    expect(sign(KEY, c)).toBe(createHmac("sha256", KEY).update(signingString(c)).digest("hex"));
    expect(signingString(c)).toBe("a.b.1");
  });

  it("accepts a valid command", () => {
    const v = new CommandVerifier(KEY, () => NOW);
    const r = v.verify(cmd());
    expect(r).toMatchObject({ ok: true, cmd: { id: "c1", action: "lock", ts: NOW } });
  });

  it("rejects a bad signature, wrong key, tampered action and junk sig", () => {
    const v = new CommandVerifier(KEY, () => NOW);
    expect(v.verify(cmd({ sig: "0".repeat(64) }))).toMatchObject({ ok: false, error: "bad signature", id: "c1" });
    const other = { id: "c2", action: "lock", ts: NOW };
    expect(v.verify(JSON.stringify({ ...other, sig: sign("another-key-entirely", other) }))).toMatchObject({ ok: false, error: "bad signature" });
    const signed = { id: "c3", action: "lock", ts: NOW };
    expect(v.verify(JSON.stringify({ ...signed, action: "shutdown", sig: sign(KEY, signed) }))).toMatchObject({ ok: false, error: "bad signature" });
    expect(v.verify(cmd({ id: "c4", sig: "zz" }))).toMatchObject({ ok: false, error: "bad signature" });
    expect(v.verify(cmd({ id: "c5", sig: sign(KEY, { id: "c5", action: "lock", ts: NOW }).toUpperCase() }))).toMatchObject({ ok: true });
  });

  it("rejects stale and future timestamps (>10 s)", () => {
    const v = new CommandVerifier(KEY, () => NOW);
    expect(v.verify(cmd({ id: "old", ts: NOW - 10_001 }))).toMatchObject({ ok: false, error: expect.stringContaining("stale") });
    expect(v.verify(cmd({ id: "fut", ts: NOW + 10_001 }))).toMatchObject({ ok: false, error: expect.stringContaining("stale") });
    expect(v.verify(cmd({ id: "edge", ts: NOW - 10_000 }))).toMatchObject({ ok: true });
  });

  it("rejects replays, remembering the last 500 ids", () => {
    const v = new CommandVerifier(KEY, () => NOW);
    expect(v.verify(cmd({ id: "r" })).ok).toBe(true);
    expect(v.verify(cmd({ id: "r" }))).toMatchObject({ ok: false, error: "replayed command" });
    for (let i = 0; i < 500; i++) expect(v.verify(cmd({ id: `n${i}` })).ok).toBe(true);
    // "r" has been pushed out of the window; ts check would still stop real replays
    expect(v.verify(cmd({ id: "r" })).ok).toBe(true);
    expect(v.verify(cmd({ id: "n499" })).ok).toBe(false);
  });

  it("a forged command does not burn the id", () => {
    const v = new CommandVerifier(KEY, () => NOW);
    expect(v.verify(cmd({ id: "x", sig: "1".repeat(64) })).ok).toBe(false);
    expect(v.verify(cmd({ id: "x" })).ok).toBe(true);
  });

  it("rejects malformed payloads", () => {
    const v = new CommandVerifier(KEY, () => NOW);
    expect(v.verify("not json")).toMatchObject({ ok: false, error: "malformed JSON" });
    expect(v.verify("null")).toMatchObject({ ok: false });
    expect(v.verify(JSON.stringify({ id: "a", action: "b", ts: "1", sig: "x" }))).toMatchObject({ ok: false, error: "malformed command", id: "a" });
  });
});
