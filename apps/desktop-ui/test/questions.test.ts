import { describe, expect, it } from "vitest";
import { answerFor, confirmDefault, defaultChoiceIndex, initialText, layoutFor, shortcutIndex, splitChoice } from "../src/lib/questions";
import type { Question } from "../src/lib/types";

const q = (o: Partial<Question>): Question => ({ type: "question", id: "q1", kind: "select", message: "?", ...o });
const choices = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, name: `Choice ${i}` }));

describe("question → control", () => {
  it("picks the layout", () => {
    expect(layoutFor(q({ choices: choices(3) }))).toBe("buttons");
    expect(layoutFor(q({ choices: choices(5) }))).toBe("buttons");
    expect(layoutFor(q({ choices: choices(6) }))).toBe("list");
    expect(layoutFor(q({ kind: "input" }))).toBe("text");
    expect(layoutFor(q({ kind: "password" }))).toBe("password");
    expect(layoutFor(q({ kind: "confirm" }))).toBe("confirm");
  });
  it("focuses the default", () => {
    expect(defaultChoiceIndex(q({ choices: choices(4), default: "v2" }))).toBe(2);
    expect(defaultChoiceIndex(q({ choices: choices(4), default: "nope" }))).toBe(0);
    expect(confirmDefault(q({ kind: "confirm", default: true }))).toBe(true);
    expect(confirmDefault(q({ kind: "confirm" }))).toBe(false);
    expect(initialText(q({ kind: "input", default: "gaming-pc" }))).toBe("gaming-pc");
    expect(initialText(q({ kind: "password", default: "x" }))).toBe("");
  });
  it("maps answers to wire values", () => {
    const sel = q({ choices: choices(3) });
    expect(answerFor(sel, 1)).toEqual({ value: "v1" });
    expect(answerFor(sel, "v2")).toEqual({ value: "v2" });
    expect(answerFor(sel, 7)).toHaveProperty("error");
    const c = q({ kind: "confirm" });
    expect(answerFor(c, true)).toEqual({ value: true });
    expect(answerFor(c, "y")).toEqual({ value: true });
    expect(answerFor(c, "No")).toEqual({ value: false });
    expect(answerFor(c, "maybe")).toHaveProperty("error");
    const i = q({ kind: "input", default: "Gaming PC" });
    expect(answerFor(i, "  ")).toEqual({ value: "Gaming PC" });
    expect(answerFor(i, "Desk PC")).toEqual({ value: "Desk PC" });
    expect(answerFor(q({ kind: "input" }), "")).toEqual({ value: "" });
    expect(answerFor(q({ kind: "password" }), " s3cret ")).toEqual({ value: " s3cret " });
  });
  it("keyboard shortcuts and choice text", () => {
    expect(shortcutIndex("2", 3)).toBe(1);
    expect(shortcutIndex("4", 3)).toBeUndefined();
    expect(shortcutIndex("a", 3)).toBeUndefined();
    expect(splitChoice({ value: "ask", name: "Show me each step and ask before doing it (recommended the first time)" })).toEqual({ title: "Show me each step and ask before doing it", hint: "Recommended the first time" });
    expect(splitChoice({ value: "all", name: "Do all of them — I've read the list (exact actions are still printed)" }).title).toBe("Do all of them — I've read the list");
    expect(splitChoice({ value: "x", name: "Reolink", description: "PoE" })).toEqual({ title: "Reolink", hint: "PoE" });
    expect(splitChoice({ value: "n", name: "Not now" })).toEqual({ title: "Not now" });
  });
});
