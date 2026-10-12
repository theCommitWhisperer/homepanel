import { describe, expect, it, vi } from "vitest";
import { Assistant, PRESETS, testProvider, chatWithFallback, type ToolDef } from "../src/index.js";

type Scripted = { status?: number; body: unknown } | Error;

/** Fake fetch that returns scripted responses in order and records the request bodies. */
function fakeFetch(script: Scripted[]) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    const next = script.shift();
    if (!next) throw new Error("fake fetch: no more scripted responses");
    if (next instanceof Error) throw next;
    const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status ?? 200 });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const say = (content: string) => ({ body: { choices: [{ message: { role: "assistant", content } }] } });
const callTool = (name: string, args: unknown, id = "c1", content: string | null = null) => ({
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  },
});

const provider = { provider: "groq" as const, apiKey: "gsk_test" };

function tools() {
  const lookRun = vi.fn(async () => ({ lights: ["light.kitchen"] }));
  const actRun = vi.fn(async (a: { entity: string }) => ({ ok: true, toggled: a.entity }));
  const list: ToolDef[] = [
    {
      name: "list_lights",
      description: "List lights",
      parameters: { type: "object", properties: {} },
      kind: "look",
      run: lookRun,
    },
    {
      name: "toggle_light",
      description: "Toggle a light",
      parameters: { type: "object", properties: { entity: { type: "string" } }, required: ["entity"] },
      kind: "act",
      summarize: (a) => `Toggle ${a.entity}`,
      run: actRun,
    },
  ];
  return { list, lookRun, actRun };
}

describe("presets", () => {
  it("has all providers with sane defaults", () => {
    expect(Object.keys(PRESETS).sort()).toEqual(["custom", "gemini", "groq", "lmstudio", "ollama", "openrouter"]);
    expect(PRESETS.gemini.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai/");
    expect(PRESETS.ollama.needsKey).toBe(false);
    expect(PRESETS.openrouter.defaultModel).toBe("openrouter/free");
  });
});

describe("Assistant", () => {
  it("runs look tools automatically and returns the final answer", async () => {
    const f = fakeFetch([callTool("list_lights", {}), say("You have one light: kitchen.")]);
    const t = tools();
    const a = new Assistant({ provider, system: "sys", tools: t.list, fetchImpl: f.fetch });
    const r = await a.step([{ role: "user", content: "what lights?" }]);
    expect(r.error).toBeUndefined();
    expect(r.pending).toBeUndefined();
    expect(t.lookRun).toHaveBeenCalledOnce();
    expect(r.messages).toEqual([
      { role: "user", content: "what lights?" },
      { role: "assistant", content: "You have one light: kitchen." },
    ]);
    // second request carries the tool call + tool result
    expect(f.calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(f.calls[0]!.headers.authorization).toBe("Bearer gsk_test");
    expect(f.calls[0]!.body.tools).toHaveLength(2);
    const second = f.calls[1]!.body.messages;
    expect(second[0]).toEqual({ role: "system", content: "sys" });
    expect(second.at(-2).tool_calls[0].function.name).toBe("list_lights");
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(JSON.parse(second.at(-1).content)).toEqual({ lights: ["light.kitchen"] });
  });

  it("gates act tools behind approval", async () => {
    const f = fakeFetch([
      callTool("toggle_light", { entity: "light.kitchen" }, "c9", "I'll toggle it."),
      say("Done, the kitchen light is toggled."),
    ]);
    const t = tools();
    const a = new Assistant({ provider, system: "sys", tools: t.list, fetchImpl: f.fetch });
    const r = await a.step([{ role: "user", content: "toggle kitchen" }]);
    expect(r.pending).toEqual({ callId: "c9", tool: "toggle_light", summary: "Toggle light.kitchen" });
    expect(t.actRun).not.toHaveBeenCalled();
    expect(r.messages.at(-1)).toEqual({ role: "assistant", content: "I'll toggle it." });

    // stepping again without new messages does not call the model
    const again = await a.step(r.messages);
    expect(again.pending?.callId).toBe("c9");
    expect(f.calls).toHaveLength(1);

    const done = await a.approve("c9");
    expect(t.actRun).toHaveBeenCalledWith({ entity: "light.kitchen" });
    expect(done.pending).toBeUndefined();
    expect(done.messages.at(-1)!.content).toContain("Done");
    const toolMsg = f.calls[1]!.body.messages.at(-1);
    expect(toolMsg.role).toBe("tool");
    expect(JSON.parse(toolMsg.content)).toEqual({ ok: true, toggled: "light.kitchen" });
  });

  it("feeds 'User declined' back on reject", async () => {
    const f = fakeFetch([callTool("toggle_light", { entity: "light.x" }, "c2"), say("OK, I won't.")]);
    const t = tools();
    const a = new Assistant({ provider, system: "sys", tools: t.list, fetchImpl: f.fetch });
    const r = await a.step([{ role: "user", content: "toggle x" }]);
    const done = await a.reject(r.pending!.callId);
    expect(t.actRun).not.toHaveBeenCalled();
    const toolMsg = f.calls[1]!.body.messages.at(-1);
    expect(toolMsg).toMatchObject({ role: "tool", tool_call_id: "c2" });
    expect(toolMsg.content).toMatch(/^User declined/);
    expect(done.messages.at(-1)!.content).toBe("OK, I won't.");
  });

  it("approve with a wrong id is an error, not a crash", async () => {
    const a = new Assistant({ provider, system: "s", tools: [], fetchImpl: fakeFetch([]).fetch });
    const r = await a.approve("nope");
    expect(r.error).toMatch(/Nothing to approve/);
  });

  it("bounds the tool loop", async () => {
    const script = Array.from({ length: 20 }, (_, i) => callTool("list_lights", {}, `l${i}`));
    const f = fakeFetch(script);
    const t = tools();
    const a = new Assistant({ provider, system: "s", tools: t.list, fetchImpl: f.fetch });
    const r = await a.step([{ role: "user", content: "loop" }]);
    expect(t.lookRun).toHaveBeenCalledTimes(8);
    expect(f.calls).toHaveLength(9);
    expect(r.messages.at(-1)!.content).toMatch(/stopped after 8 tool steps/);
  });

  it("turns a 429 into a helpful error suggesting another provider", async () => {
    const f = fakeFetch([{ status: 429, body: { error: { message: "Rate limit reached" } } }]);
    const a = new Assistant({ provider, system: "s", tools: [], fetchImpl: f.fetch });
    const r = await a.step([{ role: "user", content: "hi" }]);
    expect(r.error).toMatch(/rate-limit/i);
    expect(r.error).toMatch(/another provider/);
    expect(r.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("falls back to the next provider on 429", async () => {
    const f = fakeFetch([{ status: 429, body: "slow down" }, say("hello from gemini")]);
    const a = new Assistant({
      provider: [provider, { provider: "gemini", apiKey: "AIza" }],
      system: "s",
      tools: [],
      fetchImpl: f.fetch,
    });
    const r = await a.step([{ role: "user", content: "hi" }]);
    expect(r.error).toBeUndefined();
    expect(f.calls[1]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(r.messages.at(-1)!.content).toBe("hello from gemini");
  });

  it("reports network errors and missing tool support", async () => {
    const net = fakeFetch([Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })]);
    const a = new Assistant({ provider: { provider: "ollama" }, system: "s", tools: [], fetchImpl: net.fetch });
    const r = await a.step([{ role: "user", content: "hi" }]);
    expect(r.error).toMatch(/Could not reach Ollama.*ECONNREFUSED/);
    expect(r.error).toMatch(/ollama serve/);

    const nt = fakeFetch([{ status: 400, body: { error: { message: "model llama2 does not support tools" } } }]);
    const b = new Assistant({ provider: { provider: "ollama", model: "llama2" }, system: "s", tools: [], fetchImpl: nt.fetch });
    const r2 = await b.step([{ role: "user", content: "hi" }]);
    expect(r2.error).toMatch(/does not seem to support tool calling/);
  });

  it("reports malformed tool arguments back to the model and continues", async () => {
    const t = tools();
    const bad = {
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "m1", type: "function", function: { name: "toggle_light", arguments: "{entity: light.k" } }],
            },
          },
        ],
      },
    };
    const f = fakeFetch([bad, say("Sorry, which light?")]);
    const a = new Assistant({ provider, system: "s", tools: t.list, fetchImpl: f.fetch });
    const r = await a.step([{ role: "user", content: "toggle kitchen" }]);
    expect(r.pending).toBeUndefined();
    expect(t.actRun).not.toHaveBeenCalled();
    const toolMsg = f.calls[1]!.body.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("m1");
    expect(toolMsg.content).toMatch(/Invalid JSON arguments/);
    expect(r.messages.at(-1)!.content).toBe("Sorry, which light?");
  });

  it("falls back to plain chat when the model has no tool support", async () => {
    const t = tools();
    const f = fakeFetch([
      { status: 400, body: { error: { message: "registry.ollama.ai/library/llama2 does not support tools" } } },
      say("Open Settings and add the integration."),
    ]);
    const a = new Assistant({ provider: { provider: "ollama", model: "llama2" }, system: "sys", tools: t.list, fetchImpl: f.fetch });
    const r = await a.step([{ role: "user", content: "help" }]);
    expect(r.error).toBeUndefined();
    expect(f.calls[1]!.body.tools).toBeUndefined();
    expect(f.calls[1]!.body.messages[0].content).toMatch(/tools are unavailable/);
    expect(r.messages.some((m) => /does not support tool calling/.test(m.content))).toBe(true);
    expect(r.messages.at(-1)!.content).toBe("Open Settings and add the integration.");
  });

  it("missing API key is a config error", async () => {
    const a = new Assistant({ provider: { provider: "gemini" }, system: "s", tools: [], fetchImpl: fakeFetch([]).fetch });
    const r = await a.step([{ role: "user", content: "hi" }]);
    expect(r.error).toMatch(/needs an API key.*aistudio/);
  });

  it("applies the redact hook to everything sent to the model", async () => {
    const f = fakeFetch([callTool("list_lights", {}), say("ok")]);
    const t = tools();
    t.lookRun.mockResolvedValueOnce({ token: "SECRET123" } as any);
    const a = new Assistant({
      provider,
      system: "s",
      tools: t.list,
      fetchImpl: f.fetch,
      redact: (s) => s.replaceAll("SECRET123", "$SECRET_1"),
    });
    await a.step([{ role: "user", content: "my pw is SECRET123" }]);
    const sent = JSON.stringify(f.calls.map((c) => c.body));
    expect(sent).not.toContain("SECRET123");
    expect(sent).toContain("$SECRET_1");
  });

  it("restarts cleanly when given a different transcript", async () => {
    const f = fakeFetch([say("one"), say("two")]);
    const a = new Assistant({ provider, system: "s", tools: [], fetchImpl: f.fetch });
    await a.step([{ role: "user", content: "a" }]);
    const r = await a.step([{ role: "user", content: "b" }]);
    expect(r.messages).toEqual([
      { role: "user", content: "b" },
      { role: "assistant", content: "two" },
    ]);
    expect(f.calls[1]!.body.messages).toHaveLength(2);
  });
});

describe("testProvider / fallback", () => {
  it("ok and error cases", async () => {
    expect(await testProvider(provider, fakeFetch([say("OK")]).fetch)).toEqual({ ok: true });
    const bad = await testProvider(provider, fakeFetch([{ status: 401, body: "bad key" }]).fetch);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/rejected the API key/);
  });
  it("does not fall back on auth errors", async () => {
    const f = fakeFetch([{ status: 401, body: "no" }, say("never")]);
    await expect(
      chatWithFallback([provider, { provider: "ollama" }], { messages: [{ role: "user", content: "x" }] }, f.fetch),
    ).rejects.toThrow(/rejected/);
    expect(f.calls).toHaveLength(1);
  });
});
