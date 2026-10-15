/**
 * Web versions of the installer's Prompter and Out (UI-CONTRACT.md): every prompt becomes a
 * `question` event and waits for POST /api/setup/answer; every out.* line becomes a `log` event.
 * The flows themselves are unchanged — they only see the Prompter / Out interfaces.
 */
import type { Choice, Out, Prompter } from "../ui.js";
import type { EventSink, LogLevel } from "./events.js";

const ANSI = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Same name inquirer uses, so the flows' existing Ctrl+C handling (rethrow / "Stopped.") applies. */
export function exitPromptError(message = "Setup was stopped from the window."): Error {
  const e = new Error(message);
  e.name = "ExitPromptError";
  return e;
}

/** Which step the next log line / question belongs to (set by the step hooks). */
export interface StepCursor {
  current?: string;
}

export function webOut(sink: EventSink, cursor: StepCursor): Out {
  const emit = (level: LogLevel, text: string, items?: string[]) =>
    sink.emit({
      type: "log",
      level,
      text: stripAnsi(text),
      ...(items ? { items: items.map(stripAnsi) } : {}),
      ...(cursor.current ? { stepId: cursor.current } : {}),
    });
  return {
    line: (t = "") => emit("line", t),
    heading: (t) => emit("heading", t),
    info: (t) => emit("info", t),
    ok: (t) => emit("ok", t),
    warn: (t) => emit("warn", t),
    err: (t) => emit("err", t),
    code: (t) => emit("code", t),
    steps: (items) => emit("steps", "", items),
  };
}

type Kind = "select" | "input" | "password" | "confirm";

interface Pending {
  id: string;
  kind: Kind;
  /** maps the wire value to the prompt's answer, or returns { error } */
  accept(v: unknown): { value: unknown } | { error: string };
  resolve(v: unknown): void;
  reject(e: Error): void;
}

export type AnswerResult = { ok: true } | { ok: false; error: string; status: number };

export class WebPrompter implements Prompter {
  private seq = 0;
  private pending?: Pending;
  private stopped = false;

  constructor(
    private readonly sink: EventSink,
    private readonly cursor: StepCursor = {},
    private readonly idPrefix = "q",
  ) {}

  /** id of the question waiting for an answer */
  get waiting(): string | undefined {
    return this.pending?.id;
  }

  /** Stop: the pending question (and every later one) throws ExitPromptError. */
  cancel(): void {
    this.stopped = true;
    const p = this.pending;
    this.pending = undefined;
    p?.reject(exitPromptError());
  }

  answer(id: string, value: unknown): AnswerResult {
    const p = this.pending;
    if (!p || p.id !== id) return { ok: false, error: "That question is not waiting for an answer (any more).", status: 409 };
    const r = p.accept(value);
    if ("error" in r) {
      this.sink.emit({ type: "question_error", id, error: r.error });
      return { ok: false, error: r.error, status: 422 };
    }
    this.pending = undefined;
    this.sink.emit({ type: "answered", id });
    p.resolve(r.value);
    return { ok: true };
  }

  private ask<T>(
    kind: Kind,
    message: string,
    accept: Pending["accept"],
    extra: { choices?: { value: string; name: string; description?: string }[]; default?: string | boolean } = {},
  ): Promise<T> {
    if (this.stopped) return Promise.reject(exitPromptError());
    if (this.pending) this.pending.reject(new Error("superseded by another question"));
    const id = `${this.idPrefix}${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending = { id, kind, accept, resolve: resolve as (v: unknown) => void, reject };
      this.sink.emit({
        type: "question",
        id,
        kind,
        message: stripAnsi(message),
        ...(extra.choices ? { choices: extra.choices } : {}),
        ...(extra.default !== undefined ? { default: extra.default } : {}),
        ...(this.cursor.current ? { stepId: this.cursor.current } : {}),
      });
    });
  }

  input(o: { message: string; default?: string; validate?: (v: string) => true | string }): Promise<string> {
    return this.ask<string>(
      "input",
      o.message,
      (v) => {
        if (typeof v !== "string") return { error: "Expected text." };
        const value = v === "" && o.default !== undefined ? o.default : v;
        const ok = o.validate ? o.validate(value) : true;
        return ok === true ? { value } : { error: ok };
      },
      o.default !== undefined ? { default: o.default } : {},
    );
  }

  password(o: { message: string; validate?: (v: string) => true | string }): Promise<string> {
    // the value is never put into an event; only `answered` is sent
    return this.ask<string>("password", o.message, (v) => {
      if (typeof v !== "string") return { error: "Expected text." };
      const ok = o.validate ? o.validate(v) : true;
      return ok === true ? { value: v } : { error: ok };
    });
  }

  confirm(o: { message: string; default?: boolean }): Promise<boolean> {
    return this.ask<boolean>(
      "confirm",
      o.message,
      (v) => {
        if (typeof v === "boolean") return { value: v };
        if (typeof v === "string" && /^(y|yes|true|1)$/i.test(v)) return { value: true };
        if (typeof v === "string" && /^(n|no|false|0)$/i.test(v)) return { value: false };
        if (v === "" && o.default !== undefined) return { value: o.default };
        return { error: "Answer yes or no." };
      },
      { default: o.default ?? false },
    );
  }

  /** Choices go out with their index as the value ("0", "1", …) and map back by index. */
  select<T>(o: { message: string; choices: Choice<T>[]; default?: T }): Promise<T> {
    const def = o.default === undefined ? -1 : o.choices.findIndex((c) => c.value === o.default);
    return this.ask<T>(
      "select",
      o.message,
      (v) => {
        const i = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : -1;
        const c = o.choices[i];
        return c ? { value: c.value } : { error: "Pick one of the choices." };
      },
      {
        choices: o.choices.map((c, i) => ({
          value: String(i),
          name: stripAnsi(c.name),
          ...(c.description ? { description: stripAnsi(c.description) } : {}),
        })),
        ...(def >= 0 ? { default: String(def) } : {}),
      },
    );
  }
}
