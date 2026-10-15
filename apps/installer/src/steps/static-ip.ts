import { DEFAULT_HA_HOST } from "../constants.js";
import { setHaAddress, withHost } from "../ha/address.js";
import { waitForHa } from "../ha/discover.js";
import { showCmd, type Exec } from "../sys.js";
import type { Out } from "../ui.js";
import type { Step, StepContext } from "./types.js";

/* ------------------------------------------------------------------ */
/* IPv4 helpers                                                         */
/* ------------------------------------------------------------------ */

export function isIpv4(s: string): boolean {
  const p = s.trim().split(".");
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}

const toInt = (ip: string) => ip.split(".").reduce((a, x) => ((a << 8) | Number(x)) >>> 0, 0);
const toIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
const maskOf = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

export function parseCidr(s: string | undefined): { ip: string; prefix: number } | undefined {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(s?.trim() ?? "");
  if (!m || !isIpv4(m[1]!) || Number(m[2]) > 32) return undefined;
  return { ip: m[1]!, prefix: Number(m[2]) };
}

export function networkOf(ip: string, prefix: number): string {
  return toIp((toInt(ip) & maskOf(prefix)) >>> 0);
}

/** Usable host address in the same subnet (not the network or broadcast address). */
export function validHostIn(ip: string, net: { ip: string; prefix: number }): boolean {
  if (!isIpv4(ip)) return false;
  const mask = maskOf(net.prefix);
  const n = toInt(ip);
  if (((n & mask) >>> 0) !== ((toInt(net.ip) & mask) >>> 0)) return false;
  if (net.prefix >= 31) return true;
  const host = (n & ~mask) >>> 0;
  return host !== 0 && host !== (~mask >>> 0);
}

/** Body for Supervisor POST /network/interface/<iface>/update. */
export function staticIpPayload(ip: string, prefix: number, gateway: string, nameservers: string[]) {
  return { ipv4: { method: "static", address: [`${ip}/${prefix}`], gateway, nameservers } };
}

/** Does anything answer a ping at this address? (Looks for a TTL in the reply: Windows ping exits 0 on "unreachable".) */
export async function addressInUse(exec: Exec, ip: string): Promise<boolean> {
  const args = process.platform === "win32" ? ["-n", "1", "-w", "1000", ip] : ["-c", "1", "-W", "1", ip];
  const r = await exec("ping", args, { timeoutMs: 5000 });
  return /ttl[=:]/i.test(r.stdout);
}

/* ------------------------------------------------------------------ */
/* HA OS (Supervisor network API)                                       */
/* ------------------------------------------------------------------ */

export interface NetIface {
  interface: string;
  type?: string;
  enabled?: boolean;
  connected?: boolean;
  primary?: boolean;
  ipv4?: { method?: string; address?: string[]; gateway?: string | null; nameservers?: string[] };
}

export function pickPrimary(ifaces: NetIface[]): NetIface | undefined {
  const hasV4 = (i: NetIface) => !!parseCidr(i.ipv4?.address?.[0]);
  return (
    ifaces.find((i) => i.primary && i.connected !== false && hasV4(i)) ??
    ifaces.find((i) => i.type === "ethernet" && i.connected && hasV4(i)) ??
    ifaces.find((i) => i.connected && hasV4(i)) ??
    ifaces.find(hasV4)
  );
}

/* ------------------------------------------------------------------ */
/* Linux host running HA Container (NetworkManager)                     */
/* ------------------------------------------------------------------ */

export interface LinuxNet {
  device: string;
  ip: string;
  prefix: number;
  gateway: string;
  /** NetworkManager connection name, if NetworkManager manages the device */
  connection?: string;
  method?: string;
  dns: string[];
}

export async function linuxNet(exec: Exec): Promise<LinuxNet | undefined> {
  const route = await exec("ip", ["-4", "-j", "route", "show", "default"]);
  if (route.code !== 0) return undefined;
  let def: { gateway?: string; dev?: string } | undefined;
  try {
    def = (JSON.parse(route.stdout) as { gateway?: string; dev?: string }[])[0];
  } catch {
    return undefined;
  }
  if (!def?.dev || !def.gateway) return undefined;
  const addr = await exec("ip", ["-4", "-j", "addr", "show", "dev", def.dev]);
  let info: { local?: string; prefixlen?: number } | undefined;
  try {
    info = (JSON.parse(addr.stdout) as { addr_info?: { local?: string; prefixlen?: number }[] }[])[0]?.addr_info?.[0];
  } catch {
    info = undefined;
  }
  if (!info?.local || info.prefixlen === undefined) return undefined;
  const net: LinuxNet = { device: def.dev, ip: info.local, prefix: info.prefixlen, gateway: def.gateway, dns: [] };

  const cons = await exec("nmcli", ["-t", "-f", "NAME,DEVICE", "con", "show", "--active"]);
  if (cons.code === 0) {
    for (const line of cons.stdout.split("\n")) {
      // nmcli -t escapes ':' inside names as '\:'
      const i = line.search(/(?<!\\):[^:]*$/);
      if (i < 0) continue;
      if (line.slice(i + 1).trim() === def.dev) net.connection = line.slice(0, i).replace(/\\:/g, ":");
    }
    if (net.connection) {
      const m = await exec("nmcli", ["-g", "ipv4.method", "con", "show", net.connection]);
      net.method = m.stdout.trim() || undefined;
      const d = await exec("nmcli", ["-g", "IP4.DNS", "dev", "show", def.dev]);
      net.dns = d.stdout.split(/[\s|]+/).filter(isIpv4);
    }
  }
  return net;
}

export function nmcliCommands(connection: string, ip: string, prefix: number, gateway: string, dns: string[]): string[][] {
  return [
    ["nmcli", "con", "mod", connection, "ipv4.method", "manual", "ipv4.addresses", `${ip}/${prefix}`, "ipv4.gateway", gateway, "ipv4.dns", dns.join(",")],
    ["nmcli", "con", "up", connection],
  ];
}

/* ------------------------------------------------------------------ */

function printRouterGuide(out: Out, ip?: string) {
  out.info("Or let your router do it (works for any setup):");
  out.steps([
    "Open your router's admin page (often http://192.168.1.1) → LAN / DHCP → Address reservation (a.k.a. static lease / DHCP reservation).",
    `Pick the Home Assistant device (by its name or MAC address) and reserve ${ip ?? "the address you want"}.`,
    "Reboot Home Assistant (or unplug its network cable for 10 s) so it picks up the reserved address.",
    "Then run `homepanel ha-address <ip>` so HomePanel uses it.",
  ]);
}

async function askStaticIp(ctx: StepContext, cur: { ip: string; prefix: number }, gateway: string) {
  const net = `${networkOf(cur.ip, cur.prefix)}/${cur.prefix}`;
  const suggested = validHostIn(DEFAULT_HA_HOST, cur) ? DEFAULT_HA_HOST : cur.ip;
  const ip = (
    await ctx.prompt.input({
      message: `Static IP for Home Assistant (Enter = ${suggested}; must be in ${net}):`,
      default: suggested,
      validate: (v) => (validHostIn(v.trim(), cur) ? true : `Use a free address in ${net}`),
    })
  ).trim();
  const gw = (
    await ctx.prompt.input({
      message: "Router (gateway) address:",
      default: gateway,
      validate: (v) => (validHostIn(v.trim(), cur) ? true : `Use the router's address in ${net}`),
    })
  ).trim();
  if (ip === gw) throw new Error("The static IP can't be the router's address.");
  return { ip, gateway: gw };
}

async function checkFree(ctx: StepContext, ip: string, current: string): Promise<boolean> {
  if (ip === current) return true;
  if (await addressInUse(ctx.exec, ip)) {
    ctx.out.err(`Something on your network already answers at ${ip}. Pick another address (or free it up first).`);
    return false;
  }
  return true;
}

async function runHaOs(ctx: StepContext): Promise<"done" | "failed" | "manual"> {
  const { out, prompt } = ctx;
  const client = ctx.ha();
  const info = await client.withWs((s) => s.supervisor<{ interfaces?: NetIface[] }>("/network/info", "get"));
  const nic = pickPrimary(info?.interfaces ?? []);
  const cur = parseCidr(nic?.ipv4?.address?.[0]);
  if (!nic || !cur) {
    out.warn("Couldn't find Home Assistant's network interface.");
    printRouterGuide(out);
    return "manual";
  }
  const gateway = nic.ipv4?.gateway || "";
  out.info(`${nic.interface}: ${cur.ip}/${cur.prefix}, router ${gateway || "?"} (${nic.ipv4?.method === "static" ? "static" : "DHCP"}).`);
  const want = await askStaticIp(ctx, cur, gateway);
  if (!(await checkFree(ctx, want.ip, cur.ip))) return "failed";
  const dns = nic.ipv4?.nameservers?.filter(isIpv4).length ? nic.ipv4.nameservers!.filter(isIpv4) : [want.gateway];
  const payload = staticIpPayload(want.ip, cur.prefix, want.gateway, dns);
  out.info(`This sets ${nic.interface} to a fixed address through the Supervisor API (same as Settings → System → Network):`);
  out.code(`POST /network/interface/${nic.interface}/update\n${JSON.stringify(payload, null, 2)}`);
  out.info("Tip: pick an address outside your router's DHCP pool (or also reserve it in the router) so nothing else is handed it.");
  const moving = want.ip !== cur.ip;
  if (moving) out.warn(`Home Assistant will drop off ${cur.ip} and come back on ${want.ip} (takes ~30 s).`);
  if (!(await prompt.confirm({ message: "Apply it now?", default: true }))) {
    printRouterGuide(out, want.ip);
    return "manual";
  }
  try {
    await client.withWs((s) => s.supervisor(`/network/interface/${nic.interface}/update`, "post", payload, 60));
  } catch (e) {
    // when the address changes, the connection carrying the request usually dies mid-answer
    if (!moving) throw e;
    out.info(`Connection dropped while switching (expected): ${(e as Error).message}`);
  }
  const newUrl = withHost(client.url, want.ip);
  if (moving) {
    out.info(`Waiting for Home Assistant at ${newUrl}…`);
    const up = await waitForHa(newUrl, {
      fetchImpl: ctx.fetchImpl,
      timeoutMs: ctx.noWait ? 2000 : 180_000,
      intervalMs: ctx.noWait ? 200 : 5000,
    });
    if (!up) out.warn(`Not answering at ${newUrl} yet. Saved it anyway; check again with \`homepanel doctor\`.`);
  }
  for (const c of setHaAddress(ctx.store, newUrl)) out.info(c);
  out.ok(`Home Assistant now has the fixed address ${want.ip}.`);
  if (moving && ctx.store.state.agents?.length)
    out.warn(`PCs set up earlier still point at ${cur.ip}: change mqtt.url in C:\\ProgramData\\HomePanel\\agent.yaml on each, or re-run the agent installer.`);
  return "done";
}

async function runLinux(ctx: StepContext): Promise<"done" | "failed" | "manual"> {
  const { out, prompt, exec } = ctx;
  if (process.platform !== "linux") {
    out.warn("Run this step on the Linux machine that hosts Home Assistant.");
    printRouterGuide(out);
    return "manual";
  }
  const net = await linuxNet(exec);
  if (!net) {
    out.warn("Couldn't read this machine's network settings (`ip route`).");
    printRouterGuide(out);
    return "manual";
  }
  out.info(`${net.device}: ${net.ip}/${net.prefix}, router ${net.gateway}${net.method ? ` (${net.method === "manual" ? "static" : "DHCP"})` : ""}.`);
  const want = await askStaticIp(ctx, net, net.gateway);
  if (!(await checkFree(ctx, want.ip, net.ip))) return "failed";
  const dns = net.dns.length ? net.dns : [want.gateway];
  if (!net.connection) {
    out.warn(`NetworkManager doesn't manage ${net.device} (Ubuntu Server uses netplan). Put this in /etc/netplan/01-homepanel.yaml, then run \`sudo netplan apply\`:`);
    out.code(
      [
        "network:",
        "  version: 2",
        "  ethernets:",
        `    ${net.device}:`,
        "      dhcp4: false",
        `      addresses: [${want.ip}/${net.prefix}]`,
        `      routes: [{ to: default, via: ${want.gateway} }]`,
        `      nameservers: { addresses: [${dns.join(", ")}] }`,
      ].join("\n"),
    );
    printRouterGuide(out, want.ip);
    return "manual";
  }
  const cmds = nmcliCommands(net.connection, want.ip, net.prefix, want.gateway, dns);
  out.info("These commands give this machine a fixed address (needs sudo):");
  out.code(cmds.map((c) => showCmd("sudo", c)).join("\n"));
  if (want.ip !== net.ip) out.warn(`If you're connected over SSH to ${net.ip}, reconnect to ${want.ip} afterwards.`);
  if (!(await prompt.confirm({ message: "Run them now?", default: true }))) return "manual";
  for (const c of cmds) {
    const r = await exec("sudo", c, { inherit: true, timeoutMs: 60_000 });
    if (r.code !== 0) {
      out.err(`${showCmd("sudo", c)} failed.`);
      return "failed";
    }
  }
  const s = ctx.store.state.serverUrl;
  if (s && new URL(s).hostname === net.ip) ctx.store.update({ serverUrl: withHost(s, want.ip) });
  out.ok(`This machine now has the fixed address ${want.ip}.`);
  return "done";
}

export const staticIpStep: Step = {
  id: "staticip",
  title: "Fixed IP address",
  summary: "Give Home Assistant a static IP so screens and PCs can always find it.",
  plan: (ctx) =>
    ctx.store.state.haOs === false
      ? "Read this machine's address (ip route / nmcli), ask which fixed IP you want, check nothing else uses it, then run `sudo nmcli con mod <connection> ipv4.method manual …` and `sudo nmcli con up <connection>` (shown and asked first)."
      : "Through the Supervisor API: read Home Assistant's network interface, ask which fixed IP you want (default " +
        `${DEFAULT_HA_HOST}), check nothing else uses it, then switch the interface from DHCP to that static address ` +
        "(same as Settings → System → Network). Saved addresses in HomePanel are updated to match.",
  explain:
    "With DHCP your router may hand Home Assistant a different address after a reboot or power cut, and every screen, " +
    "PC agent and bookmark pointing at the old one breaks. A static address (or a router DHCP reservation) keeps it fixed. " +
    "On HA OS the installer sets it through the Supervisor network API; on a Linux Docker host it uses NetworkManager (nmcli).",
  async detect(ctx) {
    if (ctx.store.state.haOs === false) {
      if (process.platform !== "linux") return { done: false, detail: "Run on the Linux host to check its address." };
      const net = await linuxNet(ctx.exec);
      if (net?.method === "manual") return { done: true, detail: `${net.device} has the fixed address ${net.ip}.` };
      return { done: false, detail: net ? `${net.device} uses DHCP (currently ${net.ip}).` : "Couldn't read the network settings." };
    }
    if (!ctx.store.secrets.haToken) return { done: false, detail: "Needs the HA token first." };
    try {
      const info = await ctx.ha().withWs((s) => s.supervisor<{ interfaces?: NetIface[] }>("/network/info", "get"));
      const nic = pickPrimary(info?.interfaces ?? []);
      const ip = parseCidr(nic?.ipv4?.address?.[0])?.ip;
      if (nic?.ipv4?.method === "static") return { done: true, detail: `${nic.interface} has the fixed address ${ip}.` };
      return { done: false, detail: nic ? `${nic.interface} uses DHCP (currently ${ip ?? "?"}).` : "No network interface found." };
    } catch (e) {
      return { done: false, detail: `Can't check: ${(e as Error).message}` };
    }
  },
  async run(ctx) {
    if (ctx.store.state.haOs === false) return runLinux(ctx);
    if (!ctx.store.secrets.haToken) {
      ctx.out.err("Create the HA token first (token step).");
      printRouterGuide(ctx.out);
      return "failed";
    }
    try {
      return await runHaOs(ctx);
    } catch (e) {
      const msg = (e as Error).message;
      if (/unknown.command/i.test(msg)) {
        ctx.out.warn("This Home Assistant has no Supervisor (not HA OS), so it can't set its own IP.");
        printRouterGuide(ctx.out);
        return "manual";
      }
      throw e;
    }
  },
};
