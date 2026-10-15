import { Assistant, PRESETS, testProvider, type ProviderConfig, type ProviderId, type ToolDef } from "@homepanel/ai";
import type { ChatMessage } from "@homepanel/protocol";
import { GUIDE_TOPICS, readGuide } from "./guides.js";
import { findHomeAssistant } from "./ha/discover.js";
import { HaClient } from "./ha/client.js";
import { getStep, READ_ONLY_STEPS, STEP_IDS, stepsFor } from "./steps/index.js";
import type { StepContext } from "./steps/types.js";
import { systemInfo } from "./sys.js";
import { color, memoryOut, teeOut } from "./ui.js";
import { runStep } from "./wizard.js";
import { healthSummary } from "./steps/finish.js";
import { hooks } from "./bridge/hooks.js";

export const SYSTEM_PROMPT = `You are the HomePanel setup guide, running inside the \`homepanel setup\` command on the user's computer.
HomePanel is a self-hosted dashboard for wall tablets and screens, built on Home Assistant (HA).
You help the user: install Home Assistant (HA OS on a mini PC / Raspberry Pi / HA Green / VM, or HA Container with Docker),
onboard it, add MQTT (Mosquitto), install the HomePanel server, set up Zigbee (ZBT-1), doorbells (Reolink/Eufy),
Tailscale remote access, screens (iPad, Fire HD 8, Android, Pi, Windows) and PC monitoring agents.

How to work:
- Be friendly, short and concrete. Plain language, no jargon without a one-line explanation. One topic at a time.
- Use the look tools (system_info, scan_network, check_ha, check_mqtt, read_state, explain_step, open_guide) freely to find out where things stand before advising.
- The setup is made of steps: ${STEP_IDS.join(", ")}. To actually do a step, call run_step(step_id). The user sees exactly what it will do and must approve. Steps ask their own questions in the terminal (names, IPs, hidden passwords) — tell the user to answer there.
- NEVER ask the user to type passwords, tokens or API keys into the chat. If you need one, call ask_secret(label); it prompts locally with hidden input and gives you only a placeholder like $SECRET_1. Steps ask for their own secrets, so you rarely need ask_secret.
- If the user pastes something that looks like a secret anyway, tell them it is redacted and they should rotate it if it was sensitive.
- Never invent facts (IP addresses, versions, whether something is installed). Check with a tool first; if no tool can tell, say you don't know and point to open_guide.
- Stay on HomePanel / Home Assistant setup. Politely decline unrelated requests.
- Keep replies under about 120 words unless the user asks for detail.
- After a step runs, summarise the result in one or two sentences and suggest the next step.`;

export interface GuideOptions {
  provider: ProviderConfig | ProviderConfig[];
  fetchImpl?: typeof fetch;
}

/** Build the tools the setup agent can call. */
export function guideTools(ctx: StepContext): ToolDef[] {
  const stepEnum = { type: "string", enum: STEP_IDS };
  return [
    {
      name: "system_info",
      description: "Facts about the computer the installer runs on (OS, CPU, RAM, LAN IPs).",
      parameters: { type: "object", properties: {} },
      kind: "look",
      run: async () => systemInfo(),
    },
    {
      name: "scan_network",
      description: "Look for Home Assistant on the local network (mDNS + homeassistant.local + optional extra host).",
      parameters: { type: "object", properties: { extra_host: { type: "string", description: "IP or URL to probe too" } } },
      kind: "look",
      run: async (a: { extra_host?: string }) =>
        findHomeAssistant({ fetchImpl: ctx.fetchImpl, extra: a?.extra_host ? [a.extra_host] : [] }),
    },
    {
      name: "check_ha",
      description: "Check a Home Assistant URL: reachable? onboarding done? saved token valid?",
      parameters: { type: "object", properties: { url: { type: "string" } } },
      kind: "look",
      run: async (a: { url?: string }) => {
        const url = a?.url || ctx.store.state.haUrl;
        if (!url) return { error: "No URL given and none saved." };
        const c = new HaClient(url, { fetchImpl: ctx.fetchImpl, token: ctx.store.secrets.haToken });
        const s = await c.onboardingStatus();
        return { url: c.url, status: s, tokenValid: ctx.store.secrets.haToken ? await c.apiOk() : "no token saved" };
      },
    },
    {
      name: "check_mqtt",
      description: "Check MQTT: is the HA MQTT integration set up and loaded, is a broker login saved, does the HomePanel server see MQTT.",
      parameters: { type: "object", properties: {} },
      kind: "look",
      run: async () => {
        const h = await healthSummary(ctx);
        return {
          haMqttIntegration: h.mqtt.integration,
          brokerLoginSaved: !!ctx.store.secrets.mqttPassword,
          broker: ctx.store.state.mqtt ?? "unknown",
          serverMqtt: h.server ? (h.server.mqtt ?? h.server.error) : "server address unknown",
          haError: h.ha.error,
        };
      },
    },
    {
      name: "read_state",
      description: "Saved setup progress: host type, addresses, which steps are done, and the step order for this host.",
      parameters: { type: "object", properties: {} },
      kind: "look",
      run: async () => ({
        ...ctx.store.state,
        stepOrder: stepsFor(ctx.store.state.hostType).map((s) => s.id),
        secretsSaved: Object.keys(ctx.store.secrets).filter((k) => (ctx.store.secrets as any)[k]),
      }),
    },
    {
      name: "explain_step",
      description: "What a setup step does, what it changes, and whether it is already done.",
      parameters: { type: "object", properties: { step_id: stepEnum }, required: ["step_id"] },
      kind: "look",
      run: async (a: { step_id: string }) => {
        const s = getStep(a.step_id);
        if (!s) return { error: `Unknown step. Steps: ${STEP_IDS.join(", ")}` };
        const d = await s.detect(ctx).catch((e: Error) => ({ done: false, detail: e.message }));
        return { id: s.id, title: s.title, explain: s.explain, willDo: s.plan(ctx), status: d, saved: ctx.store.state.steps[s.id] };
      },
    },
    {
      name: "open_guide",
      description: "Read a HomePanel guide (markdown).",
      parameters: { type: "object", properties: { topic: { type: "string", enum: Object.keys(GUIDE_TOPICS) } }, required: ["topic"] },
      kind: "look",
      run: async (a: { topic: string }) => readGuide(ctx.repoRoot, a.topic),
    },
    {
      name: "ask_secret",
      description:
        "Ask the user for a secret (password, token, API key) with a hidden local prompt. Returns a placeholder like $SECRET_1; the real value never reaches you.",
      parameters: { type: "object", properties: { label: { type: "string", description: "e.g. 'Reolink password'" } }, required: ["label"] },
      kind: "look",
      run: async (a: { label: string }) => {
        const label = String(a?.label || "secret").slice(0, 60);
        ctx.out.line();
        ctx.out.info(color.bold(`The guide asks for: ${label}`) + " (typed here, hidden, never sent to the AI)");
        const v = await ctx.prompt.password({ message: `${label}:` });
        const ph = ctx.vault.add(label, v);
        ctx.store.secrets.extra = { ...(ctx.store.secrets.extra ?? {}), [label]: v };
        ctx.store.saveSecrets();
        return `stored as ${ph}`;
      },
    },
    {
      name: "run_step",
      description: "Run a setup step. The user must approve. The step may ask the user questions in the terminal.",
      parameters: {
        type: "object",
        properties: { step_id: stepEnum, redo: { type: "boolean", description: "run even if already done" } },
        required: ["step_id"],
      },
      kind: "act",
      summarize: (a: { step_id: string; redo?: boolean }) => {
        const s = getStep(a?.step_id);
        if (!s) throw new Error(`Unknown step "${a?.step_id}". Steps: ${STEP_IDS.join(", ")}`);
        const ro = READ_ONLY_STEPS.has(s.id) ? " (read-only)" : "";
        return `Run step "${s.title}"${ro}${a.redo ? " again" : ""}: ${s.plan(ctx)}`;
      },
      run: async (a: { step_id: string; redo?: boolean }) => {
        const s = getStep(a.step_id)!;
        const mem = memoryOut();
        const sub: StepContext = { ...ctx, out: teeOut(ctx.out, mem), viaAi: true };
        const status = await runStep(sub, s, { force: !!a.redo });
        const log = mem.text();
        return { status, output: log.length > 6000 ? log.slice(-6000) : log };
      },
    },
  ];
}

/** Ask which provider to use. Returns undefined for "plain wizard". */
export async function chooseProvider(ctx: StepContext, fetchImpl?: typeof fetch): Promise<ProviderConfig | undefined> {
  const { prompt, out, store } = ctx;
  const choice = await prompt.select<ProviderId | "none">({
    message: "Use an AI guide?",
    choices: [
      { value: "gemini", name: "Gemini (free, Google account)", description: PRESETS.gemini.notes },
      { value: "groq", name: "Groq (free)", description: PRESETS.groq.notes },
      { value: "openrouter", name: "OpenRouter (free models)", description: PRESETS.openrouter.notes },
      { value: "ollama", name: "Ollama (local, private)", description: PRESETS.ollama.notes },
      { value: "lmstudio", name: "LM Studio (local, private)", description: PRESETS.lmstudio.notes },
      { value: "none", name: "No, plain wizard" },
    ],
    default: (store.state.ai?.provider as ProviderId | undefined) ?? "none",
  });
  if (choice === "none") return undefined;
  const preset = PRESETS[choice];
  out.info(preset.notes);
  const cfg: ProviderConfig = { provider: choice };
  if (choice === "ollama" || choice === "lmstudio") {
    cfg.baseUrl = await prompt.input({ message: "Server URL:", default: store.state.ai?.baseUrl ?? preset.baseUrl });
  }
  cfg.model = await prompt.input({ message: "Model:", default: store.state.ai?.model ?? preset.defaultModel });
  if (preset.needsKey) {
    const saved = store.secrets.extra?.ai_api_key;
    if (saved && store.state.ai?.provider === choice) cfg.apiKey = saved;
    else {
      out.info(`Get a free key at ${preset.keyUrl}`);
      cfg.apiKey = await prompt.password({ message: `${preset.label} API key (hidden):` });
    }
    ctx.vault.add("ai_api_key", cfg.apiKey);
  }
  out.info("Checking the AI provider…");
  const t = await testProvider(cfg, fetchImpl);
  if (!t.ok) {
    out.err(t.error ?? "provider test failed");
    return (await prompt.confirm({ message: "Try a different provider?", default: true })) ? chooseProvider(ctx, fetchImpl) : undefined;
  }
  out.ok("AI guide connected.");
  store.update({ ai: { provider: choice, model: cfg.model, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}) } });
  if (cfg.apiKey) {
    store.secrets.extra = { ...(store.secrets.extra ?? {}), ai_api_key: cfg.apiKey };
    store.saveSecrets();
  }
  return cfg;
}

/** Interactive chat loop. Type 'exit' to leave, 'wizard' to switch to the plain wizard. */
export async function aiGuide(ctx: StepContext, opts: GuideOptions): Promise<"exit" | "wizard"> {
  const { out, prompt } = ctx;
  const h = hooks();
  const assistant = new Assistant({
    provider: opts.provider,
    system: SYSTEM_PROMPT,
    tools: guideTools(ctx),
    fetchImpl: opts.fetchImpl,
    redact: ctx.vault.redact,
  });
  let messages: ChatMessage[] = [];
  out.line();
  out.info("Chat with the guide. Type 'wizard' for the plain wizard, 'exit' to stop. Progress is saved either way.");
  let printed = 0;
  const show = (msgs: ChatMessage[]) => {
    for (const m of msgs.slice(printed))
      if (m.role === "assistant") {
        if (h.ai) h.ai("assistant", m.content);
        else out.line(`\n${color.magenta("guide")} ${m.content}\n`);
      }
    printed = msgs.length;
  };

  // kick off with context
  let reply = await assistant.step([
    {
      role: "user",
      content:
        "Hi! Please look at my setup progress (read_state) and tell me briefly where we are and what you suggest next.",
    },
  ]);
  for (;;) {
    messages = reply.messages;
    show(messages);
    if (reply.error) {
      out.err(reply.error);
      const next = await prompt.select({
        message: "The AI guide hit a problem. What now?",
        choices: [
          { value: "wizard", name: "Continue with the plain wizard (recommended)" },
          { value: "retry", name: "Keep chatting / try again" },
          { value: "exit", name: "Stop (progress is saved)" },
        ],
      });
      if (next === "wizard" || next === "exit") return next;
    }
    if (reply.pending) {
      h.ai?.("tool", reply.pending.summary);
      out.line(color.bold(color.yellow("The guide wants to:")));
      out.line("  " + reply.pending.summary);
      const yes = await prompt.confirm({ message: "Go ahead? (y/N)", default: false });
      reply = yes ? await assistant.approve(reply.pending.callId) : await assistant.reject(reply.pending.callId);
      continue;
    }
    const text = (h.chat ? await h.chat() : await prompt.input({ message: color.cyan("you") })).trim();
    if (!text) continue;
    if (/^(exit|quit|bye)$/i.test(text)) return "exit";
    if (/^wizard$/i.test(text)) return "wizard";
    reply = await assistant.step([...messages, { role: "user", content: text }]);
  }
}
