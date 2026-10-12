import type { FastifyInstance } from "fastify";
import YAML from "yaml";
import type { ChatMessage } from "@homepanel/protocol";
import { redactConfig } from "../serverConfig.js";
import { bearer } from "./context.js";
import { safeEqual } from "../store.js";

import type { RouteContext } from "./context.js";

export async function adminRoutes(app: FastifyInstance, ctx: RouteContext) {
  const { log, devices, profiles, agents, ha, takeover, config, sessions, admin, adminPassword, assistant, requireAdmin } = ctx;
  /* ---------------- admin ---------------- */
  const failures = new Map<string, { n: number; until: number }>();
  app.post<{ Body: { password?: string } }>("/api/admin/login", async (req, reply) => {
    const f = failures.get(req.ip);
    if (f && f.n >= 5 && f.until > Date.now()) return reply.code(429).send({ error: "too-many-attempts" });
    const pw = typeof req.body?.password === "string" ? req.body.password : "";
    if (!pw || !safeEqual(pw, adminPassword)) {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: 0 };
      failures.set(req.ip, { n: cur.n + 1, until: Date.now() + 60_000 });
      log.warn({ ip: req.ip }, "admin login failed");
      return reply.code(401).send({ error: "wrong-password" });
    }
    failures.delete(req.ip);
    return { session: admin.create() };
  });

  await app.register(async (a) => {
    a.addHook("preHandler", requireAdmin);

    a.post("/api/admin/logout", async (req) => {
      const s = bearer(req);
      if (s) admin.revoke(s);
      return { ok: true };
    });

    a.get("/api/admin/pairings", async () => devices.pendingPairings());
    a.post<{ Params: { id: string }; Body: { name?: string; profileId?: string } }>(
      "/api/admin/pairings/:id/approve",
      async (req, reply) => {
        const name = (req.body?.name ?? "").toString().trim() || "Screen";
        const profileId = (req.body?.profileId ?? "").toString();
        if (!profiles.get(profileId)) return reply.code(400).send({ error: `unknown profile "${profileId}"` });
        const d = devices.approve(req.params.id, name.slice(0, 80), profileId);
        if (!d) return reply.code(404).send({ error: "pairing-not-found" });
        log.info({ device: d.name, profile: profileId }, "screen paired");
        return d;
      },
    );
    a.post<{ Params: { id: string } }>("/api/admin/pairings/:id/reject", async (req, reply) => {
      if (!devices.reject(req.params.id)) return reply.code(404).send({ error: "pairing-not-found" });
      return { ok: true };
    });

    a.get("/api/admin/devices", async () => {
      const online = new Set([...sessions].map((s) => s.deviceId));
      return devices.list().map((d) => {
        const s = devices.get(d.id);
        return { ...d, online: online.has(d.id), ...(s?.lastSeen ? { lastSeen: s.lastSeen } : {}) };
      });
    });
    a.patch<{ Params: { id: string }; Body: { name?: string; profileId?: string } }>("/api/admin/devices/:id", async (req, reply) => {
      const b = req.body ?? {};
      if (b.profileId !== undefined && !profiles.get(b.profileId)) return reply.code(400).send({ error: `unknown profile "${b.profileId}"` });
      const d = devices.update(req.params.id, {
        ...(typeof b.name === "string" && b.name.trim() ? { name: b.name.trim().slice(0, 80) } : {}),
        ...(typeof b.profileId === "string" ? { profileId: b.profileId } : {}),
      });
      if (!d) return reply.code(404).send({ error: "device-not-found" });
      return { id: d.id, name: d.name, profileId: d.profileId };
    });
    a.delete<{ Params: { id: string } }>("/api/admin/devices/:id", async (req, reply) => {
      if (!devices.remove(req.params.id)) return reply.code(404).send({ error: "device-not-found" });
      return { ok: true };
    });

    a.get("/api/admin/profiles", async () => profiles.list().map((p) => ({ id: p.id, name: p.name, yaml: p.yaml })));
    a.put<{ Params: { id: string }; Body: unknown }>("/api/admin/profiles/:id", async (req, reply) => {
      const body = req.body;
      const text =
        typeof body === "string" ? body : body && typeof body === "object" && typeof (body as any).yaml === "string" ? (body as any).yaml : null;
      if (text === null) return reply.code(400).send({ ok: false, errors: ["send the profile as a text/yaml body"] });
      const r = profiles.put(req.params.id, text);
      if (!r.ok) return reply.code(400).send(r);
      return { ok: true };
    });
    a.delete<{ Params: { id: string } }>("/api/admin/profiles/:id", async (req, reply) => {
      const users = devices.list().filter((d) => d.profileId === req.params.id);
      if (users.length) {
        return reply.code(409).send({ ok: false, errors: [`in use by: ${users.map((u) => u.name).join(", ")}`] });
      }
      if (!profiles.delete(req.params.id)) return reply.code(404).send({ ok: false, errors: ["not found"] });
      return { ok: true };
    });

    a.get("/api/admin/agents", async () => agents.summaries());
    a.post<{ Body: { pcId?: string; name?: string; mac?: string } }>("/api/admin/agents", async (req, reply) => {
      const b = req.body ?? {};
      if (typeof b.pcId !== "string" || !b.pcId) return reply.code(400).send({ error: "pcId required" });
      try {
        return agents.register(b.pcId, (b.name || b.pcId).toString(), b.mac || undefined);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    a.delete<{ Params: { pcId: string } }>("/api/admin/agents/:pcId", async (req, reply) => {
      if (!agents.unregister(req.params.pcId)) return reply.code(404).send({ error: "agent-not-found" });
      return { ok: true };
    });

    a.get("/api/admin/entities", async () => ha.states());

    a.get<{ Querystring: { format?: string } }>("/api/admin/config", async (req, reply) => {
      if (req.query.format === "yaml") {
        const doc = YAML.parseDocument(config.text || "");
        if (doc.hasIn(["assistant", "apiKey"])) doc.setIn(["assistant", "apiKey"], "***");
        for (const k of Object.keys(config.config.fully_kiosk)) {
          if (doc.hasIn(["fully_kiosk", k, "password"])) doc.setIn(["fully_kiosk", k, "password"], "***");
        }
        return reply.type("text/yaml; charset=utf-8").send(config.text ? doc.toString() : "");
      }
      return redactConfig(config.config);
    });
    a.put<{ Body: unknown }>("/api/admin/config", async (req, reply) => {
      const body = req.body;
      const text =
        typeof body === "string" ? body : body && typeof body === "object" && typeof (body as any).yaml === "string" ? (body as any).yaml : null;
      if (text === null) return reply.code(400).send({ ok: false, errors: ["send config.yaml as a text/yaml body"] });
      const r = config.put(text);
      if (!r.ok) return reply.code(400).send(r);
      return { ok: true };
    });

    /** Fire a doorbell takeover without pressing the button (admin "Test" button). */
    a.post<{ Params: { name: string } }>("/api/admin/doorbells/:name/test", async (req, reply) => {
      takeover.clearDebounce(req.params.name);
      const t = takeover.ring(req.params.name);
      if (!t) return reply.code(404).send({ error: "doorbell-not-found" });
      return { ok: true, takeover: t };
    });

    a.post<{ Body: { messages?: ChatMessage[] } }>("/api/admin/assistant", async (req, reply) => {
      const msgs = Array.isArray(req.body?.messages) ? req.body!.messages! : [];
      const clean = msgs
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
      const r = await assistant.step(bearer(req) ?? "", clean);
      if ("error" in r && !("messages" in r)) return reply.send(r);
      return r;
    });
    a.post<{ Body: { callId?: string; approve?: boolean } }>("/api/admin/assistant/approve", async (req) => {
      return assistant.decide(bearer(req) ?? "", String(req.body?.callId ?? ""), req.body?.approve !== false);
    });
    a.post<{ Body: { callId?: string } }>("/api/admin/assistant/reject", async (req) => {
      return assistant.decide(bearer(req) ?? "", String(req.body?.callId ?? ""), false);
    });
  });
}
