/**
 * A fake Proxmox VE host behind the SshConnect interface: answers the commands the Proxmox flow runs
 * (pveversion, pvesh, pvesm, qm …) from an in-memory model, and "runs" the creation script sent to
 * `bash -s` by creating the VM in that model.
 */
import type { ExecResult } from "../src/sys.js";
import type { HostKeyInfo, SshConnect, SshConnectOpts, SshExecOpts, SshSession } from "../src/proxmox/ssh.js";

export interface FakeVm {
  vmid: number;
  name: string;
  tags: string[];
  status: "running" | "stopped";
  config: Record<string, string>;
}

export class FakePve {
  password = "pve-root-pw";
  hostKey: HostKeyInfo = { type: "ssh-ed25519", sha256: "SHA256:abcDEF123fakeKey" };
  vms = new Map<number, FakeVm>();
  storages = ["local            dir     active  98497780  12345678  80000000  12.53%", "local-lvm    lvmthin     active  365760512  1234567  364525945   0.34%"];
  zbt1 = true;
  /** guest agent answers after this many network-get-interfaces calls */
  ipAfter = 2;
  guestIfaces = [
    { name: "lo", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "127.0.0.1" }] },
    { name: "hassio", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "172.30.32.1" }] },
    { name: "docker0", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "172.30.232.1" }] },
    { name: "enp0s18", "ip-addresses": [{ "ip-address-type": "ipv6", "ip-address": "fe80::1" }, { "ip-address-type": "ipv4", "ip-address": "192.168.1.60" }] },
  ];
  /** fail the creation script */
  scriptFails = false;
  commands: string[] = [];
  scripts: string[] = [];
  connects: { host: string; username: string }[] = [];
  private agentCalls = 0;

  connect: SshConnect = async (o: SshConnectOpts) => {
    this.connects.push({ host: o.host, username: o.username });
    if (!(await o.verifyHostKey(this.hostKey))) {
      const e = new Error("host key rejected");
      e.name = "HostKeyRejected";
      throw e;
    }
    if (o.password !== this.password) throw Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });
    const session: SshSession = { exec: (cmd, eo) => this.exec(cmd, eo), close: () => undefined };
    return session;
  };

  private async exec(cmd: string, o: SshExecOpts = {}): Promise<ExecResult> {
    this.commands.push(cmd);
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string, code = 2): ExecResult => ({ code, stdout: "", stderr });
    if (cmd === "pveversion") return ok("pve-manager/8.4.1/2a5fa54a8503f96d (running kernel: 6.8.12-10-pve)\n");
    if (cmd === "pvesh get /cluster/resources --type vm --output-format json")
      return ok(
        JSON.stringify([...this.vms.values()].map((v) => ({ id: `qemu/${v.vmid}`, type: "qemu", vmid: v.vmid, name: v.name, status: v.status, node: "pve", tags: v.tags.join(";") }))),
      );
    if (cmd === "pvesh get /cluster/nextid") {
      let n = 100;
      while (this.vms.has(n)) n++;
      return ok(`${n}\n`);
    }
    if (cmd === "pvesm status --content images") return ok(["Name             Type     Status           Total            Used       Available        %", ...this.storages].join("\n") + "\n");
    if (cmd === "ls /sys/class/net") return ok("enp1s0\nfwbr100i0\nlo\nvmbr0\n");
    if (cmd === "lsusb")
      return ok(
        "Bus 002 Device 001: ID 1d6b:0003 Linux Foundation 3.0 root hub\n" +
          (this.zbt1 ? "Bus 001 Device 004: ID 10c4:ea60 Silicon Labs CP210x UART Bridge\n" : "") +
          "Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub\n",
      );
    if (cmd === "bash -s") {
      this.scripts.push(o.stdin ?? "");
      if (this.scriptFails) {
        o.onData?.("### VM 100\n");
        o.onData?.("@@ error download failed (run setup again to resume)\n");
        return { code: 1, stdout: "", stderr: "" };
      }
      const id = Number(/^ID='(\d+)'/m.exec(o.stdin ?? "")?.[1]);
      const storage = /^STORAGE='([^']+)'/m.exec(o.stdin ?? "")?.[1];
      if (!this.vms.has(id)) this.vms.set(id, { vmid: id, name: "haos", tags: ["homepanel"], status: "stopped", config: {} });
      const vm = this.vms.get(id)!;
      Object.assign(vm.config, { efidisk0: `${storage}:vm-${id}-disk-0,efitype=4m`, scsi0: `${storage}:vm-${id}-disk-1,discard=on,ssd=1,size=32G`, boot: "order=scsi0" });
      // streamed in odd chunks, like a real SSH channel
      for (const chunk of [`### VM ${id}\nCreated VM ${id}`, ` (haos, tag homepanel).\n### Home Assistant OS disk\r\n  ... 120 MB\n`, `### Cleaning up\n@@ ready vmid=${id}\n`]) o.onData?.(chunk);
      return ok();
    }
    let m = /^qm config (\d+)$/.exec(cmd);
    if (m) {
      const vm = this.vms.get(Number(m[1]));
      if (!vm) return fail(`Configuration file 'nodes/pve/qemu-server/${m[1]}.conf' does not exist`);
      return ok([`name: ${vm.name}`, ...(vm.tags.length ? [`tags: ${vm.tags.join(";")}`] : []), ...Object.entries(vm.config).map(([k, v]) => `${k}: ${v}`)].join("\n") + "\n");
    }
    m = /^qm set (\d+) -(usb\d) host=(\S+)$/.exec(cmd);
    if (m) {
      this.vms.get(Number(m[1]))!.config[m[2]!] = `host=${m[3]}`;
      return ok(`update VM ${m[1]}: -${m[2]} host=${m[3]}\n`);
    }
    m = /^qm status (\d+)$/.exec(cmd);
    if (m) {
      const vm = this.vms.get(Number(m[1]));
      return vm ? ok(`status: ${vm.status}\n`) : fail("no such VM");
    }
    m = /^qm start (\d+)$/.exec(cmd);
    if (m) {
      this.vms.get(Number(m[1]))!.status = "running";
      return ok();
    }
    m = /^qm guest cmd (\d+) network-get-interfaces$/.exec(cmd);
    if (m) {
      if (this.vms.get(Number(m[1]))?.status !== "running" || ++this.agentCalls <= this.ipAfter) return fail("QEMU guest agent is not running", 255);
      return ok(JSON.stringify(this.guestIfaces));
    }
    return fail(`fake pve: unknown command: ${cmd}`, 127);
  }
}
