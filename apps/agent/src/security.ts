import { createHmac, timingSafeEqual } from "node:crypto";
import { signingString, type AgentCommand } from "@homepanel/protocol";

export const MAX_SKEW_MS = 10_000;
export const REPLAY_MEMORY = 500;

export function sign(key: string, cmd: Pick<AgentCommand, "id" | "action" | "ts">): string {
  return createHmac("sha256", key).update(signingString(cmd)).digest("hex");
}

export type VerifyResult = { ok: true; cmd: AgentCommand } | { ok: false; error: string; id?: string };

/**
 * Validates an incoming command: shape, signature (constant-time), clock skew, replay.
 * Only *successfully verified* ids are remembered, so an attacker can't burn real ids.
 */
export class CommandVerifier {
  private seen = new Set<string>();
  private order: string[] = [];
  constructor(
    private key: string,
    private now: () => number = Date.now,
    private maxSkewMs = MAX_SKEW_MS,
    private memory = REPLAY_MEMORY,
  ) {}

  verify(payload: Buffer | string): VerifyResult {
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString());
    } catch {
      return { ok: false, error: "malformed JSON" };
    }
    if (!raw || typeof raw !== "object") return { ok: false, error: "malformed command" };
    const c = raw as Record<string, unknown>;
    const id = typeof c.id === "string" ? c.id : undefined;
    if (
      !id ||
      id.length > 128 ||
      typeof c.action !== "string" ||
      c.action.length > 64 ||
      typeof c.ts !== "number" ||
      !Number.isFinite(c.ts) ||
      typeof c.sig !== "string"
    ) {
      return { ok: false, error: "malformed command", id };
    }
    const cmd: AgentCommand = { id, action: c.action, ts: c.ts, sig: c.sig };

    const expected = Buffer.from(sign(this.key, cmd), "hex");
    const given = /^[0-9a-f]{64}$/i.test(cmd.sig) ? Buffer.from(cmd.sig, "hex") : Buffer.alloc(0);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, error: "bad signature", id };
    }
    if (Math.abs(this.now() - cmd.ts) > this.maxSkewMs) {
      return { ok: false, error: "stale command (check the clocks of the server and this PC)", id };
    }
    if (this.seen.has(cmd.id)) return { ok: false, error: "replayed command", id };
    this.seen.add(cmd.id);
    this.order.push(cmd.id);
    while (this.order.length > this.memory) this.seen.delete(this.order.shift()!);
    return { ok: true, cmd };
  }
}
