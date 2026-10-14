/**
 * Home Assistant OS on Proxmox VE, done for you: the wizard connects to the Proxmox host over SSH
 * (root password typed here, kept in memory only), shows the host key and asks to trust it, then runs
 * OUR OWN non-interactive bash on the host (no whiptail):
 *
 *   pveversion → reuse a VM named haos / tagged homepanel, or: next VMID, storage (local-lvm, else the
 *   first one with "images"), bridge vmbr0 → download the latest stable haos_ova-<ver>.qcow2.xz → xz -d →
 *   qm create (q35, OVMF, 2 cores, 4 GB, host CPU, virtio NIC, guest agent, start on boot) → EFI disk →
 *   qm disk import → scsi0 (discard, ssd) → 32G → boot from scsi0 → delete the image
 *   → ZBT-1 passthrough (lsusb 10c4:ea60) → qm start → poll the guest agent for the VM's LAN IP.
 *
 * The flags follow community-scripts' vm/haos-vm.sh. Every part is idempotent (an interrupted run
 * continues where it stopped: the VMID is saved before anything is created, the download resumes).
 */
import { connect as netConnect } from "node:net";
import { HAOS_VERSION } from "../constants.js";
import { normalizeHaUrl } from "../ha/client.js";
import { lanIps } from "../sys.js";
import type { StepStatus } from "../state.js";
import { saveHaUrl } from "../steps/detect.js";
import type { StepContext } from "../steps/types.js";
import type { Out } from "../ui.js";
import { color } from "../ui.js";
import { HostKeyRejected, hostKeyFile, ssh2Connect, type HostKeyInfo, type SshConnect, type SshSession } from "./ssh.js";

export const ZBT1_USB_ID = "10c4:ea60";
export const VM_NAME = "haos";
export const VM_TAG = "homepanel";
export const PVE_PORT = 8006;
/** where the image is downloaded on the Proxmox host (removed at the end) */
export const HOST_WORK_DIR = "/var/tmp/homepanel-haos";

export interface ProxmoxDeps {
  connect: SshConnect;
  /** TCP connect test (LAN scan for the Proxmox web UI on 8006) */
  probe(host: string, port: number, timeoutMs: number): Promise<boolean>;
  /** this PC's LAN IPv4 (the /24 that is scanned) */
  lanIp(): string | undefined;
  sleep(ms: number): Promise<void>;
  /** how long to wait for the VM's IP from the guest agent, and how often to ask */
  ipTimeoutMs: number;
  pollMs: number;
}

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export function defaultProxmoxDeps(): ProxmoxDeps {
  return {
    connect: ssh2Connect,
    probe: tcpProbe,
    lanIp: () => lanIps().find((ip) => /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(ip)) ?? lanIps()[0],
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ipTimeoutMs: 5 * 60_000,
    pollMs: 5000,
  };
}

/* ------------------------------------------------------------------ */
/* pure helpers (tested)                                                */
/* ------------------------------------------------------------------ */

/** Single-quote for bash. */
export function shq(s: string | number): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export const haosImageUrl = (version: string) =>
  `https://github.com/home-assistant/operating-system/releases/download/${version}/haos_ova-${version}.qcow2.xz`;

/** Latest stable HA OS version: home-assistant/version stable.json (.hassos.ova), else the releases API, else the built-in one. */
export async function latestHaosVersion(fetchImpl: typeof fetch): Promise<{ version: string; source: string }> {
  const ok = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+(\.\d+)?$/.test(v);
  try {
    const r = await fetchImpl("https://raw.githubusercontent.com/home-assistant/version/master/stable.json", { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = (await r.json()) as { hassos?: { ova?: string } };
      if (ok(j.hassos?.ova)) return { version: j.hassos!.ova!, source: "home-assistant/version stable.json" };
    }
  } catch {
    /* next */
  }
  try {
    const r = await fetchImpl("https://api.github.com/repos/home-assistant/operating-system/releases/latest", {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j = (await r.json()) as { tag_name?: string };
      if (ok(j.tag_name)) return { version: j.tag_name!, source: "GitHub releases" };
    }
  } catch {
    /* next */
  }
  return { version: HAOS_VERSION, source: "built in (could not check online)" };
}

export interface PveStorage {
  name: string;
  type: string;
  active: boolean;
  availKiB: number;
}

/** `pvesm status --content images` table → storages. */
export function parseStorages(text: string): PveStorage[] {
  const out: PveStorage[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[0] === "Name") continue;
    out.push({ name: f[0]!, type: f[1]!, active: f[2] === "active", availKiB: Number(f[5] ?? 0) || 0 });
  }
  return out;
}

/** local-lvm when it can hold images, else the first active storage with "images" content. */
export function pickStorage(list: PveStorage[]): string | undefined {
  const active = list.filter((s) => s.active);
  return (active.find((s) => s.name === "local-lvm") ?? active[0])?.name;
}

export function pickBridge(netDevs: string): string | undefined {
  const bridges = netDevs.split(/\s+/).filter((d) => /^vmbr\d+$/.test(d)).sort();
  return bridges.includes("vmbr0") ? "vmbr0" : bridges[0];
}

export interface PveVm {
  vmid: number;
  name?: string;
  status?: string;
  node?: string;
  tags: string[];
}

/** `pvesh get /cluster/resources --type vm --output-format json` → QEMU VMs. */
export function parseVms(json: string): PveVm[] {
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((v) => v && typeof v === "object" && (v.type === "qemu" || String(v.id ?? "").startsWith("qemu/")) && !v.template)
    .map((v) => ({
      vmid: Number(v.vmid ?? String(v.id).split("/")[1]),
      name: v.name,
      status: v.status,
      node: v.node,
      tags: String(v.tags ?? "")
        .split(/[;,\s]+/)
        .filter(Boolean),
    }));
}

/** VMs that look like Home Assistant OS: ours (name haos / tag homepanel) or the community script's. */
export function findHaVms(vms: PveVm[]): PveVm[] {
  const ours = (v: PveVm) => v.name === VM_NAME || v.tags.includes(VM_TAG);
  const likely = (v: PveVm) => /^(haos|homeassistant|home-assistant|hassos)/i.test(v.name ?? "");
  return [...vms.filter(ours), ...vms.filter((v) => !ours(v) && likely(v))];
}

/**
 * `qm guest cmd <id> network-get-interfaces` JSON → the VM's LAN IPv4. Skips loopback, link-local,
 * Docker/hassio (172.30.32.0/23, 172.17.x) and veth interfaces; prefers the Proxmox host's /24.
 */
export function pickGuestIp(json: string, preferPrefix?: string): string | undefined {
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const ips: string[] = [];
  for (const nic of list as { name?: string; "ip-addresses"?: { "ip-address-type"?: string; "ip-address"?: string }[] }[]) {
    if (/^(lo|docker|hassio|veth|br-)/.test(nic.name ?? "")) continue;
    for (const a of nic["ip-addresses"] ?? []) {
      const ip = a["ip-address"] ?? "";
      if (a["ip-address-type"] !== "ipv4" || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
      if (/^(127\.|169\.254\.|172\.30\.(3[23])\.|172\.17\.)/.test(ip)) continue;
      ips.push(ip);
    }
  }
  return (preferPrefix ? ips.find((ip) => ip.startsWith(preferPrefix)) : undefined) ?? ips[0];
}

export interface VmPlan {
  vmid: number;
  storage: string;
  bridge: string;
  version: string;
  url?: string;
  diskSize?: string;
  cores?: number;
  memoryMb?: number;
  /** download folder on the host (default /var/tmp/homepanel-haos) */
  workDir?: string;
}

/** `qm create` arguments (community-scripts haos-vm.sh defaults, plus host CPU and our name/tag). */
export function qmCreateArgs(p: VmPlan): string[] {
  return [
    "qm", "create", String(p.vmid),
    "-name", VM_NAME,
    "-tags", VM_TAG,
    "-bios", "ovmf",
    "-machine", "q35",
    "-agent", "1",
    "-tablet", "0",
    "-localtime", "1",
    "-cores", String(p.cores ?? 2),
    "-memory", String(p.memoryMb ?? 4096),
    "-cpu", "host",
    "-net0", `virtio,bridge=${p.bridge}`,
    "-scsihw", "virtio-scsi-pci",
    "-ostype", "l26",
    "-onboot", "1",
    "-serial0", "socket",
  ];
}

/**
 * The bash we send to `bash -s` on the Proxmox host. Non-interactive and idempotent: it keeps an
 * existing VM shell, EFI disk and system disk, resumes a partial download, and always removes its
 * work folder at the end. Lines starting with "### " are step headings; "@@ " lines are results.
 */
export function haosVmScript(p: VmPlan): string {
  const url = p.url ?? haosImageUrl(p.version);
  const size = p.diskSize ?? "32G";
  return `set -euo pipefail
exec 2>&1
trap 'echo "@@ error line=$LINENO command=$BASH_COMMAND"' ERR
ID=${shq(p.vmid)}
STORAGE=${shq(p.storage)}
VER=${shq(p.version)}
URL=${shq(url)}
WORK=${shq(p.workDir ?? HOST_WORK_DIR)}
IMG="$WORK/haos_ova-$VER.qcow2"
has() { qm config "$ID" 2>/dev/null | grep -q "^$1:"; }

echo "### VM $ID"
if qm status "$ID" >/dev/null 2>&1; then
  echo "VM $ID already exists; keeping it."
else
  ${qmCreateArgs(p).map((a, i) => (i < 3 ? a : shq(a))).join(" ")}
  echo "Created VM $ID (${VM_NAME}, tag ${VM_TAG})."
fi

echo "### EFI disk"
if has efidisk0; then echo "Already there."; else qm set "$ID" -efidisk0 "$STORAGE:0,efitype=4m"; fi

echo "### Home Assistant OS $VER system disk"
if has scsi0; then
  echo "System disk already attached."
else
  mkdir -p "$WORK"
  if [ ! -s "$IMG" ]; then
    if [ ! -s "$IMG.xz" ]; then
      echo "Downloading $URL"
      # progress ticker (sleep in the background + wait, so killing the ticker stops it at once)
      ( trap 'kill "$S" 2>/dev/null; exit 0' TERM
        while :; do sleep 15 & S=$!; wait "$S"; [ -f "$IMG.xz.part" ] && echo "  ... $(( $(stat -c %s "$IMG.xz.part") / 1048576 )) MB downloaded"; done ) &
      TICK=$!
      if ! curl -fL --retry 5 --retry-delay 5 -C - -sS -o "$IMG.xz.part" "$URL"; then
        kill "$TICK" 2>/dev/null || true
        echo "@@ error download failed (run setup again to resume)"
        exit 1
      fi
      kill "$TICK" 2>/dev/null || true
      mv -f "$IMG.xz.part" "$IMG.xz"
    fi
    echo "Unpacking (xz)..."
    xz -dc "$IMG.xz" > "$IMG.tmp"
    mv -f "$IMG.tmp" "$IMG"
    rm -f "$IMG.xz"
  fi
  echo "Importing into $STORAGE..."
  if qm disk import --help >/dev/null 2>&1; then IMPORT=(qm disk import); else IMPORT=(qm importdisk); fi
  if ! OUT="$("\${IMPORT[@]}" "$ID" "$IMG" "$STORAGE" --format raw 2>&1)"; then
    echo "$OUT" | tail -n 5
    echo "@@ error disk import failed"
    exit 1
  fi
  echo "$OUT" | grep -v -i 'transferred' | tail -n 3 || true
  REF="$(printf '%s\\n' "$OUT" | sed -n "s/.*successfully imported disk '\\([^']*\\)'.*/\\1/p" | tail -n 1)"
  [ -n "$REF" ] || REF="$(qm config "$ID" | sed -n 's/^unused[0-9]*: *\\([^,]*\\).*/\\1/p' | head -n 1)"
  if [ -z "$REF" ]; then echo "@@ error could not find the imported disk"; exit 1; fi
  qm set "$ID" -scsi0 "$REF,discard=on,ssd=1"
fi

echo "### Disk size and boot order"
qm resize "$ID" scsi0 ${shq(size)} >/dev/null 2>&1 && echo "System disk is ${size}." || echo "System disk is already ${size} or larger."
qm set "$ID" -boot order=scsi0 >/dev/null
echo "Boots from scsi0."

echo "### Cleaning up"
rm -rf "$WORK"
echo "Removed the downloaded image."
echo "@@ ready vmid=$ID"
`;
}

/* ------------------------------------------------------------------ */
/* streamed output                                                      */
/* ------------------------------------------------------------------ */

/** Turns the host's streamed output into headings / indented lines; collects "@@" results. */
export function hostPrinter(out: Out) {
  let buf = "";
  const results: string[] = [];
  const handle = (line: string) => {
    if (line.startsWith("### ")) out.line(color.bold(color.cyan(`  ▸ ${line.slice(4)}`)));
    else if (line.startsWith("@@ ")) {
      results.push(line.slice(3));
      if (line.startsWith("@@ error")) out.err(line.slice(9));
    } else if (line.trim()) out.line(`      ${line}`);
  };
  return {
    results,
    push(t: string) {
      buf += t.replace(/\r\n?/g, "\n");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    flush() {
      if (buf) handle(buf);
      buf = "";
    },
  };
}

/* ------------------------------------------------------------------ */
/* the flow                                                             */
/* ------------------------------------------------------------------ */

function deps(ctx: StepContext): ProxmoxDeps {
  return { ...defaultProxmoxDeps(), ...(ctx.proxmox ?? {}) };
}

async function scanForProxmox(d: ProxmoxDeps): Promise<string[]> {
  const ip = d.lanIp();
  if (!ip) return [];
  const base = ip.split(".").slice(0, 3).join(".");
  const cands = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`).filter((h) => h !== ip);
  const found: string[] = [];
  for (let i = 0; i < cands.length; i += 64) {
    const res = await Promise.all(cands.slice(i, i + 64).map(async (h) => ((await d.probe(h, PVE_PORT, 700)) ? h : undefined)));
    for (const h of res) if (h) found.push(h);
  }
  return found;
}

async function askHost(ctx: StepContext, d: ProxmoxDeps): Promise<string | undefined> {
  const { out, prompt } = ctx;
  const saved = ctx.store.state.proxmox?.host;
  out.info(`Looking for Proxmox on your network (port ${PVE_PORT}, a few seconds)…`);
  const found = await scanForProxmox(d);
  const list = [...new Set([...(saved ? [saved] : []), ...found])];
  if (found.length) out.ok(`Found: ${found.map((h) => `https://${h}:${PVE_PORT}`).join(", ")}`);
  else out.warn("No Proxmox web UI answered on this network.");
  const pick = await prompt.select<string>({
    message: "Which Proxmox host?",
    choices: [
      ...list.map((h) => ({ value: h, name: `${h}${h === saved ? " (used before)" : ""}` })),
      { value: "__type", name: "Type its IP address" },
      { value: "__quit", name: "Cancel" },
    ],
    default: list[0],
  });
  if (pick === "__quit") return undefined;
  if (pick !== "__type") return pick;
  const v = await prompt.input({
    message: "Proxmox IP address (the one in https://<ip>:8006):",
    validate: (x) => (/^[a-z0-9.-]+$/i.test(x.trim().replace(/^https?:\/\//, "").replace(/:\d+\/?$/, "")) ? true : "e.g. 192.168.1.251"),
  });
  return v.trim().replace(/^https?:\/\//, "").replace(/:\d+\/?$/, "");
}

async function connect(ctx: StepContext, d: ProxmoxDeps, host: string): Promise<SshSession | undefined> {
  const { out, prompt } = ctx;
  for (let attempt = 0; attempt < 4; attempt++) {
    const password = await prompt.password({
      message: `Proxmox root password for ${host} (hidden; used for this SSH session only, never saved):`,
      validate: (v) => (v ? true : "Required"),
    });
    ctx.vault.add("proxmox_root_password", password); // in memory only: keeps it out of AI transcripts
    const verifyHostKey = async (k: HostKeyInfo): Promise<boolean> => {
      const fp = `${k.type} ${k.sha256}`;
      const known = ctx.store.state.proxmox?.host === host ? ctx.store.state.proxmox?.hostKey : undefined;
      if (known === fp) {
        out.ok(`SSH host key matches the one you trusted before (${k.sha256}).`);
        return true;
      }
      if (known) {
        out.warn(`The SSH host key of ${host} CHANGED since you trusted it.`);
        out.warn(`  before: ${known}\n  now:    ${fp}`);
        out.info("That happens after reinstalling Proxmox. If you did not, someone may be intercepting the connection.");
      } else {
        out.line(`  SSH host key of ${color.bold(host)}: ${color.bold(k.type)} ${color.bold(k.sha256)}`);
        out.info(`To compare: Proxmox web UI → your node → Shell →  ssh-keygen -lf ${hostKeyFile(k.type)}`);
      }
      const ok = await prompt.confirm({ message: known ? "Trust the NEW key anyway?" : "Trust this key and connect?", default: !known });
      if (ok) ctx.store.update({ proxmox: { ...(ctx.store.state.proxmox ?? { host }), host, hostKey: fp } });
      return ok;
    };
    try {
      const s = await d.connect({ host, username: "root", password, verifyHostKey });
      out.ok(`Connected to ${host} over SSH as root.`);
      return s;
    } catch (e) {
      const err = e as Error & { code?: string; level?: string };
      if (err instanceof HostKeyRejected || err.name === "HostKeyRejected") {
        out.info("Not connected. Nothing was changed.");
        return undefined;
      }
      const msg = err.message ?? String(e);
      if (/authentication methods failed|auth/i.test(msg) || err.level === "client-authentication") {
        out.warn("Proxmox rejected that password (user root, the same login as the web UI with realm 'Linux PAM').");
        if (!(await prompt.confirm({ message: "Try again?", default: true }))) return undefined;
        continue;
      }
      out.err(`Could not connect to ${host}:22: ${msg}`);
      out.steps([
        `Check the address: the Proxmox web UI should open at https://${host}:${PVE_PORT}.`,
        "SSH is on by default in Proxmox VE; if you turned it off: web UI → node → System → ssh → Start.",
        "Then run setup again (or pick Proxmox again).",
      ]);
      return undefined;
    }
  }
  return undefined;
}

async function run(s: SshSession, cmd: string, timeoutMs = 60_000) {
  return s.exec(cmd, { timeoutMs });
}

/** Create (or reuse) the HA OS VM on Proxmox and find its IP. Returns the wizard step status. */
export async function setupProxmox(ctx: StepContext): Promise<StepStatus> {
  const { out, prompt } = ctx;
  const d = deps(ctx);
  out.line();
  out.line(color.bold("  Home Assistant OS on Proxmox — automatic"));
  out.line(
    "  The installer logs in to the Proxmox host over SSH (root password typed here, kept in memory only),\n" +
      "  shows you the host key, then creates the VM with plain qm commands you can read below.",
  );
  const host = await askHost(ctx, d);
  if (!host) return "manual";
  ctx.store.update({ proxmox: { ...(ctx.store.state.proxmox?.host === host ? ctx.store.state.proxmox : {}), host } });
  const s = await connect(ctx, d, host);
  if (!s) return "manual";
  try {
    return await onHost(ctx, d, s, host);
  } finally {
    s.close();
  }
}

async function onHost(ctx: StepContext, d: ProxmoxDeps, s: SshSession, host: string): Promise<StepStatus> {
  const { out, prompt, store } = ctx;
  const pv = await run(s, "pveversion");
  if (pv.code !== 0) {
    out.err(`${host} does not look like Proxmox VE (pveversion: ${(pv.stderr || pv.stdout).trim().slice(0, 200) || `exit ${pv.code}`}).`);
    return "failed";
  }
  out.ok(`Proxmox VE: ${pv.stdout.trim().split(/\r?\n/)[0]}`);

  // 1. existing VM?
  const vms = parseVms((await run(s, "pvesh get /cluster/resources --type vm --output-format json")).stdout);
  const savedId = store.state.proxmox?.vmid;
  const candidates = findHaVms(vms);
  let vmid: number | undefined;
  let create = true;
  const resumable = candidates.find((v) => v.vmid === savedId && v.tags.includes(VM_TAG));
  if (resumable && store.state.proxmox?.created) {
    out.ok(`VM ${resumable.vmid} (${resumable.name}) was created by an earlier run; continuing with it.`);
    vmid = resumable.vmid;
  } else if (candidates.length) {
    for (const v of candidates) out.info(`Found VM ${v.vmid} "${v.name ?? "?"}" (${v.status ?? "?"}${v.tags.length ? `, tags ${v.tags.join(",")}` : ""}).`);
    const pick = await prompt.select<string>({
      message: "Home Assistant already seems to exist on this Proxmox. Use it?",
      choices: [
        ...candidates.map((v) => ({ value: String(v.vmid), name: `Use VM ${v.vmid} "${v.name ?? "?"}" (skip creating one)` })),
        { value: "new", name: "Create a new Home Assistant OS VM anyway" },
        { value: "quit", name: "Cancel" },
      ],
      default: String(candidates[0]!.vmid),
    });
    if (pick === "quit") return "manual";
    if (pick !== "new") {
      vmid = Number(pick);
      create = false;
      store.update({ proxmox: { ...store.state.proxmox!, vmid, created: false } });
    }
  }

  // 2. create (or finish creating) it
  if (create) {
    const r = await createVm(ctx, d, s, vmid);
    if (r === undefined) return "manual";
    if (r === false) return "failed";
    vmid = r;
  }
  const id = vmid!;

  // 3. ZBT-1
  await passZbt1(ctx, s, id);

  // 4. start
  const st = await run(s, `qm status ${id}`);
  if (/status:\s*running/.test(st.stdout)) out.ok(`VM ${id} is running.`);
  else {
    out.info(`Starting VM ${id}…`);
    const r = await run(s, `qm start ${id}`, 120_000);
    if (r.code !== 0) {
      out.err(`qm start ${id} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      out.info("Open the Proxmox web UI → the VM → Console to see why, then run setup again.");
      return "failed";
    }
    out.ok(`VM ${id} started.`);
  }

  // 5. its IP
  const ip = await waitForVmIp(ctx, d, s, id, host);
  let haIp = ip;
  if (!haIp) {
    out.warn("The VM did not report an IP address yet (its guest agent starts about a minute after boot).");
    out.info(`Proxmox web UI → VM ${id} → Console shows the address (or check your router for "homeassistant").`);
    const typed = await prompt.input({ message: "Home Assistant address (Enter = homeassistant.local):", default: "homeassistant.local" });
    haIp = typed.trim() || "homeassistant.local";
  }
  store.update({ hostType: "proxmox", haOs: true, proxmox: { ...store.state.proxmox!, vmid: id, haIp } });
  await saveHaUrl(ctx, normalizeHaUrl(haIp));
  out.ok(`Home Assistant: ${color.bold(store.state.haUrl!)}  (saved; next the wizard waits for it to finish preparing)`);
  out.info("First boot downloads Home Assistant (~700 MB) and can take 10–20 minutes. You can watch it at that address.");
  return "done";
}

/** Returns the VMID, undefined when the user declined, false on failure. */
async function createVm(ctx: StepContext, _d: ProxmoxDeps, s: SshSession, given?: number): Promise<number | undefined | false> {
  const { out, prompt, store } = ctx;
  let vmid = given ?? (store.state.proxmox?.created ? store.state.proxmox.vmid : undefined);
  if (vmid !== undefined) {
    // only keep a saved id when it is still free or still ours
    const st = await run(s, `qm config ${vmid}`);
    if (st.code === 0 && !/^tags:.*homepanel/m.test(st.stdout)) vmid = undefined;
  }
  if (vmid === undefined) {
    const n = await run(s, "pvesh get /cluster/nextid");
    vmid = Number(n.stdout.trim().replace(/"/g, ""));
    if (!Number.isInteger(vmid) || vmid < 100) {
      out.err(`Could not get a free VM id (pvesh get /cluster/nextid: ${(n.stderr || n.stdout).trim().slice(0, 200)}).`);
      return false;
    }
  }
  const storages = parseStorages((await run(s, "pvesm status --content images")).stdout);
  const storage = pickStorage(storages);
  if (!storage) {
    out.err("No active Proxmox storage can hold VM disks (pvesm status --content images is empty).");
    out.info("Proxmox web UI → Datacenter → Storage: enable 'Disk image' content on one, then run setup again.");
    return false;
  }
  const bridge = pickBridge((await run(s, "ls /sys/class/net")).stdout);
  if (!bridge) {
    out.err("No Linux bridge (vmbr0) on this Proxmox host, so the VM could not reach your network.");
    out.info("Proxmox web UI → node → System → Network → Create → Linux Bridge (vmbr0, port = your network card).");
    return false;
  }
  const { version, source } = await latestHaosVersion(ctx.fetchImpl);
  const plan: VmPlan = { vmid, storage, bridge, version };
  store.update({ proxmox: { ...store.state.proxmox!, vmid, storage, bridge, haosVersion: version, created: true } });

  out.line();
  out.line(`  New VM ${color.bold(String(vmid))} "${VM_NAME}": Home Assistant OS ${color.bold(version)} (${source}), 2 cores, 4 GB RAM, 32 GB disk on ${color.bold(storage)}, network ${bridge}, starts with Proxmox.`);
  out.line("  This runs on the Proxmox host:");
  out.code(
    [
      `curl -fL -o ${HOST_WORK_DIR}/haos_ova-${version}.qcow2.xz ${haosImageUrl(version)}   (~400 MB)`,
      `xz -d ${HOST_WORK_DIR}/haos_ova-${version}.qcow2.xz`,
      qmCreateArgs(plan).join(" "),
      `qm set ${vmid} -efidisk0 ${storage}:0,efitype=4m`,
      `qm disk import ${vmid} ${HOST_WORK_DIR}/haos_ova-${version}.qcow2 ${storage} --format raw   (older Proxmox: qm importdisk)`,
      `qm set ${vmid} -scsi0 <imported disk>,discard=on,ssd=1`,
      `qm resize ${vmid} scsi0 32G`,
      `qm set ${vmid} -boot order=scsi0`,
      `rm -rf ${HOST_WORK_DIR}`,
    ].join("\n"),
  );
  if (!(await prompt.confirm({ message: "Create it now?", default: true }))) return undefined;

  const p = hostPrinter(out);
  const r = await s.exec("bash -s", { stdin: haosVmScript(plan), onData: (t) => p.push(t), timeoutMs: 60 * 60_000 });
  p.flush();
  if (r.code !== 0 || !p.results.some((x) => x.startsWith("ready"))) {
    out.err(`Creating the VM stopped (exit ${r.code}). Run setup again: finished parts are kept and the download resumes.`);
    return false;
  }
  out.ok(`VM ${vmid} is ready.`);
  return vmid;
}

async function passZbt1(ctx: StepContext, s: SshSession, id: number) {
  const { out } = ctx;
  const usb = await run(s, "lsusb");
  const line = usb.stdout.split(/\r?\n/).find((l) => l.toLowerCase().includes(ZBT1_USB_ID));
  if (!line) {
    out.warn(`ZBT-1 not found on the Proxmox host (lsusb shows no ${ZBT1_USB_ID}).`);
    out.info(
      `Plug it into the mini PC (best on a USB extension cable) and run this step again — or later: Proxmox web UI → VM ${id} → Hardware → Add → USB Device → Use USB Vendor/Device ID → ${ZBT1_USB_ID}.`,
    );
    return;
  }
  const cfg = await run(s, `qm config ${id}`);
  if (new RegExp(`^usb\\d+:.*host=${ZBT1_USB_ID}`, "mi").test(cfg.stdout)) {
    out.ok(`ZBT-1 (${line.replace(/^.*ID\s+/, "")}) is already passed through to VM ${id}.`);
    return;
  }
  const slot = [0, 1, 2, 3, 4].find((n) => !new RegExp(`^usb${n}:`, "m").test(cfg.stdout)) ?? 0;
  const r = await run(s, `qm set ${id} -usb${slot} host=${ZBT1_USB_ID}`);
  if (r.code === 0) out.ok(`ZBT-1 found (${line.replace(/^.*ID\s+/, "")}) and passed through to VM ${id} as usb${slot}.`);
  else out.warn(`Could not pass the ZBT-1 through: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
}

async function waitForVmIp(ctx: StepContext, d: ProxmoxDeps, s: SshSession, id: number, host: string): Promise<string | undefined> {
  const { out } = ctx;
  const prefix = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split(".").slice(0, 3).join(".") + "." : undefined;
  out.info("Waiting for the VM to report its IP address (QEMU guest agent; up to 5 minutes)…");
  const tries = Math.max(1, Math.ceil(d.ipTimeoutMs / d.pollMs));
  for (let i = 0; ; i++) {
    const r = await run(s, `qm guest cmd ${id} network-get-interfaces`, 30_000);
    if (r.code === 0) {
      const ip = pickGuestIp(r.stdout, prefix);
      if (ip) {
        out.ok(`VM ${id} is on your network at ${color.bold(ip)}.`);
        return ip;
      }
    }
    if (i >= tries) return undefined;
    const elapsedS = Math.round(((i + 1) * d.pollMs) / 1000);
    if (i > 0 && (i * d.pollMs) % 30_000 < d.pollMs) out.info(`still booting… ${elapsedS} s`);
    await d.sleep(d.pollMs);
  }
}
