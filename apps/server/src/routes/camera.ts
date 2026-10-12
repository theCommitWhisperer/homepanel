import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RouteContext } from "./context.js";

export async function cameraRoutes(app: FastifyInstance, ctx: RouteContext) {
  const { log, ha, requireDeviceOrAdmin } = ctx;
  /* ---------------- camera proxy ---------------- */
  const cameraRoute = (kind: "snapshot" | "stream") => async (req: FastifyRequest<{ Params: { entity: string } }>, reply: FastifyReply) => {
    const entity = req.params.entity;
    if (!/^(camera|image)\.[a-z0-9_]+$/.test(entity)) return reply.code(400).send({ error: "bad-entity" });
    const ac = new AbortController();
    req.raw.on("close", () => ac.abort());
    try {
      const r = await ha.camera(entity, kind, ac.signal);
      reply.raw.on("close", () => {
        r.close?.();
        ac.abort();
      });
      reply
        .code(r.status)
        .header("content-type", r.contentType)
        .header("cache-control", "no-store, no-cache, must-revalidate")
        .header("x-accel-buffering", "no");
      return reply.send(r.body);
    } catch (e) {
      if (ac.signal.aborted) return reply;
      log.warn({ entity, err: (e as Error).message }, "camera proxy failed");
      return reply.code(502).send({ error: "camera-unavailable" });
    }
  };
  app.get<{ Params: { entity: string } }>("/api/camera/:entity/snapshot", { preHandler: requireDeviceOrAdmin }, cameraRoute("snapshot"));
  app.get<{ Params: { entity: string } }>("/api/camera/:entity/stream", { preHandler: requireDeviceOrAdmin }, cameraRoute("stream"));
}
