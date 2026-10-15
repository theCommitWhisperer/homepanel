import { setHaAddress } from "./ha/address.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HaClient } from "./ha/client.js";
import { SecretVault, StateStore } from "./state.js";
import type { StepContext } from "./steps/types.js";
import { realExec, type Exec } from "./sys.js";
import type { Out, Prompter } from "./ui.js";

/** Walk up from this file to the monorepo root (has pnpm-workspace.yaml and docs/ or deploy/). */
export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "pnpm-workspace.yaml")) && (existsSync(join(d, "deploy")) || existsSync(join(d, "docs")))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return undefined;
}

export function makeContext(o: {
  store: StateStore;
  out: Out;
  prompt: Prompter;
  exec?: Exec;
  fetchImpl?: typeof fetch;
  vault?: SecretVault;
  repoRoot?: string;
  noWait?: boolean;
  proxmox?: StepContext["proxmox"];
}): StepContext {
  const vault = o.vault ?? new SecretVault();
  vault.addAll(o.store.secrets);
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const ctx: StepContext = {
    store: o.store,
    out: o.out,
    prompt: o.prompt,
    exec: o.exec ?? realExec,
    fetchImpl,
    vault,
    repoRoot: o.repoRoot ?? findRepoRoot(),
    noWait: o.noWait,
    proxmox: o.proxmox,
    ha() {
      const url = o.store.state.haUrl;
      if (!url) throw new Error("Home Assistant address is not known yet (run the detect step).");
      return new HaClient(url, {
        fetchImpl,
        token: o.store.secrets.haToken ?? o.store.secrets.haAccessToken,
        // HA answered on the other port (8123 <-> 80): remember it so every later step uses it
        onMoved: (moved) => {
          for (const c of setHaAddress(o.store, moved)) o.out.info(c);
        },
      });
    },
    async secret(label, opts = {}) {
      const pre = o.store.secrets.extra?.[label];
      if (pre) {
        o.out.info(`Using the ${label} you entered earlier.`);
        return pre;
      }
      const min = opts.minLength ?? 1;
      for (;;) {
        const v = await o.prompt.password({
          message: `${label} (hidden):`,
          validate: (x) => (x.length >= min ? true : `At least ${min} characters`),
        });
        if (opts.confirm) {
          const again = await o.prompt.password({ message: `${label} again:` });
          if (again !== v) {
            o.out.warn("They don't match, try again.");
            continue;
          }
        }
        vault.add(label, v);
        return v;
      }
    },
  };
  return ctx;
}
