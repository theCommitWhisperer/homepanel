#!/usr/bin/env node
import { aiGuide, chooseProvider } from "./ai-guide.js";
import { makeContext } from "./context.js";
import { doctor } from "./doctor.js";
import { StateStore } from "./state.js";
import { ALL_STEPS } from "./steps/index.js";
import { color, consoleOut, inquirerPrompter } from "./ui.js";
import { plainWizard } from "./wizard.js";

const VERSION = "0.1.0";

const HELP = `${color.bold("homepanel")} ${VERSION} — set up HomePanel and Home Assistant

Usage:
  homepanel setup [--step <id>] [--redo] [--plain] [--reset]
  homepanel doctor
  homepanel steps
  homepanel --help | --version

setup     Guided setup. Asks whether you want an AI guide (Gemini/Groq/OpenRouter free,
          Ollama/LM Studio local) or the plain wizard. Progress is saved in
          ~/.homepanel/setup-state.json, so you can stop and resume any time.
            --step <id>  run one step only (see \`homepanel steps\`)
            --redo       run steps even if they look done
            --plain      skip the AI question
            --reset      forget saved progress (secrets are kept)
doctor    Check Home Assistant, the token, MQTT, the HomePanel server and PC agents.
steps     List the setup steps.

Environment: HOMEPANEL_HOME (state dir, default ~/.homepanel)
`;

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const out = consoleOut();
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    out.line(HELP);
    return cmd ? 0 : 1;
  }
  if (cmd === "--version" || cmd === "-v") {
    out.line(VERSION);
    return 0;
  }
  if (cmd === "steps") {
    for (const s of ALL_STEPS) out.line(`  ${color.bold(s.id.padEnd(10))} ${s.title} — ${s.summary}`);
    return 0;
  }
  if (cmd === "doctor") {
    const store = new StateStore();
    return doctor(store, out);
  }
  if (cmd === "setup") {
    const store = new StateStore();
    if (rest.includes("--reset")) {
      store.reset();
      out.ok("Progress cleared.");
    }
    const prompt = await inquirerPrompter();
    const ctx = makeContext({ store, out, prompt });
    out.line(color.bold(color.cyan("\nHomePanel setup")));
    out.info(`Progress file: ${store.statePath}`);
    const only = argValue(rest, "--step");
    const redo = rest.includes("--redo");
    if (only) return plainWizard(ctx, { only, redo });
    if (!rest.includes("--plain")) {
      const provider = await chooseProvider(ctx);
      if (provider) {
        const r = await aiGuide(ctx, { provider });
        if (r === "exit") {
          out.info("Bye! Run `homepanel setup` again to continue, or `homepanel doctor` to check things.");
          return 0;
        }
      }
    }
    return plainWizard(ctx, { redo });
  }
  out.err(`Unknown command "${cmd}".`);
  out.line(HELP);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    if (e?.name === "ExitPromptError") {
      process.stdout.write("\nStopped. Progress is saved.\n");
      process.exit(130);
    }
    process.stderr.write(color.red(`homepanel: ${e?.stack ?? e}\n`));
    process.exit(1);
  },
);
