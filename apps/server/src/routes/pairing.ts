import type { FastifyInstance } from "fastify";

import type { RouteContext } from "./context.js";

export async function pairingRoutes(app: FastifyInstance, ctx: RouteContext) {
  const { devices } = ctx;
  /* ---------------- pairing ---------------- */
  app.post("/api/pair/start", async (req, reply) => {
    try {
      return devices.startPairing(String(req.headers["user-agent"] ?? ""), req.ip);
    } catch {
      return reply.code(429).send({ error: "too-many-pairings" });
    }
  });
  app.get<{ Params: { id: string } }>("/api/pair/status/:id", async (req, reply) => {
    const s = devices.pairingStatus(req.params.id);
    if (!s) return reply.code(404).send({ status: "expired" });
    return s;
  });
}
