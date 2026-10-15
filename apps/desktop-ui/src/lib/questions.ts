import type { Choice, Question } from "./types";

export const BUTTONS_MAX = 5;

export type QuestionLayout = "buttons" | "list" | "text" | "password" | "confirm";

export function layoutFor(q: Pick<Question, "kind" | "choices">): QuestionLayout {
  switch (q.kind) {
    case "select":
      return (q.choices?.length ?? 0) <= BUTTONS_MAX ? "buttons" : "list";
    case "input":
      return "text";
    case "password":
      return "password";
    case "confirm":
      return "confirm";
  }
}

/** Index of the choice to focus first: the default, else the first. */
export function defaultChoiceIndex(q: Pick<Question, "choices" | "default">): number {
  const i = (q.choices ?? []).findIndex((c) => c.value === q.default);
  return i >= 0 ? i : 0;
}

export function confirmDefault(q: Pick<Question, "default">): boolean {
  return q.default === true || q.default === "true" || q.default === "yes";
}

/** Initial text for input questions. */
export function initialText(q: Pick<Question, "kind" | "default">): string {
  return q.kind === "input" && typeof q.default === "string" ? q.default : "";
}

/**
 * The value sent to POST /api/setup/answer. Select → the choice's string value; confirm → boolean;
 * input → typed text, or the default when left empty (like the terminal prompt); password → as typed.
 * Returns an error string instead when the answer cannot be sent.
 */
export function answerFor(q: Question, raw: string | boolean | number): { value: string | boolean } | { error: string } {
  switch (q.kind) {
    case "select": {
      const choices = q.choices ?? [];
      const c: Choice | undefined = typeof raw === "number" ? choices[raw] : choices.find((x) => x.value === raw);
      return c ? { value: c.value } : { error: "Pick one of the options." };
    }
    case "confirm":
      if (typeof raw === "boolean") return { value: raw };
      if (typeof raw === "string" && /^(y|yes|true)$/i.test(raw.trim())) return { value: true };
      if (typeof raw === "string" && /^(n|no|false)$/i.test(raw.trim())) return { value: false };
      return { error: "Answer Yes or No." };
    case "input": {
      const t = String(raw);
      if (t.trim() === "" && typeof q.default === "string") return { value: q.default };
      return { value: t };
    }
    case "password":
      return { value: String(raw) };
  }
}

/** Keyboard shortcut for the n-th button (1–9). */
export function shortcutIndex(key: string, count: number): number | undefined {
  if (!/^[1-9]$/.test(key)) return undefined;
  const i = Number(key) - 1;
  return i < count ? i : undefined;
}

/** Long choice names like "Show me each step and ask (recommended the first time)" → title + hint. */
export function splitChoice(c: Choice): { title: string; hint?: string } {
  if (c.description) return { title: c.name, hint: c.description };
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(c.name);
  if (m && m[1] && m[1].length >= 6) return { title: m[1], hint: m[2]![0]!.toUpperCase() + m[2]!.slice(1) };
  const d = /^(.*?)\s+[—–-]\s+(.+)$/.exec(c.name);
  if (d && d[1] && d[1].length >= 6) return { title: d[1], hint: d[2]![0]!.toUpperCase() + d[2]!.slice(1) };
  return { title: c.name };
}
