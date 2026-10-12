import type { FastifyInstance } from "fastify";
import { VERSION } from "@homepanel/protocol";
import type { HaStatus } from "../ha/types.js";

import type { RouteContext } from "./context.js";

export async function healthRoutes(app: FastifyInstance, ctx: RouteContext) {
  const { env, agents, ha } = ctx;
  /* ---------------- health ---------------- */
  app.get("/api/health", async () => ({
    ok: true,
    ha: ha.status as HaStatus,
    mqtt: agents.transport?.status ?? "disabled",
    version: VERSION,
    demo: env.demo,
  }));
}
