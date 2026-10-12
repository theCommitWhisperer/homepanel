import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

import type { RouteContext } from "./context.js";

const NOT_BUILT_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HomePanel</title><style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:34rem;padding:2rem}code{background:#222;padding:.15rem .4rem;border-radius:4px}</style></head>
<body><main><h1>HomePanel server is running</h1><p>The kiosk web app isn't built yet, so there is nothing to show here.</p>
<p>Build it with <code>pnpm --filter @homepanel/kiosk build</code> (or set <code>KIOSK_DIST</code>) and restart the server.</p>
<p>API health: <a style="color:#8cf" href="/api/health">/api/health</a></p></main></body></html>`;

export async function kioskRoutes(app: FastifyInstance, ctx: RouteContext) {
  const { env, log } = ctx;
  /* ---------------- kiosk SPA ---------------- */
  const kioskIndex = path.join(env.kioskDist, "index.html");
  if (fs.existsSync(kioskIndex)) {
    await app.register(fastifyStatic, {
      root: env.kioskDist,
      prefix: "/",
      wildcard: false,
      index: false,
      setHeaders(res, file) {
        if (/[\\/]assets[\\/]/.test(file)) res.setHeader("cache-control", "public, max-age=31536000, immutable");
        else res.setHeader("cache-control", "no-cache");
      },
    });
  } else {
    log.warn({ kioskDist: env.kioskDist }, "kiosk build not found — serving placeholder page");
  }
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split("?")[0]!;
    const isApi = url.startsWith("/api/") || url === "/api" || url.startsWith("/media/") || url.startsWith("/agent/") || url === "/ws";
    if (req.method !== "GET" && req.method !== "HEAD") return reply.code(404).send({ error: "not-found" });
    if (isApi) return reply.code(404).send({ error: "not-found" });
    // a missing file with an extension (e.g. /favicon.png) is a real 404, not an SPA route
    if (/\.[a-z0-9]{2,5}$/i.test(url) && !url.endsWith(".html")) return reply.code(404).send({ error: "not-found" });
    reply.header("cache-control", "no-cache");
    if (fs.existsSync(kioskIndex)) return reply.type("text/html; charset=utf-8").send(fs.createReadStream(kioskIndex));
    return reply.type("text/html; charset=utf-8").send(NOT_BUILT_HTML);
  });
}
