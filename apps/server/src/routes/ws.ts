import type { FastifyInstance } from "fastify";
import { KioskSession } from "../ws/session.js";

import type { RouteContext } from "./context.js";

export async function wsRoutes(app: FastifyInstance, ctx: RouteContext) {
  const { log, hub, devices, profiles, agents, ha, sessions, remoteOf } = ctx;
  /* ---------------- WebSocket ---------------- */
  app.get("/ws", { websocket: true }, (socket, req) => {
    new KioskSession(socket, remoteOf(req), { hub, devices, profiles, agents, ha, log }, sessions);
  });
}
