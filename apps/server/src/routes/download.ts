import fs from "node:fs";
import type { FastifyInstance } from "fastify";

import type { RouteContext } from "./context.js";

/**
 * When the server runs from HomePanel.exe (Node single executable), serve that exe at
 * GET /download/HomePanel.exe so other PCs on the LAN can grab the same installer.
 * HomePanel.exe sets HOMEPANEL_EXE=process.execPath before starting the server; from a source
 * checkout the variable is unset and the route answers 404.
 */
export function runningExe(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exe = env.HOMEPANEL_EXE;
  if (!exe) return undefined;
  try {
    return fs.statSync(exe).isFile() ? exe : undefined;
  } catch {
    return undefined;
  }
}

export async function downloadRoutes(app: FastifyInstance, _ctx: RouteContext, env: NodeJS.ProcessEnv = process.env) {
  app.get("/download/HomePanel.exe", async (_req, reply) => {
    const exe = runningExe(env);
    if (!exe) {
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send("This HomePanel server is not running from HomePanel.exe. Download it from https://github.com/theCommitWhisperer/homepanel/releases\n");
    }
    const size = fs.statSync(exe).size;
    return reply
      .type("application/vnd.microsoft.portable-executable")
      .header("content-length", size)
      .header("content-disposition", 'attachment; filename="HomePanel.exe"')
      .header("cache-control", "no-cache")
      .send(fs.createReadStream(exe));
  });
}
