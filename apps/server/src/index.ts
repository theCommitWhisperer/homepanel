#!/usr/bin/env node
import { buildApp } from "./app.js";
import { loadEnv } from "./config.js";

const env = loadEnv();
const { app, adminPassword } = await buildApp({ env });

const shutdown = async (sig: string) => {
  app.log.info({ sig }, "shutting down");
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: env.port, host: env.host });
  app.log.info(
    { dataDir: env.dataDir, ha: env.demo ? "demo" : env.haUrl ?? "off", mqtt: env.demo ? "demo" : env.mqttUrl ?? "off" },
    `HomePanel server listening on :${env.port}`,
  );
  if (env.demo) {
    app.log.info(
      `DEMO mode — open http://localhost:${env.port}/?token=demo · admin password "${adminPassword}" · ring: curl -X POST localhost:${env.port}/api/demo/ring`,
    );
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
