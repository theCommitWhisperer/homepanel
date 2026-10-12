import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

/** Minimal fake Home Assistant: onboarding REST, /auth/token, /api/, config flows, WebSocket API. */
export interface FakeHa {
  url: string;
  close(): Promise<void>;
  state: {
    onboarded: boolean;
    users: { id: string; name: string; username: string; password: string; group_ids: string[] }[];
    onboardingDone: Set<string>;
    authCodes: Map<string, string>;
    accessTokens: Set<string>;
    longLived: { client_name: string; lifespan: number; token: string }[];
    coreConfig: Record<string, unknown>;
    configEntries: { entry_id: string; domain: string; title: string; state: string }[];
    flows: Map<string, { handler: string; step: string }>;
    supervisorCalls: { endpoint: string; method: string; data?: unknown }[];
    requests: { method: string; path: string; body: any; auth?: string }[];
    clientIds: string[];
  };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return undefined;
  if ((req.headers["content-type"] ?? "").includes("x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  return JSON.parse(raw);
}

export async function startFakeHa(opts: { onboarded?: boolean; haOs?: boolean } = {}): Promise<FakeHa> {
  let n = 0;
  const id = (p: string) => `${p}${++n}`;
  const state: FakeHa["state"] = {
    onboarded: !!opts.onboarded,
    users: [],
    onboardingDone: new Set(),
    authCodes: new Map(),
    accessTokens: new Set(),
    longLived: [],
    coreConfig: {},
    configEntries: [],
    flows: new Map(),
    supervisorCalls: [],
    requests: [],
    clientIds: [],
  };
  const addons: Record<string, { installed: boolean; state: string }> = { core_mosquitto: { installed: false, state: "unknown" } };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const body = await readBody(req).catch(() => undefined);
    const auth = req.headers.authorization?.replace(/^Bearer /, "");
    state.requests.push({ method: req.method!, path: url.pathname, body, auth });
    const json = (code: number, v: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const authed = () => !!auth && (state.accessTokens.has(auth) || state.longLived.some((l) => l.token === auth));
    const p = url.pathname;

    if (p === "/manifest.json") return json(200, { name: "Home Assistant" });
    if (p === "/api/onboarding" && req.method === "GET") {
      if (state.onboarded) return json(404, { message: "Not found" });
      return json(
        200,
        ["user", "core_config", "analytics", "integration"].map((s) => ({ step: s, done: state.onboardingDone.has(s) })),
      );
    }
    if (p === "/api/onboarding/users" && req.method === "POST") {
      if (state.onboardingDone.has("user")) return json(403, { message: "User step already done" });
      state.clientIds.push(body.client_id);
      const user = { id: id("u"), name: body.name, username: body.username, password: body.password, group_ids: ["system-admin"] };
      state.users.push(user);
      state.onboardingDone.add("user");
      const code = id("code");
      state.authCodes.set(code, user.id);
      return json(200, { auth_code: code });
    }
    if (p === "/auth/token" && req.method === "POST") {
      if (body.grant_type !== "authorization_code" || !state.authCodes.has(body.code)) return json(400, { error: "invalid_request" });
      state.clientIds.push(body.client_id);
      state.authCodes.delete(body.code);
      const tok = id("access");
      state.accessTokens.add(tok);
      return json(200, { access_token: tok, token_type: "Bearer", refresh_token: id("refresh"), expires_in: 1800 });
    }
    if (p === "/auth/login_flow" && req.method === "POST") {
      state.clientIds.push(body.client_id);
      const fid = id("login");
      state.flows.set(fid, { handler: "login", step: "init" });
      return json(200, { type: "form", flow_id: fid, step_id: "init", data_schema: [{ name: "username" }, { name: "password" }] });
    }
    const lm = /^\/auth\/login_flow\/(.+)$/.exec(p);
    if (lm && req.method === "POST") {
      if (!state.flows.has(lm[1]!)) return json(404, {});
      const u = state.users.find((x) => x.username === body.username && x.password === body.password);
      if (!u) return json(200, { type: "form", flow_id: lm[1], step_id: "init", errors: { base: "invalid_auth" } });
      state.flows.delete(lm[1]!);
      const code = id("code");
      state.authCodes.set(code, u.id);
      return json(200, { type: "create_entry", flow_id: lm[1], result: code });
    }
    if (p.startsWith("/api/onboarding/") && req.method === "POST") {
      if (!authed()) return json(401, { message: "Unauthorized" });
      const step = p.split("/").pop()!;
      if (state.onboardingDone.has(step)) return json(403, { message: "already done" });
      state.onboardingDone.add(step);
      if (step === "integration") {
        state.clientIds.push(body.client_id);
        state.onboarded = true;
        return json(200, { auth_code: id("code") });
      }
      return json(200, {});
    }
    if (p === "/api/" && req.method === "GET") return authed() ? json(200, { message: "API running." }) : json(401, {});
    if (p === "/api/config/config_entries/flow" && req.method === "GET") {
      if (!authed()) return json(401, {});
      return json(200, [...state.flows].map(([flow_id, f]) => ({ flow_id, handler: f.handler, step_id: f.step, context: { source: "hassio" } })));
    }
    if (p === "/api/config/config_entries/flow" && req.method === "POST") {
      if (!authed()) return json(401, {});
      const fid = id("flow");
      if (body.handler === "reolink") {
        state.flows.set(fid, { handler: "reolink", step: "user" });
        return json(200, {
          type: "form",
          flow_id: fid,
          handler: "reolink",
          step_id: "user",
          data_schema: [{ name: "host" }, { name: "username" }, { name: "password" }],
          errors: {},
        });
      }
      if (body.handler === "mqtt") {
        state.flows.set(fid, { handler: "mqtt", step: "broker" });
        return json(200, { type: "form", flow_id: fid, handler: "mqtt", step_id: "broker", data_schema: [{ name: "broker" }, { name: "port" }] });
      }
      return json(400, { message: "Invalid handler specified" });
    }
    const fm = /^\/api\/config\/config_entries\/flow\/(.+)$/.exec(p);
    if (fm && req.method === "POST") {
      if (!authed()) return json(401, {});
      const f = state.flows.get(fm[1]!);
      if (!f) return json(404, {});
      state.flows.delete(fm[1]!);
      const title = f.handler === "reolink" ? `Doorbell ${body.host}` : "Mosquitto broker";
      state.configEntries.push({ entry_id: id("e"), domain: f.handler, title, state: "loaded" });
      return json(200, { type: "create_entry", flow_id: fm[1], handler: f.handler, title });
    }
    if (fm && req.method === "DELETE") {
      state.flows.delete(fm[1]!);
      return json(200, {});
    }
    json(404, { message: "Not found" });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    if (req.url !== "/api/websocket") return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    let authedWs = false;
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    send({ type: "auth_required", ha_version: "2026.10.0" });
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (!authedWs) {
        if (m.type === "auth" && (state.accessTokens.has(m.access_token) || state.longLived.some((l) => l.token === m.access_token))) {
          authedWs = true;
          send({ type: "auth_ok", ha_version: "2026.10.0" });
        } else send({ type: "auth_invalid", message: "Invalid access token or password" });
        return;
      }
      const ok = (result: unknown) => send({ id: m.id, type: "result", success: true, result });
      const fail = (code: string, message: string) => send({ id: m.id, type: "result", success: false, error: { code, message } });
      switch (m.type) {
        case "auth/long_lived_access_token": {
          const token = `llt-${id("t")}-${"x".repeat(20)}`;
          state.longLived.push({ client_name: m.client_name, lifespan: m.lifespan, token });
          return ok(token);
        }
        case "config/core/update": {
          const { id: _i, type: _t, ...rest } = m;
          Object.assign(state.coreConfig, rest);
          return ok(null);
        }
        case "get_config":
          return ok({ version: "2026.10.0", components: opts.haOs ? ["hassio", "mqtt"] : ["mqtt"], ...state.coreConfig });
        case "get_states":
          return ok([
            { entity_id: "light.kitchen", state: "on", attributes: {} },
            { entity_id: "sensor.outside", state: "12", attributes: {} },
          ]);
        case "zha/devices":
          return state.configEntries.some((e) => e.domain === "zha") ? ok([{ ieee: "00:11", name: "ZBT-1 coordinator" }]) : fail("unknown_command", "Unknown command.");
        case "config_entries/get":
          return ok(state.configEntries.filter((e) => !m.domain || e.domain === m.domain));
        case "config/auth/list":
          return ok(state.users.map((u) => ({ id: u.id, username: u.username, name: u.name, system_generated: false })));
        case "config/auth/create": {
          const u = { id: id("u"), name: m.name, username: "", password: "", group_ids: m.group_ids };
          state.users.push(u);
          return ok({ user: { id: u.id, name: u.name } });
        }
        case "config/auth_provider/homeassistant/create": {
          const u = state.users.find((x) => x.id === m.user_id);
          if (!u) return fail("not_found", "user not found");
          u.username = m.username;
          u.password = m.password;
          return ok(null);
        }
        case "config/auth_provider/homeassistant/admin_change_password": {
          const u = state.users.find((x) => x.id === m.user_id);
          if (u) u.password = m.password;
          return ok(null);
        }
        case "supervisor/api": {
          if (!opts.haOs) return fail("unknown_command", "Unknown command.");
          state.supervisorCalls.push({ endpoint: m.endpoint, method: m.method, data: m.data });
          const am = /^\/(?:store\/)?addons\/([^/]+)(?:\/(\w+))?$/.exec(m.endpoint);
          if (am) {
            const slug = am[1]!;
            const a = (addons[slug] ??= { installed: false, state: "unknown" });
            const action = am[2];
            if (!action) return ok({ slug, installed: a.installed });
            if (action === "info") return a.installed ? ok({ slug, state: a.state, version: "1.0" }) : fail("error", "Addon is not installed");
            if (action === "install") {
              a.installed = true;
              a.state = "stopped";
              if (slug === "core_mosquitto")
                state.flows.set(id("flow"), { handler: "mqtt", step: "hassio_confirm" });
              return ok(null);
            }
            if (action === "start" || action === "restart") {
              a.state = "started";
              return ok(null);
            }
            if (action === "options") return ok(null);
          }
          return fail("error", `unhandled ${m.endpoint}`);
        }
        default:
          return fail("unknown_command", `Unknown command ${m.type}`);
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
