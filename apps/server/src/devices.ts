import { EventEmitter } from "node:events";
import path from "node:path";
import type { DeviceInfo, PairStatusResponse, PendingPairing } from "@homepanel/protocol";
import { randomId, randomToken, readJson, sha256, sixDigits, writeJson } from "./util.js";

export interface StoredDevice {
  id: string;
  name: string;
  profileId: string;
  tokenHash: string;
  createdAt: number;
  lastSeen?: number;
}

interface Pairing extends PendingPairing {
  expiresAt: number;
  state: "pending" | "approved" | "rejected";
  /** plaintext token handed over exactly once via /api/pair/status */
  deviceToken?: string;
  device?: DeviceInfo;
  /** first time the approved token was read by the screen */
  deliveredAt?: number;
}

/** how long an approved token stays readable after the first read (lost-response tolerance) */
const DELIVERY_GRACE_MS = 60_000;

export const PAIRING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;

export const publicDevice = (d: StoredDevice): DeviceInfo => ({ id: d.id, name: d.name, profileId: d.profileId });

/**
 * Paired screens (DATA_DIR/devices.json, tokens stored as sha256) and in-memory pairing codes.
 * Emits "changed" (device) and "revoked" (deviceId).
 */
export class DeviceStore extends EventEmitter {
  private file: string;
  private devices: StoredDevice[];
  private pairings = new Map<string, Pairing>();

  constructor(dataDir: string, private now: () => number = Date.now) {
    super();
    this.file = path.join(dataDir, "devices.json");
    const raw = readJson<{ devices?: StoredDevice[] }>(this.file, {});
    this.devices = Array.isArray(raw.devices) ? raw.devices : [];
  }

  private save() {
    writeJson(this.file, { devices: this.devices }, 0o600);
  }

  list(): DeviceInfo[] {
    return this.devices.map(publicDevice);
  }

  get(id: string) {
    return this.devices.find((d) => d.id === id);
  }

  byToken(token: string | undefined | null): StoredDevice | undefined {
    if (!token) return undefined;
    const h = sha256(token);
    return this.devices.find((d) => d.tokenHash === h);
  }

  touch(id: string) {
    const d = this.get(id);
    if (d) d.lastSeen = this.now(); // not persisted on every touch
  }

  /** Create a device directly (used by demo seeding and approval). Returns the plaintext token. */
  add(name: string, profileId: string, token = randomToken(32), id = randomId(6)): { device: StoredDevice; token: string } {
    const device: StoredDevice = { id, name, profileId, tokenHash: sha256(token), createdAt: this.now() };
    this.devices = this.devices.filter((d) => d.id !== id);
    this.devices.push(device);
    this.save();
    return { device, token };
  }

  update(id: string, patch: { name?: string; profileId?: string }): StoredDevice | undefined {
    const d = this.get(id);
    if (!d) return undefined;
    if (patch.name !== undefined) d.name = patch.name;
    if (patch.profileId !== undefined) d.profileId = patch.profileId;
    this.save();
    this.emit("changed", d);
    return d;
  }

  remove(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.save();
    this.emit("revoked", id);
    return true;
  }

  /* ---------------- pairing ---------------- */

  private sweep() {
    const t = this.now();
    for (const [id, p] of this.pairings) {
      // keep finished entries for a while so the screen can read its result
      if (t > p.expiresAt + 5 * 60_000 || (p.deliveredAt && t > p.deliveredAt + DELIVERY_GRACE_MS)) this.pairings.delete(id);
    }
  }

  startPairing(userAgent: string, ip: string) {
    this.sweep();
    const pending = [...this.pairings.values()].filter((p) => p.state === "pending" && p.expiresAt > this.now());
    if (pending.length >= MAX_PENDING) throw new Error("too-many-pairings");
    const used = new Set(pending.map((p) => p.code));
    let code = sixDigits();
    while (used.has(code)) code = sixDigits();
    const createdAt = this.now();
    const p: Pairing = {
      pairingId: randomId(12),
      code,
      userAgent: userAgent.slice(0, 300),
      ip,
      createdAt,
      expiresAt: createdAt + PAIRING_TTL_MS,
      state: "pending",
    };
    this.pairings.set(p.pairingId, p);
    this.emit("pairing", p.pairingId);
    return { pairingId: p.pairingId, code: p.code, expiresAt: p.expiresAt };
  }

  pairingStatus(pairingId: string): PairStatusResponse | undefined {
    this.sweep();
    const p = this.pairings.get(pairingId);
    if (!p) return undefined;
    if (p.state === "approved" && p.deviceToken && p.device) {
      // the plaintext token is readable for a short grace period after the first read, then forgotten
      p.deliveredAt ??= this.now();
      if (this.now() - p.deliveredAt > DELIVERY_GRACE_MS) {
        p.deviceToken = undefined;
        return { status: "expired" };
      }
      return { status: "approved", deviceToken: p.deviceToken, device: p.device };
    }
    if (p.state === "approved") return { status: "expired" };
    if (p.state === "rejected") return { status: "rejected" };
    if (this.now() > p.expiresAt) return { status: "expired" };
    return { status: "pending" };
  }

  pendingPairings(): PendingPairing[] {
    this.sweep();
    const t = this.now();
    return [...this.pairings.values()]
      .filter((p) => p.state === "pending" && p.expiresAt > t)
      .map(({ pairingId, code, userAgent, ip, createdAt }) => ({ pairingId, code, userAgent, ip, createdAt }));
  }

  /** Accepts a pairingId or the 6-digit code. */
  private findPending(idOrCode: string): Pairing | undefined {
    const t = this.now();
    const p =
      this.pairings.get(idOrCode) ??
      [...this.pairings.values()].find((x) => x.code === idOrCode && x.state === "pending" && x.expiresAt > t);
    if (!p || p.state !== "pending" || p.expiresAt <= t) return undefined;
    return p;
  }

  approve(idOrCode: string, name: string, profileId: string): DeviceInfo | undefined {
    const p = this.findPending(idOrCode);
    if (!p) return undefined;
    const { device, token } = this.add(name, profileId);
    p.state = "approved";
    p.deviceToken = token;
    p.device = publicDevice(device);
    return p.device;
  }

  reject(idOrCode: string): boolean {
    const p = this.findPending(idOrCode);
    if (!p) return false;
    p.state = "rejected";
    return true;
  }
}

/** Admin sessions: in memory, 12 h. */
export class AdminSessions {
  private sessions = new Map<string, number>();
  constructor(private ttlMs = 12 * 3_600_000, private now: () => number = Date.now) {}
  create(): string {
    const s = randomToken(32);
    this.sessions.set(s, this.now() + this.ttlMs);
    return s;
  }
  valid(s: string | undefined | null): boolean {
    if (!s) return false;
    const exp = this.sessions.get(s);
    if (!exp) return false;
    if (exp < this.now()) {
      this.sessions.delete(s);
      return false;
    }
    return true;
  }
  revoke(s: string) {
    this.sessions.delete(s);
  }
}
