import { HaClient, alternateHaUrl, normalizeHaUrl, resolveHaUrl } from "../ha/client.js";
import { findHomeAssistant } from "../ha/discover.js";
import type { Step, StepContext } from "./types.js";

function hostOf(url: string) {
  return new URL(url).hostname;
}

export async function saveHaUrl(ctx: StepContext, url: string) {
  const u = normalizeHaUrl(url);
  ctx.store.update({ haUrl: u, host: hostOf(u), serverUrl: ctx.store.state.serverUrl ?? `http://${hostOf(u)}:8080` });
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
  summary: "Look for Home Assistant on your network (mDNS + homeassistant.local + an address you give).",
  plan: () => "Read-only: browse mDNS for 3 seconds and probe http://homeassistant.local:8123. Nothing is changed.",
  explain:
    "HomePanel needs Home Assistant. This step browses the local network for _home-assistant._tcp, tries " +
    "http://homeassistant.local:8123 and any IP you type, and checks GET /api/onboarding to see whether HA is " +
    "brand new (needs onboarding) or already set up.",
  async detect(ctx) {
    const url = ctx.store.state.haUrl;
    if (!url) return { done: false, detail: "No Home Assistant address saved yet." };
    let s = await new HaClient(url, { fetchImpl: ctx.fetchImpl }).onboardingStatus();
    if (s.state === "unreachable") {
      // Newer HA OS answers on port 80 instead of 8123 (or the other way round): follow it.
      const alt = alternateHaUrl(url);
      const sa = alt ? await new HaClient(alt, { fetchImpl: ctx.fetchImpl }).onboardingStatus() : s;
      if (alt && sa.state !== "unreachable") {
        await saveHaUrl(ctx, alt);
        ctx.out.info(`Home Assistant now answers at ${alt} (not ${url}); using that.`);
        s = sa;
        return { done: true, detail: `Home Assistant at ${alt}.` };
      }
      return { done: false, detail: `Saved address ${url} is not answering (${s.error}).` };
    }
    return { done: true, detail: `Home Assistant at ${url} (${s.state === "onboarded" ? "already set up" : s.state === "preparing" ? "still preparing" : "needs onboarding"}).` };
  },
  async run(ctx) {
    const { out, prompt } = ctx;
    out.info("Looking for Home Assistant on your network (3 s)…");
    const found = await findHomeAssistant({ fetchImpl: ctx.fetchImpl, extra: ctx.store.state.haUrl ? [ctx.store.state.haUrl] : [] });
    const live = found.filter((f) => f.status !== "unreachable");
    for (const f of live)
      out.ok(`${f.url}${f.name ? ` (${f.name})` : ""} — ${f.status === "onboarded" ? "set up" : f.status === "preparing" ? "still preparing" : "needs onboarding"}`);
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
        message: "Home Assistant address — the one in your browser's address bar (e.g. 192.168.1.20):",
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
    return "done";
  },
};
