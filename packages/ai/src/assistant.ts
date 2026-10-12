import type { AssistantReply, ChatMessage, PendingApproval } from "@homepanel/protocol";
import { AiError, chatWithFallback, type WireMessage, type WireTool, type WireToolCall } from "./client.js";
import type { ProviderConfig } from "./presets.js";

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema object */
  parameters: Record<string, unknown>;
  /** look = read-only, build = produces a draft without side effects, act = changes something (needs approval) */
  kind: "look" | "act" | "build";
  /** for act: exact human-readable description of the change */
  summarize?(args: any): string;
  run(args: any): Promise<unknown>;
}

export interface AssistantOptions {
  /** one provider, or a fallback chain tried in order on rate limits / network errors */
  provider: ProviderConfig | ProviderConfig[];
  system: string;
  tools: ToolDef[];
  fetchImpl?: typeof fetch;
  /** max model round-trips that end in tool calls per step/approve/reject (default 8) */
  maxToolRounds?: number;
  /** applied to every string sent to the model (last line of defence against leaking secrets) */
  redact?: (text: string) => string;
  /** max characters of a single tool result sent back to the model (default 12000) */
  maxToolResultChars?: number;
}

interface PendingState {
  call: WireToolCall;
  args: unknown;
  summary: string;
  /** tool calls from the same assistant message still waiting to be answered */
  queue: WireToolCall[];
}

const DECLINED = "User declined. Do not retry this action unless the user asks again.";

/** Remove <think>…</think> blocks some local reasoning models put in content. */
function cleanVisible(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function sameMsg(a: ChatMessage, b: ChatMessage) {
  return a.role === b.role && a.content === b.content;
}

/**
 * Chat assistant with tool calling and approval gating.
 *
 * Keeps the full transcript (including tool calls/results) internally; callers only ever see
 * user/assistant text in `AssistantReply.messages`.
 */
export class Assistant {
  private providers: ProviderConfig[];
  private system: string;
  private tools: Map<string, ToolDef>;
  private fetchImpl?: typeof fetch;
  private maxRounds: number;
  private maxResult: number;
  private redact: (s: string) => string;

  private internal: WireMessage[] = [];
  private visible: ChatMessage[] = [];
  private pending?: PendingState;
  /** set when the provider rejected tool calling: we continue as plain chat */
  private plainChat = false;

  constructor(opts: AssistantOptions) {
    this.providers = Array.isArray(opts.provider) ? opts.provider : [opts.provider];
    this.system = opts.system;
    this.tools = new Map(opts.tools.map((t) => [t.name, t]));
    this.fetchImpl = opts.fetchImpl;
    this.maxRounds = opts.maxToolRounds ?? 8;
    this.maxResult = opts.maxToolResultChars ?? 12_000;
    this.redact = opts.redact ?? ((s) => s);
  }

  /** Current pending approval, if any. */
  get pendingApproval(): PendingApproval | undefined {
    return this.pending ? this.toPending(this.pending) : undefined;
  }

  /**
   * Send the (visible) transcript. New messages since the last reply are appended to the internal
   * transcript; if the caller's transcript does not extend ours, we start over from it.
   */
  async step(messages: ChatMessage[]): Promise<AssistantReply> {
    const extendsOurs =
      messages.length >= this.visible.length && this.visible.every((m, i) => sameMsg(m, messages[i]!));
    if (!extendsOurs) {
      this.pending = undefined;
      this.internal = messages.map((m) => ({ role: m.role, content: m.content }) as WireMessage);
      this.visible = messages.map((m) => ({ ...m }));
    } else {
      const fresh = messages.slice(this.visible.length);
      if (fresh.length && this.pending) {
        // The user typed instead of approving: answer the open tool call(s) so the transcript stays valid.
        this.answerCall(this.pending.call, "User did not approve; they replied with a new message instead.");
        for (const q of this.pending.queue) this.answerCall(q, "Skipped: the batch was interrupted by the user.");
        this.pending = undefined;
      }
      for (const m of fresh) {
        this.internal.push({ role: m.role, content: m.content } as WireMessage);
        this.visible.push({ ...m });
      }
    }
    if (this.pending) return this.reply(); // nothing new; still waiting
    return this.loop();
  }

  async approve(callId: string): Promise<AssistantReply> {
    const p = this.pending;
    if (!p || p.call.id !== callId) return this.reply("Nothing to approve with that id (it may have expired).");
    this.pending = undefined;
    const tool = this.tools.get(p.call.function.name)!;
    this.answerCall(p.call, await this.runTool(tool, p.args));
    const r = await this.processCalls(p.queue);
    if (r) return r;
    return this.loop();
  }

  async reject(callId: string): Promise<AssistantReply> {
    const p = this.pending;
    if (!p || p.call.id !== callId) return this.reply("Nothing to reject with that id (it may have expired).");
    this.pending = undefined;
    this.answerCall(p.call, DECLINED);
    for (const q of p.queue) {
      const t = this.tools.get(q.function.name);
      if (t?.kind === "act") this.answerCall(q, "Skipped because the user declined an earlier action.");
      else this.answerCall(q, await this.runParsed(q));
    }
    return this.loop();
  }

  /* ---------------------------------------------------------------- */

  private toPending(p: PendingState): PendingApproval {
    return { callId: p.call.id, tool: p.call.function.name, summary: p.summary };
  }

  private reply(error?: string): AssistantReply {
    const r: AssistantReply = { messages: this.visible.map((m) => ({ ...m })) };
    if (this.pending) r.pending = this.toPending(this.pending);
    if (error) r.error = error;
    return r;
  }

  private answerCall(call: WireToolCall, result: unknown) {
    let text = typeof result === "string" ? result : safeJson(result);
    if (text.length > this.maxResult) text = text.slice(0, this.maxResult) + "\n…(truncated)";
    this.internal.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: text });
  }

  private async runTool(tool: ToolDef, args: unknown): Promise<unknown> {
    try {
      const out = await tool.run(args);
      return out === undefined ? "done" : out;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  private parseArgs(call: WireToolCall): { ok: true; args: unknown } | { ok: false; error: string } {
    const raw = call.function.arguments?.trim() || "{}";
    try {
      const v = JSON.parse(raw);
      return { ok: true, args: v ?? {} };
    } catch {
      return { ok: false, error: `Invalid JSON arguments for ${call.function.name}: ${raw.slice(0, 200)}` };
    }
  }

  private async runParsed(call: WireToolCall): Promise<unknown> {
    const tool = this.tools.get(call.function.name);
    if (!tool) return { error: `Unknown tool "${call.function.name}". Available: ${[...this.tools.keys()].join(", ")}` };
    const parsed = this.parseArgs(call);
    if (!parsed.ok) return { error: parsed.error };
    return this.runTool(tool, parsed.args);
  }

  /** Answer tool calls in order; stops at the first act call and returns a pending reply. */
  private async processCalls(calls: WireToolCall[]): Promise<AssistantReply | undefined> {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const tool = this.tools.get(call.function.name);
      if (tool?.kind === "act") {
        const parsed = this.parseArgs(call);
        if (!parsed.ok) {
          this.answerCall(call, { error: parsed.error });
          continue;
        }
        let summary: string;
        try {
          summary = tool.summarize ? tool.summarize(parsed.args) : `Run ${tool.name} with ${safeJson(parsed.args)}`;
        } catch (e) {
          this.answerCall(call, { error: `Invalid arguments: ${(e as Error).message}` });
          continue;
        }
        this.pending = { call, args: parsed.args, summary, queue: calls.slice(i + 1) };
        return this.reply();
      }
      this.answerCall(call, await this.runParsed(call));
    }
    return undefined;
  }

  private wireTools(): WireTool[] {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  private outgoing(): WireMessage[] {
    const r = this.redact;
    const msgs: WireMessage[] = [{ role: "system", content: r(this.system) }, ...this.internal];
    return msgs.map((m) => {
      if (m.role === "assistant") {
        const out = { ...m, content: m.content == null ? null : r(m.content) };
        if (m.tool_calls)
          out.tool_calls = m.tool_calls.map((tc) => ({
            ...tc,
            function: { ...tc.function, arguments: r(tc.function.arguments) },
          }));
        return out;
      }
      return { ...m, content: r(m.content) } as WireMessage;
    });
  }

  /** Transcript without tool traffic, for providers that cannot do tool calling. */
  private outgoingPlain(): WireMessage[] {
    const note =
      "\n\n(Note: tools are unavailable with this model. Answer from general knowledge, say clearly when you " +
      "are unsure, and tell the user which steps they must do themselves.)";
    return this.outgoing()
      .filter((m) => m.role !== "tool" && !(m.role === "assistant" && !m.content))
      .map((m) => {
        if (m.role === "system") return { role: "system", content: m.content + note } as WireMessage;
        if (m.role === "assistant") return { role: "assistant", content: m.content } as WireMessage;
        return m;
      });
  }

  private async loop(): Promise<AssistantReply> {
    const tools = this.wireTools();
    for (let round = 0; round <= this.maxRounds; round++) {
      let res;
      try {
        res = this.plainChat || !tools.length
          ? await chatWithFallback(this.providers, { messages: this.plainChat ? this.outgoingPlain() : this.outgoing() }, this.fetchImpl)
          : await chatWithFallback(this.providers, { messages: this.outgoing(), tools }, this.fetchImpl);
      } catch (e) {
        if (e instanceof AiError && e.kind === "no-tools" && !this.plainChat && tools.length) {
          // Provider/model can't do function calling: continue as plain chat, and tell the user.
          this.plainChat = true;
          this.visible.push({
            role: "assistant",
            content:
              "Note: this AI model does not support tool calling, so I can't check or change anything myself. " +
              "I'll answer as plain chat — for hands-on help pick a tool-capable model or provider.",
          });
          round--;
          continue;
        }
        return this.reply(e instanceof AiError ? e.message : `AI request failed: ${String(e)}`);
      }
      this.internal.push(res.message);
      const text = cleanVisible(res.content);
      if (text) this.visible.push({ role: "assistant", content: text });
      if (!res.toolCalls.length) {
        if (!text) this.visible.push({ role: "assistant", content: "(no reply)" });
        return this.reply();
      }
      if (round === this.maxRounds) break;
      const pending = await this.processCalls(res.toolCalls);
      if (pending) return pending;
    }
    // Too many rounds: answer any unanswered tool calls so the transcript stays valid, then stop.
    const last = this.internal[this.internal.length - 1];
    if (last && last.role === "assistant" && last.tool_calls) {
      for (const tc of last.tool_calls) this.answerCall(tc, "Stopped: too many tool steps in one turn.");
    }
    this.visible.push({
      role: "assistant",
      content: `I stopped after ${this.maxRounds} tool steps in a row. Say "continue" if you want me to keep going.`,
    });
    return this.reply();
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
