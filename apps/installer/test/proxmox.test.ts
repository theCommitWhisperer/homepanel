import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeContext } from "../src/context.js";
import {
  findHaVms,
  haosVmScript,
  hostPrinter,
  latestHaosVersion,
  parseStorages,
  parseVms,
  pickBridge,
  pickGuestIp,
  pickStorage,
  qmCreateArgs,
  setupProxmox,
  type ProxmoxDeps,
} from "../src/proxmox/setup.js";
import { hostKeyFile, hostKeyInfo } from "../src/proxmox/ssh.js";
import { StateStore } from "../src/state.js";
import { hostStep } from "../src/steps/host.js";
import { memoryOut, scriptedPrompter } from "../src/ui.js";
import { runStep } from "../src/wizard.js";
import { FakePve } from "./fake-pve.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hp-pve-"));
});

const versionFetch = (async (u: RequestInfo | URL) => {
  if (String(u).includes("home-assistant/version/master/stable.json")) return new Response(JSON.stringify({ hassos: { ova: "18.4", "rpi4-64": "18.4" } }));
  throw new TypeError("offline");
}) as typeof fetch;

function setup(pve: FakePve, answers: Parameters<typeof scriptedPrompter>[0], store = new StateStore(dir), extra: Partial<ProxmoxDeps> = {}) {
  const out = memoryOut();
  const prompt = scriptedPrompter(answers);
  const proxmox: Partial<ProxmoxDeps> = {
    connect: pve.connect,
    probe: async (h, port) => h === "192.168.1.251" && port === 8006,
    lanIp: () => "192.168.1.50",
    sleep: async () => undefined,
    ipTimeoutMs: 100,
    pollMs: 10,
    ...extra,
  };
  const ctx = makeContext({ store, out, prompt, fetchImpl: versionFetch, noWait: true, proxmox });
  return { ctx, out, prompt, store };
}

describe("Proxmox helpers", () => {
  it("parses pvesm / pvesh / guest agent output and picks sensible defaults", () => {
    const st = parseStorages("Name Type Status Total Used Available %\nlocal dir active 1 2 3 1%\nlocal-lvm lvmthin active 1 2 3 0%\nnas nfs inactive 0 0 0 0%\n");
    expect(st.map((s) => s.name)).toEqual(["local", "local-lvm", "nas"]);
    expect(pickStorage(st)).toBe("local-lvm");
    expect(pickStorage(parseStorages("Name Type Status\nzfs-vm zfspool active 1 2 3 1%\n"))).toBe("zfs-vm");
    expect(pickStorage([])).toBeUndefined();
    expect(pickBridge("enp1s0 lo vmbr1 vmbr0")).toBe("vmbr0");
    expect(pickBridge("enp1s0 vmbr2")).toBe("vmbr2");
    const vms = parseVms(
      JSON.stringify([
        { id: "qemu/100", type: "qemu", vmid: 100, name: "win11", tags: "" },
        { id: "lxc/101", type: "lxc", vmid: 101, name: "haos" },
        { id: "qemu/102", type: "qemu", vmid: 102, name: "homeassistant", tags: "community-script" },
        { id: "qemu/103", type: "qemu", vmid: 103, name: "other", tags: "homepanel;x" },
      ]),
    );
    expect(findHaVms(vms).map((v) => v.vmid)).toEqual([103, 102]);
    expect(pickGuestIp(JSON.stringify(new FakePve().guestIfaces), "192.168.1.")).toBe("192.168.1.60");
    expect(pickGuestIp("not json")).toBeUndefined();
    expect(hostKeyFile("ssh-ed25519")).toBe("/etc/ssh/ssh_host_ed25519_key.pub");
    const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.alloc(36, 7)]);
    expect(hostKeyInfo(blob)).toMatchObject({ type: "ssh-ed25519", sha256: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]+$/) });
  });

  it("qm create matches the community script's flags (plus host CPU, name haos, tag homepanel)", () => {
    expect(qmCreateArgs({ vmid: 100, storage: "local-lvm", bridge: "vmbr0", version: "18.4" }).join(" ")).toBe(
      "qm create 100 -name haos -tags homepanel -bios ovmf -machine q35 -agent 1 -tablet 0 -localtime 1 -cores 2 -memory 4096 -cpu host -net0 virtio,bridge=vmbr0 -scsihw virtio-scsi-pci -ostype l26 -onboot 1 -serial0 socket",
    );
    const sc = haosVmScript({ vmid: 100, storage: "local-lvm", bridge: "vmbr0", version: "18.4" });
    expect(sc).toContain("URL='https://github.com/home-assistant/operating-system/releases/download/18.4/haos_ova-18.4.qcow2.xz'");
    expect(sc).toContain('qm set "$ID" -efidisk0 "$STORAGE:0,efitype=4m"');
    expect(sc).toContain("IMPORT=(qm disk import); else IMPORT=(qm importdisk)");
    expect(sc).toContain('-scsi0 "$REF,discard=on,ssd=1"');
    expect(sc).toContain("qm resize \"$ID\" scsi0 '32G'");
    expect(sc).toContain("-boot order=scsi0");
    expect(sc).toContain('rm -rf "$WORK"');
  });

  it("latest HA OS version: stable.json, else releases API, else built in", async () => {
    expect(await latestHaosVersion(versionFetch)).toMatchObject({ version: "18.4" });
    const rel = (async (u: RequestInfo | URL) =>
      String(u).includes("api.github.com") ? new Response(JSON.stringify({ tag_name: "18.5" })) : new Response("nope", { status: 404 })) as typeof fetch;
    expect(await latestHaosVersion(rel)).toMatchObject({ version: "18.5", source: "GitHub releases" });
    expect((await latestHaosVersion((async () => { throw new Error("x"); }) as typeof fetch)).source).toMatch(/built in/);
  });

  it("streamed host output: headings, indented lines, @@ results across chunk borders", () => {
    const out = memoryOut();
    const p = hostPrinter(out);
    for (const c of ["### VM 1", "00\nhello\r\n@@ rea", "dy vmid=100\n@@ error boom\ntail"]) p.push(c);
    p.flush();
    expect(p.results).toEqual(["ready vmid=100", "error boom"]);
    expect(out.text()).toContain("▸ VM 100");
    expect(out.text()).toContain("      hello");
    expect(out.text()).toContain("ERR boom");
    expect(out.text()).toContain("      tail");
  });
});

describe("Proxmox: create the HA OS VM over SSH (fake host)", () => {
  it("host step → automatic: scan, password, trust key, create, ZBT-1, start, IP → HA URL saved", async () => {
    const pve = new FakePve();
    const { ctx, out, store, prompt } = setup(pve, ["proxmox", "auto", "192.168.1.251", "pve-root-pw", true, true]);
    expect(await runStep(ctx, hostStep, { force: true })).toBe("done");
    const text = out.text();
    expect(text).not.toContain("ERR");
    expect(prompt.asked).toContain("Trust this key and connect?");
    expect(text).toContain("ssh-ed25519 SHA256:abcDEF123fakeKey");
    expect(pve.connects).toEqual([{ host: "192.168.1.251", username: "root" }]);
    // our own script, not the whiptail community one
    expect(pve.scripts).toHaveLength(1);
    expect(pve.scripts[0]).toContain("qm create 100 '-name' 'haos' '-tags' 'homepanel'");
    expect(pve.scripts[0]).toContain("haos_ova-$VER.qcow2");
    expect(pve.scripts[0]).toContain("VER='18.4'");
    expect(pve.scripts[0]).toContain("STORAGE='local-lvm'");
    expect(pve.commands).toContain("qm set 100 -usb0 host=10c4:ea60");
    expect(pve.commands).toContain("qm start 100");
    expect(pve.vms.get(100)).toMatchObject({ status: "running", tags: ["homepanel"] });
    expect(text).toContain("▸ Home Assistant OS disk");
    expect(text).toContain("ZBT-1 found");
    // IP from the guest agent (not 172.30.x / docker), saved as the HA host
    expect(store.state.haUrl).toBe("http://192.168.1.60:8123");
    expect(store.state.serverUrl).toBe("http://192.168.1.60:8080");
    expect(store.state).toMatchObject({ hostType: "proxmox", haOs: true });
    expect(store.state.proxmox).toMatchObject({ host: "192.168.1.251", vmid: 100, created: true, storage: "local-lvm", bridge: "vmbr0", haosVersion: "18.4", haIp: "192.168.1.60" });
    expect(store.state.proxmox!.hostKey).toBe("ssh-ed25519 SHA256:abcDEF123fakeKey");
    // the root password is never written anywhere
    for (const f of [store.statePath, store.secretsPath]) if (existsSync(f)) expect(readFileSync(f, "utf8")).not.toContain("pve-root-pw");
    expect(text).not.toContain("pve-root-pw");
  });

  it("reuses an existing haos VM: no download/create, ZBT-1 already passed, already running", async () => {
    const pve = new FakePve();
    pve.vms.set(105, { vmid: 105, name: "haos", tags: ["homepanel"], status: "running", config: { scsi0: "local-lvm:vm-105-disk-1", usb0: "host=10c4:ea60" } });
    pve.ipAfter = 0;
    const { ctx, out, store } = setup(pve, ["192.168.1.251", "pve-root-pw", true, "105"]);
    expect(await setupProxmox(ctx)).toBe("done");
    expect(pve.scripts).toHaveLength(0);
    expect(pve.commands.some((c) => c.startsWith("qm set") || c.startsWith("qm start"))).toBe(false);
    expect(out.text()).toContain("already passed through");
    expect(store.state.proxmox).toMatchObject({ vmid: 105, created: false });
    expect(store.state.haUrl).toBe("http://192.168.1.60:8123");
  });

  it("ZBT-1 missing: says so and continues; a remembered host key is trusted without asking", async () => {
    const pve = new FakePve();
    pve.zbt1 = false;
    const store = new StateStore(dir);
    store.update({ proxmox: { host: "192.168.1.251", hostKey: "ssh-ed25519 SHA256:abcDEF123fakeKey" } });
    const { ctx, out, prompt } = setup(pve, ["192.168.1.251", "pve-root-pw", true], store);
    expect(await setupProxmox(ctx)).toBe("done");
    expect(prompt.asked).not.toContain("Trust this key and connect?");
    expect(out.text()).toContain("matches the one you trusted before");
    expect(out.text()).toContain("ZBT-1 not found on the Proxmox host");
    expect(pve.commands.some((c) => c.includes("-usb"))).toBe(false);
  });

  it("changed host key → warns and asks (default no); declining connects to nothing", async () => {
    const pve = new FakePve();
    const store = new StateStore(dir);
    store.update({ proxmox: { host: "192.168.1.251", hostKey: "ssh-ed25519 SHA256:OLDkey" } });
    const { ctx, out } = setup(pve, ["192.168.1.251", "pve-root-pw", false], store);
    expect(await setupProxmox(ctx)).toBe("manual");
    expect(out.text()).toContain("CHANGED");
    expect(pve.commands).toEqual([]);
    expect(store.state.proxmox!.hostKey).toBe("ssh-ed25519 SHA256:OLDkey");
  });

  it("wrong password → try again; IP never reported → asks for the address", async () => {
    const pve = new FakePve();
    pve.ipAfter = 1_000;
    const { ctx, out, store } = setup(pve, ["192.168.1.251", "nope", true, true, "pve-root-pw", true, "192.168.1.77"]);
    expect(await setupProxmox(ctx)).toBe("done");
    expect(out.text()).toContain("rejected that password");
    expect(out.text()).toContain("did not report an IP");
    expect(pve.commands.filter((c) => c.includes("network-get-interfaces")).length).toBeGreaterThan(5);
    expect(store.state.haUrl).toBe("http://192.168.1.77:8123");
  });

  it("creation fails → failed, VMID kept; the next run resumes the same VM", async () => {
    const pve = new FakePve();
    pve.scriptFails = true;
    const a = setup(pve, ["192.168.1.251", "pve-root-pw", true, true]);
    expect(await setupProxmox(a.ctx)).toBe("failed");
    expect(a.out.text()).toContain("download failed");
    expect(a.store.state.proxmox).toMatchObject({ vmid: 100, created: true });
    // the VM shell exists now (created before the download died)
    pve.vms.set(100, { vmid: 100, name: "haos", tags: ["homepanel"], status: "stopped", config: { efidisk0: "x" } });
    pve.scriptFails = false;
    const b = setup(pve, ["192.168.1.251", "pve-root-pw", true], new StateStore(dir));
    expect(await setupProxmox(b.ctx)).toBe("done");
    expect(b.out.text()).toContain("created by an earlier run");
    expect(pve.scripts.at(-1)).toContain("ID='100'");
    expect(pve.vms.size).toBe(1);
  });
});

describe("the VM script on a stub Proxmox host (bash)", () => {
  const bash = spawnSync("bash", ["--version"]).status === 0 && process.platform !== "win32";
  it.skipIf(!bash)("creates, imports and cleans up; a second run changes nothing", () => {
    const bin = join(dir, "bin");
    const state = join(dir, "pve");
    const work = join(dir, "work");
    mkdirSync(bin);
    mkdirSync(state);
    const log = join(dir, "log");
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> ${JSON.stringify(log)}\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    const S = JSON.stringify(state);
    stub(
      "qm",
      `case "$1" in
  status) [ -f ${S}/created ] && echo "status: stopped" || exit 2 ;;
  create) touch ${S}/created ;;
  config) [ -f ${S}/created ] || exit 2; cat ${S}/config 2>/dev/null; true ;;
  set) shift 2; case "$1" in -efidisk0) echo "efidisk0: $2" >> ${S}/config ;; -scsi0) echo "scsi0: $2" >> ${S}/config ;; esac ;;
  disk) [ "$2" = "--help" ] && exit 0; echo "transferred 1.0 GiB of 32.0 GiB (3.13%)"; echo "unused0: successfully imported disk 'local-lvm:vm-100-disk-1'" ;;
  resize) exit 0 ;;
esac`,
    );
    stub("curl", `while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { echo xzdata > "$2"; }; shift; done`);
    stub("xz", `cat "$2"`);
    const script = haosVmScript({ vmid: 100, storage: "local-lvm", bridge: "vmbr0", version: "18.4", workDir: work });
    const run = () => spawnSync("bash", ["-s"], { input: script, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
    const r1 = run();
    expect(r1.status, r1.stdout + r1.stderr).toBe(0);
    expect(r1.stdout).toContain("@@ ready vmid=100");
    const l1 = readFileSync(log, "utf8");
    expect(l1).toContain("qm create 100 -name haos -tags homepanel -bios ovmf -machine q35");
    expect(l1).toContain("qm set 100 -efidisk0 local-lvm:0,efitype=4m");
    expect(l1).toMatch(/qm disk import 100 .*haos_ova-18\.4\.qcow2 local-lvm --format raw/);
    expect(l1).toContain("qm set 100 -scsi0 local-lvm:vm-100-disk-1,discard=on,ssd=1");
    expect(l1).toContain("qm resize 100 scsi0 32G");
    expect(l1).toContain("qm set 100 -boot order=scsi0");
    expect(existsSync(work)).toBe(false); // image cleaned up
    writeFileSync(log, "");
    const r2 = run();
    expect(r2.status, r2.stdout).toBe(0);
    expect(r2.stdout).toContain("already exists");
    expect(r2.stdout).toContain("System disk already attached");
    const l2 = readFileSync(log, "utf8");
    expect(l2).not.toMatch(/qm create|curl|disk import|-efidisk0/);
  });
});

describe("first boot of HA OS (Supervisor landing page)", () => {
  it("is 'preparing', not 'onboarded'; waitForHa reports progress and returns once Core answers", async () => {
    const { startFakeHa } = await import("./fake-ha.js");
    const { HaClient } = await import("../src/ha/client.js");
    const { waitForHa } = await import("../src/ha/discover.js");
    const ha = await startFakeHa({ preparing: true });
    try {
      const c = new HaClient(ha.url);
      expect((await c.onboardingStatus()).state).toBe("preparing");
      expect(await c.preparingProgress()).toBe("home_assistant_core_install 40%");
      const ticks: string[] = [];
      let n = 0;
      const ok = await waitForHa(ha.url, {
        intervalMs: 1,
        timeoutMs: 5000,
        onTick: (_s, state, progress) => {
          ticks.push(`${state}:${progress}`);
          if (++n === 3) ha.state.preparing = false; // Core is up
        },
      });
      expect(ok).toBeTruthy(); // the URL that answered
      expect(ticks[0]).toBe("preparing:home_assistant_core_install 40%");
      expect((await c.onboardingStatus()).state).toBe("onboarding");
      ha.state.onboarded = true;
      expect((await c.onboardingStatus()).state).toBe("onboarded");
    } finally {
      await ha.close();
    }
  });
});

describe("real SSH (ssh2) against an in-process SSH server", () => {
  it("shows the host key, authenticates with the password, streams exec output and feeds stdin", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const ssh2 = (await import("ssh2")) as any;
    const { ssh2Connect } = await import("../src/proxmox/ssh.js");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const blob: Buffer = ssh2.utils.parseKey(privateKey).getPublicSSH();
    const server = new ssh2.Server({ hostKeys: [privateKey] }, (client: any) => {
      client.on("authentication", (ctx: any) => (ctx.method === "password" && ctx.username === "root" && ctx.password === "pw" ? ctx.accept() : ctx.reject(["password"])));
      client.on("ready", () =>
        client.on("session", (accept: any) =>
          accept().on("exec", (acc: any, _rej: any, info: { command: string }) => {
            const ch = acc();
            if (info.command === "bash -s") {
              let input = "";
              ch.on("data", (d: Buffer) => (input += d));
              ch.on("end", () => {
                ch.write(`### got ${input.split("\n").length - 1} lines\n`);
                ch.stderr.write("warn on stderr\n");
                ch.exit(0);
                ch.end();
              });
            } else {
              ch.write(`ran: ${info.command}\n`);
              ch.exit(3);
              ch.end();
            }
          }),
        ),
      );
      client.on("error", () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port as number;
    try {
      const seen: string[] = [];
      const s = await ssh2Connect({ host: "127.0.0.1", port, username: "root", password: "pw", verifyHostKey: async (k) => (seen.push(`${k.type} ${k.sha256}`), true) });
      expect(seen).toEqual([`ssh-rsa ${hostKeyInfo(blob).sha256}`]);
      const chunks: string[] = [];
      const r = await s.exec("bash -s", { stdin: "a\nb\nc\n", onData: (t) => chunks.push(t) });
      expect(r).toMatchObject({ code: 0, stdout: "### got 3 lines\n", stderr: "warn on stderr\n" });
      expect(chunks.join("")).toContain("### got 3 lines");
      expect(await s.exec("pveversion")).toMatchObject({ code: 3, stdout: "ran: pveversion\n" });
      s.close();
      // wrong password → auth error; untrusted key → HostKeyRejected, password never sent
      await expect(ssh2Connect({ host: "127.0.0.1", port, username: "root", password: "nope", verifyHostKey: async () => true })).rejects.toThrow(/authentication/i);
      await expect(ssh2Connect({ host: "127.0.0.1", port, username: "root", password: "pw", verifyHostKey: async () => false })).rejects.toMatchObject({ name: "HostKeyRejected" });
    } finally {
      server.close();
    }
  });
});
