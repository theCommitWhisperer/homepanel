/**
 * SSH to the Proxmox host, behind a small interface so the Proxmox flow is testable with a fake
 * (test/fake-pve.ts). The real implementation uses the pure-JS `ssh2` package (its optional native
 * speedups are not needed and are left out of HomePanel.exe).
 *
 * The root password is only held in memory for the connection: it is never logged or saved.
 */
import { createHash } from "node:crypto";
import type { ExecResult } from "../sys.js";

export interface HostKeyInfo {
  /** e.g. ssh-ed25519 */
  type: string;
  /** OpenSSH style: SHA256:<base64 without padding> */
  sha256: string;
}

export interface SshExecOpts {
  /** streamed output (stdout and stderr), as it arrives */
  onData?: (text: string) => void;
  /** written to the command's stdin, then closed (used to send our bash script to `bash -s`) */
  stdin?: string;
  timeoutMs?: number;
}

export interface SshSession {
  exec(command: string, o?: SshExecOpts): Promise<ExecResult>;
  close(): void;
}

export interface SshConnectOpts {
  host: string;
  port?: number;
  username: string;
  password: string;
  /** called with the server's host key before authenticating; false aborts the connection */
  verifyHostKey(key: HostKeyInfo): Promise<boolean>;
  timeoutMs?: number;
}

export type SshConnect = (o: SshConnectOpts) => Promise<SshSession>;

/** Thrown when the user did not trust the host key. */
export class HostKeyRejected extends Error {
  constructor() {
    super("The host key was not trusted, so the connection was closed.");
    this.name = "HostKeyRejected";
  }
}

/** Fingerprint + type of an SSH public key blob (string type, then key data). */
export function hostKeyInfo(blob: Buffer): HostKeyInfo {
  let type = "unknown";
  try {
    const len = blob.readUInt32BE(0);
    if (len > 0 && len < 64) type = blob.subarray(4, 4 + len).toString("ascii");
  } catch {
    /* keep unknown */
  }
  return { type, sha256: "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "") };
}

/** The file on the Proxmox host whose fingerprint the user can compare (ssh-keygen -lf <file>). */
export function hostKeyFile(type: string): string {
  const t = /ed25519/.test(type) ? "ed25519" : /ecdsa/.test(type) ? "ecdsa" : /rsa/.test(type) ? "rsa" : "*";
  return `/etc/ssh/ssh_host_${t}_key.pub`;
}

/** Real SSH via ssh2 (password or keyboard-interactive auth). */
export const ssh2Connect: SshConnect = async (o) => {
  const mod = (await import("ssh2")) as unknown as { Client?: new () => any; default?: { Client: new () => any } };
  const Client = mod.Client ?? mod.default!.Client;
  const client = new Client();
  let rejectedKey = false;
  await new Promise<void>((resolve, reject) => {
    client.once("ready", () => resolve());
    client.once("error", (e: Error) => reject(rejectedKey ? new HostKeyRejected() : e));
    client.on("keyboard-interactive", (_n: string, _i: string, _l: string, prompts: unknown[], finish: (a: string[]) => void) =>
      finish(prompts.map(() => o.password)),
    );
    client.connect({
      host: o.host,
      port: o.port ?? 22,
      username: o.username,
      password: o.password,
      tryKeyboard: true,
      readyTimeout: o.timeoutMs ?? 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 8,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        o.verifyHostKey(hostKeyInfo(key)).then(
          (ok) => {
            if (!ok) rejectedKey = true;
            verify(ok);
          },
          () => {
            rejectedKey = true;
            verify(false);
          },
        );
      },
    });
  });
  return {
    exec(command, eo = {}) {
      return new Promise<ExecResult>((resolve) => {
        client.exec(command, (err: Error | undefined, stream: any) => {
          if (err) {
            resolve({ code: 255, stdout: "", stderr: err.message });
            return;
          }
          let stdout = "";
          let stderr = "";
          let done = false;
          const timer = setTimeout(() => {
            if (done) return;
            done = true;
            try {
              stream.close();
            } catch {
              /* ignore */
            }
            resolve({ code: 124, stdout, stderr: stderr + `\n(timed out after ${Math.round((eo.timeoutMs ?? 0) / 1000)} s)` });
          }, eo.timeoutMs ?? 120_000);
          stream.on("data", (d: Buffer) => {
            const t = d.toString("utf8");
            stdout += t;
            eo.onData?.(t);
          });
          stream.stderr.on("data", (d: Buffer) => {
            const t = d.toString("utf8");
            stderr += t;
            eo.onData?.(t);
          });
          stream.on("close", (code: number | null) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code: code ?? 0, stdout, stderr });
          });
          // always close stdin (EOF) so nothing waits for input
          stream.end(eo.stdin ?? "");
        });
      });
    },
    close() {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    },
  };
};
