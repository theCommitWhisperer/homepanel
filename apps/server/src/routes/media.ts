import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RouteContext } from "./context.js";

const MEDIA_EXT = /\.(gif|png|jpe?g|webp|svg|avif|mp4|webm|mov)$/i;

/** All media files under root (relative paths, "/" separated, sorted). Dotfiles are skipped. */
export function listMedia(root: string, rel = ""): string[] {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listMedia(root, r));
    else if (MEDIA_EXT.test(e.name)) out.push(r);
  }
  return out.sort();
}

export async function mediaRoutes(app: FastifyInstance, ctx: RouteContext) {
  const { mediaDir, requireDeviceOrAdmin, remoteOf } = ctx;
  /* ---------------- media ---------------- */
  // LAN screens may load media without a token (e.g. a plain <img>); remote requests need one.
  const mediaAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (remoteOf(req)) return requireDeviceOrAdmin(req, reply);
  };
  app.get("/api/media", { preHandler: mediaAuth }, async () => listMedia(mediaDir));
  await app.register(async (m) => {
    m.addHook("onRequest", mediaAuth);
    await m.register(fastifyStatic, {
      root: mediaDir,
      prefix: "/media/",
      decorateReply: false,
      index: false,
      dotfiles: "deny",
      maxAge: "1h",
    });
  });
}
