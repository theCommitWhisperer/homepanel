import dgram from "node:dgram";
import net from "node:net";

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
function inV4(ip: string, cidr: string): boolean {
  const [base, bitsS] = cidr.split("/");
  const bits = Number(bitsS);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base!) & mask);
}

/** Home (LAN) ranges. Tailscale/CGNAT 100.64.0.0/10 is deliberately NOT home. */
const HOME_V4 = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"];

/**
 * true when the request comes from outside the home LAN.
 * Loopback, RFC1918, link-local and IPv6 ULA/link-local are home; everything else
 * (public addresses, Tailscale 100.64.0.0/10, unknown) is remote.
 */
export function isRemoteIp(ipRaw: string | undefined | null): boolean {
  if (!ipRaw) return true;
  let ip = ipRaw.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const pct = ip.indexOf("%");
  if (pct >= 0) ip = ip.slice(0, pct);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  if (net.isIPv4(ip)) return !HOME_V4.some((c) => inV4(ip, c));
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1") return false;
    if (/^f[cd][0-9a-f]{2}:/.test(l)) {
      // fd7a:115c:a1e0::/48 is Tailscale's IPv6 range → remote
      return l.startsWith("fd7a:115c:a1e0:");
    }
    if (/^fe[89ab][0-9a-f]:/.test(l)) return false; // link-local
    return true;
  }
  return true;
}

export function parseMac(mac: string): Buffer | null {
  const hex = mac.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) return null;
  return Buffer.from(hex, "hex");
}

export function magicPacket(mac: string): Buffer {
  const m = parseMac(mac);
  if (!m) throw new Error(`invalid MAC address: ${mac}`);
  const buf = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) m.copy(buf, 6 + i * 6);
  return buf;
}

/** Send a Wake-on-LAN magic packet via UDP broadcast (ports 9 and 7). */
export async function sendWol(mac: string, broadcast = "255.255.255.255"): Promise<void> {
  const pkt = magicPacket(mac);
  const sock = dgram.createSocket("udp4");
  try {
    await new Promise<void>((res, rej) => sock.bind(0, () => res()).once("error", rej));
    sock.setBroadcast(true);
    for (const port of [9, 7]) {
      await new Promise<void>((res, rej) => sock.send(pkt, port, broadcast, (e) => (e ? rej(e) : res())));
    }
  } finally {
    sock.close();
  }
}
