import { saveHaUrl } from "./detect.js";
import { HaClient, HaError, type CoreLocation } from "../ha/client.js";
import { waitForHa } from "../ha/discover.js";
import { hooks } from "../bridge/hooks.js";
import { detectHaOs } from "./detect.js";
import type { Step, StepContext } from "./types.js";

export interface OnboardInput {
  name: string;
  username: string;
  password: string;
  language?: string;
  location?: CoreLocation;
}

/**
 * Full onboarding over the API, exactly like HA's onboarding page:
 * users → auth code → token → core_config → analytics → integration, then config/core/update over WS.
 * Returns the short-lived access token.
 */
export async function onboardHomeAssistant(client: HaClient, input: OnboardInput): Promise<string> {
  const code = await client.onboardUser(input);
  const tok = await client.exchangeAuthCode(code);
  // The remaining steps may already be done if a previous run was interrupted; ignore "already done" (403).
  const tolerant = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      if (!(e instanceof HaError && (e.status === 403 || e.status === 400))) throw e;
    }
  };
  await tolerant(() => client.onboardCoreConfig());
  await tolerant(() => client.onboardAnalytics());
  await tolerant(() => client.onboardIntegration());
  if (input.location && Object.keys(input.location).length) {
    await client.withWs((s) => s.updateCoreConfig(input.location!));
  }
  return tok.access_token;
}

/** Guess sensible defaults from this computer's locale. */
export function localeDefaults(): { time_zone: string; country: string; unit_system: "metric" | "us_customary"; language: string } {
  const loc = Intl.DateTimeFormat().resolvedOptions();
  const lang = (process.env.LANG || loc.locale || "en-US").replace(/\..*$/, "").replace("_", "-");
  const country = (lang.split("-")[1] || "US").toUpperCase();
  return {
    time_zone: loc.timeZone || "UTC",
    country,
    unit_system: ["US", "LR", "MM"].includes(country) ? "us_customary" : "metric",
    language: lang.split("-")[0] || "en",
  };
}

async function askLocation(ctx: StepContext): Promise<CoreLocation> {
  const d = localeDefaults();
  const p = ctx.prompt;
  const city = await p.input({ message: "Home name / city (shown in HA):", default: "Home" });
  const time_zone = await p.input({ message: "Time zone (IANA, e.g. America/Denver):", default: d.time_zone });
  const country = (await p.input({ message: "Country code (2 letters):", default: d.country })).toUpperCase();
  const unit_system = await p.select<"metric" | "us_customary">({
    message: "Units:",
    choices: [
      { value: "us_customary", name: "US customary (°F, miles)" },
      { value: "metric", name: "Metric (°C, km)" },
    ],
    default: d.unit_system,
  });
  const ll = await p.input({ message: "Latitude,longitude (optional, for sun/weather; Enter to skip):", default: "" });
  const loc: CoreLocation = { location_name: city, time_zone, country, unit_system };
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(ll);
  if (m) {
    loc.latitude = Number(m[1]);
    loc.longitude = Number(m[2]);
  }
  ctx.store.update({ location: { city, time_zone, country, unit_system } });
  return loc;
}

export const onboardStep: Step = {
  id: "onboard",
  title: "Create your Home Assistant account",
  summary: "Wait for Home Assistant to start, then create the owner account and set location/units.",
  plan: (ctx) =>
    `Wait for ${ctx.store.state.haUrl ?? "Home Assistant"} to answer, then (if it is brand new) create the owner account ` +
    "with the name/username/password you type locally, accept defaults for analytics (off), and set home name, time zone, " +
    "country and units. If HA is already set up you will log in instead (password typed locally).",
  explain:
    "A fresh Home Assistant starts in onboarding mode. This step does what HA's welcome page does, through its API: " +
    "creates the owner account, finishes onboarding and sets your location and units. If HA is already onboarded, " +
    "you'll log in with your existing owner account instead so the installer can create a token.",
  async detect(ctx) {
    if (!ctx.store.state.haUrl) return { done: false, detail: "Home Assistant address unknown." };
    const s = await new HaClient(ctx.store.state.haUrl, { fetchImpl: ctx.fetchImpl }).onboardingStatus();
    if (s.state === "onboarded") return { done: true, detail: "Home Assistant is already onboarded." };
    if (s.state === "onboarding") return { done: false, detail: "Home Assistant is waiting for onboarding." };
    if (s.state === "preparing") return { done: false, detail: "Home Assistant OS is still preparing (first boot downloads ~700 MB; 10–20 min)." };
    return { done: false, detail: `Home Assistant is not reachable (${s.error}).` };
  },
  async run(ctx) {
    const { out, prompt } = ctx;
    let url = ctx.store.state.haUrl;
    if (!url) {
      out.err("No Home Assistant address yet — run the 'detect' step first.");
      return "failed";
    }
    out.info(`Waiting for Home Assistant at ${url} (first boot downloads ~700 MB and can take 10–20 minutes)…`);
    let last = -60;
    let lastState = "";
    const up = await waitForHa(url, {
      fetchImpl: ctx.fetchImpl,
      timeoutMs: 30 * 60_000,
      intervalMs: ctx.noWait ? 1 : 5000,
      onTick: (s, state, progress) => {
        const pct = progress ? /(\d+)%/.exec(progress)?.[1] : undefined;
        hooks().progress?.({
          stepId: "onboard",
          label:
            state === "preparing"
              ? `Home Assistant is preparing… ${Math.max(1, Math.round(s / 60))} min${progress ? ` — ${progress}` : ""}`
              : `Waiting for Home Assistant to answer… ${Math.max(1, Math.round(s / 60))} min`,
          ...(pct ? { pct: Number(pct) } : {}),
        });
        if (state !== lastState) {
          lastState = state;
          out.info(state === "preparing" ? "Home Assistant OS is preparing (downloading and installing Home Assistant)…" : "Not answering yet (the VM may still be booting)…");
        }
        if (s - last >= 60) {
          last = s;
          out.info(`still waiting… ${Math.round(s / 60)} min${progress ? ` — ${progress}` : ""}`);
        }
      },
    });
    if (!up) {
      out.err("Home Assistant did not answer. Check it has power and network, then re-run setup.");
      return "failed";
    }
    if (up !== url) {
      out.info(`Home Assistant answers at ${up} (not ${url}); using that.`);
      await saveHaUrl(ctx, up);
      url = up;
    }
    const client = new HaClient(url, { fetchImpl: ctx.fetchImpl });
    const status = await client.onboardingStatus();
    if (status.state === "onboarded") {
      out.ok("Home Assistant is already set up.");
      return "done";
    }
    const steps = status.state === "onboarding" ? status.steps : [];
    if (steps.find((s) => s.step === "user")?.done) {
      out.warn("The owner account already exists but onboarding was not finished.");
      out.info(`Open ${url} in a browser, log in and finish the remaining pages, then re-run setup.`);
      return "manual";
    }
    out.info("Create the Home Assistant owner account (this is your admin login for HA).");
    const name = await prompt.input({ message: "Your name:", validate: (v) => (v.trim() ? true : "Required") });
    const username = (
      await prompt.input({
        message: "Username (lowercase):",
        default: name.trim().toLowerCase().split(/\s+/)[0],
        validate: (v) => (/^[a-z0-9._-]+$/.test(v.trim()) ? true : "Lowercase letters, digits, . _ -"),
      })
    ).trim();
    const password = await ctx.secret("Home Assistant owner password", { confirm: true, minLength: 8 });
    const location = await askLocation(ctx);
    try {
      const token = await onboardHomeAssistant(client, {
        name: name.trim(),
        username,
        password,
        language: localeDefaults().language,
        location,
      });
      ctx.store.setSecret("haAccessToken", token);
      ctx.vault.add("haAccessToken", token);
      ctx.store.update({ owner: { name: name.trim(), username } });
      out.ok(`Home Assistant owner "${username}" created and onboarding finished.`);
      return "done";
    } catch (e) {
      out.err(`Onboarding failed: ${(e as Error).message}`);
      out.info(`You can finish it in the browser at ${url} and then re-run setup.`);
      return "failed";
    }
  },
};

/* ------------------------------------------------------------------ */

/** Log in with username/password via the login flow (for an already-onboarded HA). */
export async function loginWithPassword(client: HaClient, username: string, password: string): Promise<string> {
  const flow = await client.request<{ flow_id: string; type: string }>(
    "POST",
    "/auth/login_flow",
    { client_id: client.clientId, handler: ["homeassistant", null], redirect_uri: client.clientId },
    { auth: false },
  );
  const step = await client.request<{ type: string; result?: string; errors?: Record<string, string>; step_id?: string }>(
    "POST",
    `/auth/login_flow/${flow.flow_id}`,
    { client_id: client.clientId, username, password },
    { auth: false },
  );
  if (step.type !== "create_entry" || !step.result) {
    if (step.step_id === "mfa") throw new HaError("This account uses two-factor login; create a token in your HA profile instead.");
    throw new HaError(`Login failed${step.errors?.base ? `: ${step.errors.base}` : ""}`);
  }
  return (await client.exchangeAuthCode(step.result)).access_token;
}

export const tokenStep: Step = {
  id: "token",
  title: "Create a HomePanel token in Home Assistant",
  summary: "Create a long-lived access token named HomePanel (valid 10 years).",
  plan: () =>
    "Connect to Home Assistant's WebSocket API and create a long-lived access token named 'HomePanel' (10 years). " +
    "It is stored only in ~/.homepanel/secrets.json (mode 600) and in the HomePanel server config.",
  explain:
    "HomePanel talks to Home Assistant with a long-lived access token. You can see and revoke it in HA under your " +
    "profile → Security → Long-lived access tokens. (When HomePanel runs as an HA app it uses the Supervisor token " +
    "instead, but the installer still needs one for the remaining steps.)",
  async detect(ctx) {
    const t = ctx.store.secrets.haToken;
    if (!t || !ctx.store.state.haUrl) return { done: false, detail: "No token yet." };
    const ok = await new HaClient(ctx.store.state.haUrl, { token: t, fetchImpl: ctx.fetchImpl }).apiOk();
    return ok ? { done: true, detail: "Token works." } : { done: false, detail: "Saved token is rejected or HA is unreachable." };
  },
  async run(ctx) {
    const { out, prompt } = ctx;
    const url = ctx.store.state.haUrl;
    if (!url) {
      out.err("No Home Assistant address yet.");
      return "failed";
    }
    const client = new HaClient(url, { fetchImpl: ctx.fetchImpl, token: ctx.store.secrets.haAccessToken });
    if (!client.token || !(await client.apiOk())) {
      const how = await prompt.select({
        message: "To create the token the installer must log in to Home Assistant once. How?",
        choices: [
          { value: "login", name: "Log in with my HA username + password (typed here, hidden)" },
          { value: "paste", name: "I'll paste a long-lived token I created in HA (Profile → Security)" },
        ],
      });
      if (how === "paste") {
        const t = cleanPastedToken(await ctx.secret("Home Assistant long-lived token"));
        client.token = t;
        if (!(await client.apiOk())) {
          const why = await client.request("GET", "/api/").then(
            () => "",
            (e) => (e as Error).message,
          );
          out.err(`Home Assistant at ${url} did not accept that token${why ? `: ${why}` : ""}.`);
          if (/Cannot reach/.test(why)) out.info("That's a connection problem, not the token: check the address in your browser's address bar and re-run the 'detect' step.");
          else out.info(`The token is ${t.length} characters long (HA tokens are about 180). If it looks short, copy it again.`);
          return "failed";
        }
        ctx.store.setSecret("haToken", t);
        out.ok("Token saved.");
        await detectHaOs(ctx);
        return "done";
      }
      const username = await prompt.input({ message: "HA username:", default: ctx.store.state.owner?.username });
      const password = await ctx.secret("Home Assistant password");
      try {
        client.token = await loginWithPassword(client, username, password);
      } catch (e) {
        out.err((e as Error).message);
        return "failed";
      }
    }
    try {
      const llt = await client.withWs((s) => s.createLongLivedToken("HomePanel", 3650));
      ctx.store.setSecret("haToken", llt);
      ctx.vault.add("haToken", llt);
      out.ok("Created long-lived token 'HomePanel'.");
    } catch (e) {
      const msg = (e as Error).message;
      if (/already exists|name/i.test(msg)) {
        out.warn("A token called 'HomePanel' already exists. Delete it in HA (Profile → Security) or paste it via re-run.");
      } else out.err(`Could not create the token: ${msg}`);
      return "failed";
    }
    await detectHaOs(ctx);
    out.info(ctx.store.state.haOs ? "This is Home Assistant OS — apps (add-ons) are available." : "This is HA Container/Core — no apps; MQTT runs in Docker.");
    return "done";
  },
};

/**
 * Tokens pasted into a Windows console can carry bracketed-paste markers (ESC[200~ … ESC[201~),
 * spaces or line breaks. Keep just the token (a JWT: three dot-separated base64url parts).
 */
export function cleanPastedToken(raw: string): string {
  const s = raw.replace(/\x1b\[[0-9;]*[~A-Za-z]/g, "").replace(/\[20[01]~/g, "").replace(/\s+/g, "");
  const jwt = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(s);
  return jwt ? jwt[0] : s;
}
