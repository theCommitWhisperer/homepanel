import { DEFAULT_HA_HOST, MDNS_HA_HOST } from "../constants.js";
import { findReachableHa, setHaAddress } from "../ha/address.js";
import { HaClient, alternateHaUrl, normalizeHaUrl, resolveHaUrl } from "../ha/client.js";
import { findHomeAssistant } from "../ha/discover.js";
import type { Step, StepContext } from "./types.js";

/** Save the HA address (server URL and MQTT host follow it if they pointed at the old host). */
export async function saveHaUrl(ctx: StepContext, url: string) {
  for (const c of setHaAddress(ctx.store, url)) ctx.out.info(c);
}

/** Ask for an address (IP or URL), defaulting to the saved one or DEFAULT_HA_HOST. */
export async function askHaAddress(ctx: StepContext, message = "Home Assistant address (IP or URL):"): Promise<string> {
  const typed = await ctx.prompt.input({
    message,
    default: ctx.store.state.host ?? DEFAULT_HA_HOST,
    validate: (v) => {
      try {
        normalizeHaUrl(v);
        return true;
      } catch {
        return "That doesn't look like an address";
      }
    },
  });
  const r = await resolveHaUrl(typed, ctx.fetchImpl);
  return r.url;
}

/** Detect whether the instance is HA OS/Supervised (has the hassio component). Needs a token. */
export async function detectHaOs(ctx: StepContext): Promise<boolean | undefined> {
  if (!ctx.store.secrets.haToken && !ctx.store.secrets.haAccessToken) return undefined;
  try {
    const cfg = await ctx.ha().withWs((s) => s.getConfig());
    const isOs = Array.isArray(cfg.components) && cfg.components.includes("hassio");
    ctx.store.update({ haOs: isOs });
    return isOs;
  } catch {
    return undefined;
  }
}

export const detectStep: Step = {
  id: "detect",
  title: "Find Home Assistant",
  summary: `Look for Home Assistant on your network (${DEFAULT_HA_HOST}, mDNS, ${MDNS_HA_HOST} or an address you give).`,
  plan: () =>
    `Read-only: probe http://${DEFAULT_HA_HOST}:8123, browse mDNS for 3 seconds and probe http://${MDNS_HA_HOST}:8123. Nothing is changed.`,
  explain:
    `HomePanel needs Home Assistant. This step tries ${DEFAULT_HA_HOST} (set HOMEPANEL_HA_HOST to change the default), ` +
    `browses the local network for _home-assistant._tcp, tries http://${MDNS_HA_HOST}:8123 and any IP you type, and ` +
    "checks GET /api/onboarding to see whether HA is brand new (needs onboarding) or already set up. " +
    "Change the saved address later with `homepanel ha-address <ip>`.",
  async detect(ctx) {
    const url = ctx.store.state.haUrl;
    if (!url) return { done: false, detail: "No Home Assistant address saved yet." };
    let s = await new HaClient(url, { fetchImpl: ctx.fetchImpl }).onboardingStatus();
    if (s.state === "unreachable") {
      // 1. Alternate port (8123 <-> 80)
      const altPort = alternateHaUrl(url);
      const sa = altPort ? await new HaClient(altPort, { fetchImpl: ctx.fetchImpl }).onboardingStatus() : s;
      if (altPort && sa.state !== "unreachable") {
        await saveHaUrl(ctx, altPort);
        ctx.out.info(`Home Assistant now answers at ${altPort} (not ${url}); using that.`);
        return { done: true, detail: `Home Assistant at ${altPort}.` };
      }
      // 2. Fail-safe candidates: default IP and mDNS
      const altHost = await findReachableHa(ctx.fetchImpl, url);
      if (altHost && altHost !== url) {
        await saveHaUrl(ctx, altHost);
        ctx.out.info(`Saved address ${url} wasn't answering; switched to ${altHost}.`);
        return { done: true, detail: `Home Assistant at ${altHost}.` };
      }
      return { done: false, detail: `Saved address ${url} is not answering (${s.error}).` };
    }
    return {
      done: true,
      detail: `Home Assistant at ${url} (${s.state === "onboarded" ? "already set up" : s.state === "preparing" ? "still preparing" : "needs onboarding"}).`,
    };
  },
  async run(ctx) {
    const { out, prompt } = ctx;
    out.info("Looking for Home Assistant on your network (3 s)…");
    const found = await findHomeAssistant({ fetchImpl: ctx.fetchImpl, extra: ctx.store.state.haUrl ? [ctx.store.state.haUrl] : [] });
    const live = found.filter((f) => f.status !== "unreachable");
    for (const f of live)
      out.ok(
        `${f.url}${f.name ? ` (${f.name})` : ""} — ${f.status === "onboarded" ? "set up" : f.status === "preparing" ? "still preparing" : "needs onboarding"}`,
      );
    if (!live.length) out.warn("No Home Assistant found automatically.");

    const choices = [
      ...live.map((f) => ({ value: f.url, name: `Use ${f.url}` })),
      { value: "__ip", name: "Type an IP address / URL" },
      { value: "__none", name: "I don't have Home Assistant yet (install it in the next step)" },
    ];
    const pick = await prompt.select({ message: "Which Home Assistant?", choices });
    if (pick === "__none") {
      out.info("OK — the next step shows how to install it.");
      return "skipped";
    }
    let url = pick;
    if (pick === "__ip") {
      const typed = await prompt.input({
        message: "Home Assistant address — the one in your browser's address bar (e.g. 192.168.1.81):",
        default: ctx.store.state.host ?? DEFAULT_HA_HOST,
        validate: (v) => {
          try {
            normalizeHaUrl(v);
            return true;
          } catch {
            return "That doesn't look like an address";
          }
        },
      });
      const r = await resolveHaUrl(typed, ctx.fetchImpl);
      url = r.url;
      if (!r.reachable) {
        out.warn(`Nothing answers at ${url} yet (also tried without :8123). Saved anyway; the onboarding step will wait for it.`);
      } else out.ok(`Found Home Assistant at ${url}.`);
    }
    await saveHaUrl(ctx, url);
    out.info("Change it any time with `homepanel ha-address <ip>`.");
    return "done";
  },
};
