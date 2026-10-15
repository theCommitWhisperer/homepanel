import { getStep, stepsFor } from "./steps/index.js";
import type { Step, StepContext } from "./steps/types.js";
import type { StepStatus } from "./state.js";
import { beforeFromStep, hooks } from "./bridge/hooks.js";

/** Run one step with detect → run → record. Returns the final status. */
export async function runStep(ctx: StepContext, step: Step, opts: { force?: boolean } = {}): Promise<StepStatus> {
  const { out, store } = ctx;
  const h = hooks();
  out.heading(step.title);
  if (!opts.force) {
    h.step?.(step.id, "checking");
    let d;
    try {
      d = await step.detect(ctx);
    } catch (e) {
      d = { done: false, detail: (e as Error).message };
    }
    if (d.done) {
      out.ok(d.detail);
      store.mark(step.id, "done", d.detail);
      h.step?.(step.id, "done", d.detail);
      return "done";
    }
    out.info(d.detail);
  }
  h.step?.(step.id, "running");
  let status: StepStatus;
  try {
    status = await step.run(ctx);
  } catch (e) {
    const err = e as Error;
    if (err.name === "ExitPromptError") {
      h.step?.(step.id, "failed", "Stopped.");
      throw e; // Ctrl+C
    }
    out.err(`${step.title} failed: ${err.message}`);
    status = "failed";
  }
  store.mark(step.id, status);
  h.step?.(step.id, status);
  return status;
}

/** The plain, deterministic wizard. Resumes from setup-state.json. */
export async function plainWizard(ctx: StepContext, opts: { only?: string; redo?: boolean } = {}): Promise<number> {
  const { out, prompt, store } = ctx;
  if (opts.only) {
    const s = getStep(opts.only);
    if (!s) {
      out.err(`Unknown step "${opts.only}".`);
      return 2;
    }
    const st = await runStep(ctx, s, { force: opts.redo });
    return st === "failed" ? 1 : 0;
  }

  const done = Object.entries(store.state.steps).filter(([, v]) => v.status === "done" || v.status === "skipped");
  if (done.length) out.info(`Resuming — already done: ${done.map(([k]) => k).join(", ")}`);

  const h = hooks();
  let planned = "";
  const handled = new Set<string>();
  for (;;) {
    // recompute: the host step can change the list
    const list = stepsFor(store.state.hostType);
    const ids = list.map((s) => s.id);
    if (h.steps && ids.join() !== planned) {
      planned = ids.join();
      h.steps(list.map((s) => ({ id: s.id, title: s.title, summary: s.summary })));
      for (const id of handled) if (ids.includes(id) && store.isDone(id)) h.step?.(id, "done");
    }
    const next = list.find((s) => !handled.has(s.id));
    if (!next) break;
    handled.add(next.id);
    if (beforeFromStep(ids, next.id, h.fromStep)) {
      h.step?.(next.id, store.isDone(next.id) ? "done" : "skipped", store.isDone(next.id) ? "Done earlier." : "Not part of this run (started at a later step).");
      continue;
    }
    if (store.isDone(next.id) && !opts.redo) {
      out.ok(`${next.title} — done earlier`);
      h.step?.(next.id, "done", "Done earlier.");
      continue;
    }
    h.step?.(next.id, "checking", next.summary);
    out.line();
    const what = await prompt.select({
      message: `${next.title}: ${next.summary}`,
      choices: [
        { value: "run", name: "Do it" },
        { value: "skip", name: "Skip for now" },
        { value: "quit", name: "Quit (progress is saved)" },
      ],
    });
    if (what === "quit") {
      out.info("Saved. Run `homepanel setup` again to continue.");
      return 0;
    }
    if (what === "skip") {
      out.info("Skipped. It stays on the list for next time.");
      h.step?.(next.id, "skipped", "Skipped. It stays on the list for next time.");
      continue;
    }
    for (;;) {
      const st = await runStep(ctx, next);
      if (st !== "failed") break;
      const again = await prompt.select({
        message: "That step failed. What now?",
        choices: [
          { value: "retry", name: "Try again" },
          { value: "skip", name: "Skip it" },
          { value: "quit", name: "Quit" },
        ],
      });
      if (again === "quit") return 1;
      if (again === "skip") break;
    }
  }
  h.endSteps?.();
  out.line();
  out.heading("Finished");
  const s = store.state;
  if (s.serverUrl) out.ok(`HomePanel: ${s.serverUrl}   Admin: ${s.serverUrl}/admin`);
  if (s.haUrl) out.ok(`Home Assistant: ${s.haUrl}`);
  out.info("Check everything any time with `homepanel doctor`.");
  return 0;
}
