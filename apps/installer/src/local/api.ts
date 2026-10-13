/** Small HomePanel server API client for the local flows (admin login, PCs, pairing, health). */
import type { AgentSummary, DeviceInfo, PairStartResponse, PairStatusResponse } from "@homepanel/protocol";
import { adminLogin, registerAgent } from "../steps/pcs.js";

export class ServerApi {
  private session?: string;
  constructor(
    readonly url: string,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.url = url.replace(/\/+$/, "");
  }

  async health(timeoutMs = 3000): Promise<{ ok: boolean; version?: string; mqtt?: string; ha?: string } | undefined> {
    try {
      const r = await this.fetchImpl(`${this.url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return undefined;
      const j = (await r.json()) as { ok?: boolean; version?: string; mqtt?: string; ha?: string };
      return typeof j === "object" && j && "ok" in j ? { ok: !!j.ok, version: j.version, mqtt: j.mqtt, ha: j.ha } : undefined;
    } catch {
      return undefined;
    }
  }

  async login(password: string): Promise<void> {
    this.session = await adminLogin(this.fetchImpl, this.url, password);
  }

  private auth(): Record<string, string> {
    if (!this.session) throw new Error("not logged in to the HomePanel admin API");
    return { authorization: `Bearer ${this.session}` };
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.fetchImpl(`${this.url}${path}`, {
      method,
      headers: { ...this.auth(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  }

  registerAgent(a: { pcId: string; name: string; mac?: string }) {
    return registerAgent(this.fetchImpl, this.url, this.session ?? "", a);
  }

  agents(): Promise<AgentSummary[]> {
    return this.json<AgentSummary[]>("GET", "/api/admin/agents");
  }

  async profiles(): Promise<string[]> {
    const p = await this.json<{ id: string }[]>("GET", "/api/admin/profiles");
    return p.map((x) => x.id);
  }

  /** Pair a screen without a human typing the code: start → approve → read the token. */
  async pairDevice(name: string, profileId: string): Promise<{ token: string; device: DeviceInfo }> {
    const r = await this.fetchImpl(`${this.url}/api/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "HomePanel setup" },
      body: "{}",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`pair start: HTTP ${r.status}`);
    const start = (await r.json()) as PairStartResponse;
    await this.json<DeviceInfo>("POST", `/api/admin/pairings/${encodeURIComponent(start.pairingId)}/approve`, { name, profileId });
    const s = await this.fetchImpl(`${this.url}/api/pair/status/${encodeURIComponent(start.pairingId)}`, { signal: AbortSignal.timeout(8000) });
    const st = (await s.json()) as PairStatusResponse;
    if (st.status !== "approved") throw new Error(`pairing ended as "${st.status}"`);
    return { token: st.deviceToken, device: st.device };
  }
}
