#!/usr/bin/env node
import { aiGuide, chooseProvider } from "./ai-guide.js";
import { makeContext } from "./context.js";
import { doctor } from "./doctor.js";
import { StateStore } from "./state.js";
import { ALL_STEPS } from "./steps/index.js";
import { color, consoleOut, inquirerPrompter } from "./ui.js";
import { plainWizard } from "./wizard.js";
import { SCREEN_GUIDES } from "./guides.js";
import { pairUrl } from "./steps/extras.js";
import { adminLogin, agentYaml, registerAgent } from "./steps/pcs.js";
import { homepanelHome } from "./state.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = "0.1.0";

const HELP = `${color.bold("homepanel")} ${VERSION} — set up HomePanel and Home Assistant

Usage:
  homepanel setup [--ai | --plain] [--step <id>] [--redo] [--reset]
  homepanel agent-key <pcId> [--name <name>] [--mac <aa:bb:..>]
  homepanel screens [ipad|fire-hd8|android|pi|windows]
  homepanel doctor
  homepanel steps
  homepanel --help | --version

setup     Guided setup. Asks whether you want an AI guide (Gemini/Groq/OpenRouter free,
          Ollama/LM Studio local) or the plain wizard. Progress is saved in
          ~/.homepanel/setup-state.json, so you can stop and resume any time.
            --step <id>  run one step only (see \`homepanel steps\`)
            --redo       run steps even if they look done
            --ai         go straight to the AI guide (pick a provider)
            --plain      skip the AI question
            --reset      forget saved progress (secrets are kept)
agent-key Register a PC with the HomePanel server (admin API) and write its agent.yaml.
screens   Print setup steps for a screen (iPad, Fire HD 8, Android, Pi, Windows).
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
  if (cmd === "screens") {
    const store = new StateStore();
    const u = pairUrl({ store });
    const which = rest[0];
    const keys = which ? [which] : Object.keys(SCREEN_GUIDES);
    for (const k of keys) {
      const g = SCREEN_GUIDES[k];
      if (!g) {
        out.err(`Unknown screen "${k}". Choose: ${Object.keys(SCREEN_GUIDES).join(", ")}`);
        return 2;
      }
      out.heading(g.title);
      out.steps(g.steps(u));
    }
    out.line();
    out.info(`Pairing URL: ${u}   Approve codes at: ${u}/admin`);
    return 0;
  }
  if (cmd === "agent-key") {
    const pcId = rest[0];
    if (!pcId || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(pcId)) {
      out.err("Usage: homepanel agent-key <pcId>   (lowercase letters, digits, dashes, e.g. gaming-pc)");
      return 2;
    }
    const store = new StateStore();
    const prompt = await inquirerPrompter();
    const serverUrl =
      store.state.serverUrl ?? (await prompt.input({ message: "HomePanel server URL:", default: "http://homeassistant.local:8080" }));
    const password = store.secrets.adminPassword ?? (await prompt.password({ message: "HomePanel admin password (hidden):" }));
    const name = argValue(rest, "--name") ?? pcId;
    const mac = argValue(rest, "--mac");
    const session = await adminLogin(fetch, serverUrl.replace(/\/+$/, ""), password);
    const r = await registerAgent(fetch, serverUrl.replace(/\/+$/, ""), session, { pcId, name, ...(mac ? { mac } : {}) });
    const m = store.state.mqtt;
    const host = m && m.host !== "127.0.0.1" ? m.host : new URL(serverUrl).hostname;
    const yaml = agentYaml({
      pcId,
      name,
      mqttUrl: `mqtt://${host}:${m?.port ?? 1883}`,
      mqttUser: m?.username ?? "homepanel",
      mqttPass: store.secrets.mqttPassword,
      key: r.key,
    });
    mkdirSync(homepanelHome(), { recursive: true });
    const file = join(homepanelHome(), `agent-${pcId}.yaml`);
    writeFileSync(file, yaml, { mode: 0o600 });
    store.update({ agents: [...(store.state.agents ?? []).filter((a) => a.pcId !== pcId), { pcId, name }] });
    out.ok(`Registered ${pcId}. Key: ${r.key}`);
    out.ok(`Wrote ${file} — copy it to C:\\ProgramData\\HomePanel\\agent.yaml on that PC (see apps/agent/README.md).`);
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
      if (rest.includes("--ai")) out.info("AI guide mode. You can switch to the plain wizard any time by typing 'wizard'.");
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
