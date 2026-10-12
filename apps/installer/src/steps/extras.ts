import { COMMUNITY_ADDONS_REPO, SERVER_PORT, TAILSCALE_SLUG } from "../constants.js";
import type { FlowResult } from "../ha/client.js";
import { SCREEN_GUIDES } from "../guides.js";
import { ensureAppRunning } from "./mqtt.js";
import type { Step, StepContext } from "./types.js";

/* ------------------------------------------------------------------ */
/* Zigbee: Home Assistant Connect ZBT-1                                 */
/* ------------------------------------------------------------------ */

/** Integration domain of the ZBT-1 (historically "SkyConnect"). */
export const ZBT1_DOMAIN = "homeassistant_sky_connect";

export const zigbeeStep: Step = {
  id: "zigbee",
  title: "Zigbee with the ZBT-1",
  summary: "Set up the Home Assistant Connect ZBT-1 stick for Zigbee (ZHA).",
  plan: () =>
    "Read-only check for a discovered ZBT-1 in Home Assistant, then print the steps to accept it and choose Zigbee (ZHA). " +
    "The firmware/radio choice is made in HA's own dialog, not by the installer.",
  explain:
    "The ZBT-1 is a USB Zigbee/Thread radio. Plug it in with a USB extension cable (0.5–1 m) away from the mini PC, " +
    "USB 3 ports and Wi-Fi — USB 3 noise kills Zigbee range. HA discovers it; you pick 'Zigbee' and it sets up ZHA.",
  async detect(ctx) {
    if (!ctx.store.secrets.haToken) return { done: false, detail: "Needs the HA token first." };
    try {
      const c = ctx.ha();
      const [zha, sky] = await c.withWs(async (s) => [await s.configEntries("zha"), await s.configEntries(ZBT1_DOMAIN)]);
      if (zha!.length) return { done: true, detail: "ZHA (Zigbee) is set up." };
      const flows = await c.flowsInProgress().catch(() => []);
      if (flows.some((f) => f.handler === ZBT1_DOMAIN || f.handler === "zha"))
        return { done: false, detail: "ZBT-1 discovered — waiting for you to accept it in HA." };
      return { done: false, detail: sky!.length ? "ZBT-1 added, but ZHA not configured." : "No ZBT-1 seen yet." };
    } catch (e) {
      return { done: false, detail: `Can't check: ${(e as Error).message}` };
    }
  },
  async run(ctx) {
    const { out, prompt } = ctx;
    const d = await this.detect(ctx);
    out.info(d.detail);
    if (d.done) return "done";
    out.steps([
      "Plug the ZBT-1 into a USB 2 port if you have one, using a USB extension cable so the stick sits 0.5–1 m away from the computer.",
      ctx.store.state.hostType === "vm-windows" || ctx.store.state.hostType === "nas-proxmox"
        ? "VM: pass the USB device through to the Home Assistant VM first."
        : "Wait ~30 s. HA → Settings → Devices & services shows 'Discovered: Home Assistant Connect ZBT-1'.",
      "Click Add → when asked, choose 'Zigbee' (HA flashes Zigbee firmware if needed and sets up ZHA) → Submit.",
      "Pair devices: Settings → Devices & services → Zigbee Home Automation → Add device, then put the bulb/sensor in pairing mode.",
    ]);
    out.info("Full guide: docs/zigbee-zbt1.md");
    if (await prompt.confirm({ message: "Done (or check again)?", default: true })) {
      const again = await this.detect(ctx);
      out.info(again.detail);
      return again.done ? "done" : "manual";
    }
    return "manual";
  },
};

/* ------------------------------------------------------------------ */
/* Doorbells                                                            */
/* ------------------------------------------------------------------ */

/** Drive the Reolink config flow with host/user/password. */
export async function addReolink(
  ctx: StepContext,
  host: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; message: string }> {
  const c = ctx.ha();
  let r: FlowResult = await c.startFlow("reolink");
  for (let i = 0; i < 4; i++) {
    if (r.type === "create_entry") return { ok: true, message: `Reolink "${r.title ?? host}" added.` };
    if (r.type === "abort") return { ok: r.reason === "already_configured", message: `Reolink: ${r.reason}` };
    if (r.type === "form") {
      if (r.errors && Object.keys(r.errors).length) {
        await c.abortFlow(r.flow_id).catch(() => undefined);
        return { ok: false, message: `Reolink rejected the details: ${JSON.stringify(r.errors)}` };
      }
      const fields = (r.data_schema ?? []).map((f) => f.name);
      const input: Record<string, unknown> = {};
      if (fields.includes("host")) input.host = host;
      if (fields.includes("username")) input.username = username;
      if (fields.includes("password")) input.password = password;
      r = await c.continueFlow(r.flow_id, input);
      continue;
    }
    break;
  }
  return { ok: false, message: `Reolink flow stopped at "${r.type}/${r.step_id ?? ""}" — finish it in HA → Settings → Devices & services.` };
}

export const doorbellStep: Step = {
  id: "doorbells",
  title: "Doorbells (Reolink / Eufy)",
  summary: "Add a Reolink doorbell through HA's Reolink integration, or follow the Eufy steps.",
  plan: () =>
    "Reolink: start Home Assistant's 'reolink' integration with the doorbell IP, username and password you type " +
    "locally (password hidden; never sent to the AI). Eufy: print the steps only (HACS + eufy-security-ws app), nothing is installed.",
  explain:
    "Reolink doorbells have an official HA integration (local, no cloud) that gives a camera and a 'visitor' binary " +
    "sensor — HomePanel uses that sensor as the ring trigger. Eufy has no official integration; the community " +
    "eufy-security-ws app + 'Eufy Security' custom integration from HACS work for many models but are unofficial and can break.",
  async detect(ctx) {
    if (!ctx.store.secrets.haToken) return { done: false, detail: "Needs the HA token first." };
    try {
      const [reo, eufy] = await ctx.ha().withWs(async (s) => [await s.configEntries("reolink"), await s.configEntries("eufy_security")]);
      const parts = [];
      if (reo!.length) parts.push(`Reolink: ${reo!.map((e) => e.title).join(", ")}`);
      if (eufy!.length) parts.push("Eufy Security");
      return parts.length ? { done: true, detail: parts.join("; ") } : { done: false, detail: "No doorbell integration yet." };
    } catch (e) {
      return { done: false, detail: `Can't check: ${(e as Error).message}` };
    }
  },
  async run(ctx) {
    const { out, prompt } = ctx;
    const kind = await prompt.select({
      message: "Which doorbell?",
      choices: [
        { value: "reolink", name: "Reolink (official integration, local)" },
        { value: "eufy", name: "Eufy (unofficial, best effort)" },
        { value: "both", name: "Both" },
        { value: "none", name: "None / skip" },
      ],
    });
    if (kind === "none") return "skipped";
    let status: "done" | "manual" | "failed" = "done";
    if (kind === "reolink" || kind === "both") {
      out.info("Reolink: give the doorbell a fixed IP in your router first. Use the admin account set in the Reolink app.");
      const host = await prompt.input({ message: "Reolink doorbell IP:", validate: (v) => (v.trim() ? true : "Required") });
      const user = await prompt.input({ message: "Reolink username:", default: "admin" });
      const pw = await ctx.secret("Reolink password");
      try {
        const r = await addReolink(ctx, host.trim(), user, pw);
        (r.ok ? out.ok : out.warn)(r.message);
        if (r.ok) {
          ctx.store.update({ doorbells: [...new Set([...(ctx.store.state.doorbells ?? []), "reolink"])] });
          out.info("In HomePanel admin → Doorbells, pick the '…visitor' binary sensor as ring and the doorbell camera.");
        } else status = "manual";
      } catch (e) {
        out.warn(`Could not add Reolink: ${(e as Error).message}`);
        status = "manual";
      }
    }
    if (kind === "eufy" || kind === "both") {
      out.warn("Eufy support is unofficial (community projects). It may break after Eufy app updates.");
      out.steps([
        "Create a second Eufy account just for HA and share the doorbell to it from the Eufy app (the integration logs out other sessions).",
        "HA → Apps → App store → ⋮ Repositories → add https://github.com/bropat/hassio-eufy-security-ws → install 'Eufy Security Add-on' (eufy-security-ws), set the second account's email/password + country, start it.",
        "Install HACS (hacs.xyz → 'Download HACS' app/instructions), restart HA.",
        "HACS → search 'Eufy Security' (fuatakgun/eufy_security) → Download → restart HA.",
        "Settings → Devices & services → Add integration → Eufy Security → host: the eufy-security-ws app (default 'localhost' or the app hostname shown on its page), port 3000.",
        "Use the doorbell's 'ringing' binary sensor / event entity as the ring trigger in HomePanel admin.",
      ]);
      out.info("Details and caveats: docs/doorbells.md");
      if (kind === "eufy") status = "manual";
    }
    return status;
  },
};

/* ------------------------------------------------------------------ */
/* Remote access: Tailscale                                             */
/* ------------------------------------------------------------------ */

export const remoteStep: Step = {
  id: "remote",
  title: "Remote access (Tailscale)",
  summary: "Reach HA and HomePanel from anywhere through Tailscale, without opening router ports.",
  plan: (ctx) =>
    ctx.store.state.haOs === false
      ? "Print instructions only (install Tailscale on the Docker host)."
      : `Through the Supervisor API: add the community apps repository (${COMMUNITY_ADDONS_REPO}) if missing, install and ` +
        `start the Tailscale app (${TAILSCALE_SLUG}). You then log in to Tailscale from the app's log/web UI.`,
  explain:
    "Tailscale makes a private network between your devices. Install it on HA and on your phone/laptop; then " +
    "http://homeassistant:8123 and http://homeassistant:8080 work from anywhere. Free for personal use. " +
    "HomePanel marks connections from outside your LAN as 'remote' and refuses home-only actions.",
  async detect(ctx) {
    if (ctx.store.state.haOs === false) return { done: false, detail: "Docker host: check `tailscale status` on it." };
    if (!ctx.store.secrets.haToken) return { done: false, detail: "Needs the HA token first." };
    try {
      const info = await ctx.ha().withWs((s) => s.supervisor(`/addons/${TAILSCALE_SLUG}/info`, "get"));
      return info?.state === "started"
        ? { done: true, detail: "Tailscale app running." }
        : { done: false, detail: `Tailscale app ${info?.state ?? "not installed"}.` };
    } catch {
      return { done: false, detail: "Tailscale app not installed." };
    }
  },
  async run(ctx) {
    const { out } = ctx;
    if (ctx.store.state.haOs === false) {
      out.steps([
        "On the Docker host: curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up",
        "Install Tailscale on your phone/laptop and log in with the same account.",
        "Open http://<host-tailscale-name>:8123 and :8080 from anywhere.",
      ]);
      return "manual";
    }
    try {
      await ctx.ha().withWs(async (s) => {
        const store = await s.supervisor<{ repositories?: { source: string }[] }>("/store", "get");
        if (!(store.repositories ?? []).some((r) => r.source.includes("hassio-addons/repository"))) {
          out.info("Adding the community apps repository…");
          await s.supervisor("/store/repositories", "post", { repository: COMMUNITY_ADDONS_REPO }, 120);
        }
        const st = await ensureAppRunning(s, TAILSCALE_SLUG, (m) => out.info(m));
        out.ok(st === "started" ? "Tailscale app is running." : "Tailscale app installed.");
      });
    } catch (e) {
      out.warn(`Automatic install failed: ${(e as Error).message}`);
      out.steps([
        `HA → Settings → Apps → App store → ⋮ Repositories → add ${COMMUNITY_ADDONS_REPO}`,
        "Install 'Tailscale' → Start (Start on boot on).",
      ]);
    }
    out.steps([
      "Open the Tailscale app → 'Open Web UI' → Log in, and approve the machine in your Tailscale account.",
      "Install Tailscale on your phone and laptop (same account).",
      `From anywhere: http://homeassistant:8123 for HA and http://homeassistant:${SERVER_PORT} for HomePanel (MagicDNS name).`,
      "Optional: in the Tailscale admin console, disable key expiry for the HA machine so it never drops off.",
    ]);
    out.info("More: docs/remote-access.md");
    return "manual";
  },
};

/* ------------------------------------------------------------------ */
/* Screens                                                              */
/* ------------------------------------------------------------------ */

export function pairUrl(ctx: StepContext) {
  return ctx.store.state.serverUrl ?? `http://${ctx.store.state.host ?? "homeassistant.local"}:${SERVER_PORT}`;
}

export const screensStep: Step = {
  id: "screens",
  title: "Set up screens",
  summary: "Show how to turn iPads, Fire tablets, Android tablets, Pis and Windows PCs into HomePanel screens.",
  plan: () => "Print setup guides only. Nothing is changed.",
  explain:
    "Every screen opens the HomePanel URL in a browser, shows a 6-digit code, and you approve it in the admin page " +
    "with a profile (layout). Kiosk apps keep it fullscreen and awake.",
  async detect() {
    return { done: false, detail: "Screens are set up on each device." };
  },
  async run(ctx) {
    const { out, prompt } = ctx;
    const u = pairUrl(ctx);
    const which = await prompt.select({
      message: "Which screen?",
      choices: [
        ...Object.entries(SCREEN_GUIDES).map(([k, g]) => ({ value: k, name: g.title })),
        { value: "all", name: "Show all" },
      ],
    });
    const keys = which === "all" ? Object.keys(SCREEN_GUIDES) : [which];
    for (const k of keys) {
      const g = SCREEN_GUIDES[k]!;
      out.heading(g.title);
      out.steps(g.steps(u));
    }
    out.line();
    out.info(`Pairing URL: ${u}   Admin page (approve codes): ${u}/admin`);
    return "done";
  },
};
