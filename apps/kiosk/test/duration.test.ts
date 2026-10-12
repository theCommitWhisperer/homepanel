import { describe, expect, it } from "vitest";
import { parseDuration } from "../src/lib/duration";

describe("parseDuration", () => {
  it.each([
    ["10s", 10_000], ["5m", 300_000], ["1h", 3_600_000], ["1h30m", 5_400_000], ["500ms", 500],
    ["90", 90_000], [" 2m ", 120_000], ["1.5s", 1500], ["1m 30s", 90_000],
  ])("%s → %i ms", (input, ms) => expect(parseDuration(input)).toBe(ms));
  it("accepts numbers as seconds", () => expect(parseDuration(3)).toBe(3000));
  it.each(["", "abc", "10x", "5m and change", "-1s"])("rejects %j", (input) => expect(parseDuration(input)).toBeNull());
  it("rejects null/undefined", () => {
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });
});
