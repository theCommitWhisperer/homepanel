import pc from "picocolors";

/** Everything the wizard prints goes through Out so tests can capture it. */
export interface Out {
  line(text?: string): void;
  heading(text: string): void;
  info(text: string): void;
  ok(text: string): void;
  warn(text: string): void;
  err(text: string): void;
  /** a command or file the user may copy; printed indented, never wrapped */
  code(text: string): void;
  /** numbered list of instructions */
  steps(items: string[]): void;
}

export function consoleOut(write: (s: string) => void = (s) => process.stdout.write(s)): Out {
  const w = (s = "") => write(s + "\n");
  return {
    line: w,
    heading: (t) => w("\n" + pc.bold(pc.cyan("== " + t + " =="))),
    info: (t) => w(pc.dim("·") + " " + t),
    ok: (t) => w(pc.green("✔") + " " + t),
    warn: (t) => w(pc.yellow("!") + " " + pc.yellow(t)),
    err: (t) => w(pc.red("✖") + " " + pc.red(t)),
    code: (t) => w(t.split("\n").map((l) => "    " + pc.cyan(l)).join("\n")),
    steps: (items) => items.forEach((s, i) => w(`  ${pc.bold(String(i + 1) + ".")} ${s}`)),
  };
}

/** Output collector for tests / AI tool results. */
export function memoryOut(): Out & { text(): string } {
  const lines: string[] = [];
  const o: Out & { text(): string } = {
    line: (t = "") => lines.push(t),
    heading: (t) => lines.push(`== ${t} ==`),
    info: (t) => lines.push(`· ${t}`),
    ok: (t) => lines.push(`OK ${t}`),
    warn: (t) => lines.push(`WARN ${t}`),
    err: (t) => lines.push(`ERR ${t}`),
    code: (t) => lines.push(t.split("\n").map((l) => "    " + l).join("\n")),
    steps: (items) => items.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`)),
    text: () => lines.join("\n"),
  };
  return o;
}

/** Fan-out: print to the console and also collect (used when the AI runs a step). */
export function teeOut(a: Out, b: Out): Out {
  const keys = ["line", "heading", "info", "ok", "warn", "err", "code", "steps"] as const;
  const o = {} as Out;
  for (const k of keys) (o as any)[k] = (x: any) => ((a as any)[k](x), (b as any)[k](x));
  return o;
}

export interface Choice<T> {
  value: T;
  name: string;
  description?: string;
}

/** Interactive prompts. Real implementation uses @inquirer/prompts; tests use scriptedPrompter. */
export interface Prompter {
  input(o: { message: string; default?: string; validate?: (v: string) => true | string }): Promise<string>;
  password(o: { message: string; validate?: (v: string) => true | string }): Promise<string>;
  confirm(o: { message: string; default?: boolean }): Promise<boolean>;
  select<T>(o: { message: string; choices: Choice<T>[]; default?: T }): Promise<T>;
}

export async function inquirerPrompter(): Promise<Prompter> {
  const p = await import("@inquirer/prompts");
  return {
    input: (o) => p.input({ message: o.message, default: o.default, validate: o.validate }),
    password: (o) => p.password({ message: o.message, mask: "*", validate: o.validate }),
    confirm: (o) => p.confirm({ message: o.message, default: o.default ?? false }),
    select: <T>(o: { message: string; choices: Choice<T>[]; default?: T }) =>
      p.select<T>({ message: o.message, choices: o.choices, default: o.default, pageSize: 12 }),
  };
}

/**
 * Prompter driven by a list of answers (tests). Answers are consumed in order; a function answer
 * receives the prompt message. Throws when it runs out, so tests fail loudly on unexpected prompts.
 */
export function scriptedPrompter(answers: (string | boolean | ((msg: string) => unknown))[]): Prompter & {
  asked: string[];
} {
  const asked: string[] = [];
  const next = (msg: string): any => {
    asked.push(msg);
    if (!answers.length) throw new Error(`scriptedPrompter: no answer left for "${msg}"`);
    const a = answers.shift()!;
    return typeof a === "function" ? a(msg) : a;
  };
  return {
    asked,
    input: async (o) => {
      const v = next(o.message);
      return v === "" && o.default !== undefined ? o.default : String(v);
    },
    password: async (o) => String(next(o.message)),
    confirm: async (o) => Boolean(next(o.message)),
    select: async (o) => {
      const v = next(o.message);
      const c = o.choices.find((c) => c.value === v || c.name === v);
      if (!c) throw new Error(`scriptedPrompter: "${String(v)}" is not a choice for "${o.message}"`);
      return c.value;
    },
  };
}

export const color = pc;
