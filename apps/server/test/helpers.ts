import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config.js";

export function tmpDir(prefix = "hp-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function demoApp() {
  const dir = path.join(tmpDir(), "demo-data");
  const env = loadEnv({ DEMO: "1", DATA_DIR: dir, KIOSK_DIST: path.join(dir, "no-kiosk"), PORT: "0" }, []);
  const hp = await buildApp({ env, logger: false, demoIntervalMs: 200 });
  await hp.app.ready();
  return hp;
}

export async function plainApp(extraEnv: Record<string, string> = {}) {
  const dir = tmpDir();
  const env = loadEnv({ DATA_DIR: dir, ADMIN_PASSWORD: "secret", KIOSK_DIST: path.join(dir, "nokiosk"), ...extraEnv }, []);
  const hp = await buildApp({ env, logger: false, connect: false });
  await hp.app.ready();
  return { ...hp, dir };
}

/** Connect a WS via inject and collect messages. */
export async function wsClient(app: Awaited<ReturnType<typeof demoApp>>["app"], remoteAddress?: string) {
  const msgs: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  const ws = await app.injectWS("/ws", { socket: { remoteAddress: remoteAddress ?? "127.0.0.1" } } as any);
  ws.on("message", (raw: Buffer) => {
    const m = JSON.parse(raw.toString());
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  const next = (pred: (m: any) => boolean, timeoutMs = 4000) =>
    new Promise<any>((resolve, reject) => {
      const found = msgs.find(pred);
      if (found) return resolve(found);
      const t = setTimeout(() => reject(new Error("timeout waiting for ws message; got " + JSON.stringify(msgs.map((m) => m.type)))), timeoutMs);
      waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { ws, msgs, next, send };
}
