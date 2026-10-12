import dgram from "node:dgram";

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
