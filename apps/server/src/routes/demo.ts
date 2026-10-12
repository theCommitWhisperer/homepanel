import type { FastifyInstance } from "fastify";
import type { FakeHa } from "../ha/demo.js";
import type { RouteContext } from "./context.js";

/** DEMO-only routes (registered only when DEMO=1). No auth, by design. */
export async function demoRoutes(app: FastifyInstance, ctx: RouteContext) {
  const { ha, takeover, config } = ctx;
  /** Simulate a doorbell press → takeover on every screen in on_ring.show_on. */
  app.post("/api/demo/ring", async () => {
    for (const name of Object.keys(config.config.doorbells)) takeover.clearDebounce(name);
    (ha as FakeHa).ring();
    return { ok: true };
  });
}
