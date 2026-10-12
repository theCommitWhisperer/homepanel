import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import type { AssistantService } from "../assistant/service.js";
import type { EnvConfig } from "../config.js";
import type { AdminSessions, DeviceStore, StoredDevice } from "../devices.js";
import type { HaSource } from "../ha/types.js";
import type { AgentManager } from "../mqtt/agents.js";
import { isRemoteIp } from "../net.js";
import type { ProfileStore } from "../profiles.js";
import type { ServerConfigStore } from "../serverConfig.js";
import type { TakeoverManager } from "../takeover.js";
import type { StateHub } from "../ws/hub.js";
import type { KioskSession } from "../ws/session.js";

/** Everything the route modules need. Built once in app.ts. */
export interface RouteContext {
  env: EnvConfig;
  log: FastifyBaseLogger;
  hub: StateHub;
  devices: DeviceStore;
  profiles: ProfileStore;
  agents: AgentManager;
  ha: HaSource;
  takeover: TakeoverManager;
  config: ServerConfigStore;
  sessions: Set<KioskSession>;
  admin: AdminSessions;
  adminPassword: string;
  assistant: AssistantService;
  mediaDir: string;
  /* auth helpers */
  remoteOf(req: FastifyRequest): boolean;
  isAdmin(req: FastifyRequest): boolean;
  deviceOf(req: FastifyRequest): StoredDevice | undefined;
  requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  requireDeviceOrAdmin(req: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  return undefined;
}

export function queryToken(req: FastifyRequest): string | undefined {
  const q = req.query as Record<string, unknown> | undefined;
  return typeof q?.t === "string" ? q.t : undefined;
}

/** Device-token / admin-session auth helpers. */
export function authHelpers(devices: DeviceStore, admin: AdminSessions) {
  const remoteOf = (req: FastifyRequest) => isRemoteIp(req.ip);
  const isAdmin = (req: FastifyRequest) => admin.valid(bearer(req)) || admin.valid(req.headers["x-admin-session"] as string);
  const deviceOf = (req: FastifyRequest) => devices.byToken(bearer(req) ?? queryToken(req));
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "admin-auth-required" });
  };
  const requireDeviceOrAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!deviceOf(req) && !isAdmin(req) && !admin.valid(queryToken(req))) return reply.code(401).send({ error: "auth-required" });
  };
  return { remoteOf, isAdmin, deviceOf, requireAdmin, requireDeviceOrAdmin };
}
