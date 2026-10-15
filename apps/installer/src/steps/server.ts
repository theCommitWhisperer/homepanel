import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOMEPANEL_APP_REPO, HOMEPANEL_APP_SLUG_SUFFIX, SERVER_PORT } from "../constants.js";
import { haHost } from "../ha/address.js";
import type { HaSocket } from "../ha/client.js";
import { lanIps, showCmd } from "../sys.js";
import { writeDockerEnv } from "./host.js";
import { ensureAppRunning } from "./mqtt.js";
import type { Step, StepContext } from "./types.js";

export async function serverHealth(
  fetchImpl: typeof fetch,
  serverUrl: string,
): Promise<{ ok: boolean; ha?: string; mqtt?: string; version?: string; error?: string }> {
  try {
    const r = await fetchImpl(serverUrl.replace(/\/+$/, "") + "/api/health", { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = (await r.json()) as any;
    return { ok: !!j.ok, ha: j.ha, mqtt: j.mqtt, version: j.version };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { ok: false, error: err.cause?.code ?? err.message };
  }
}

/** Add our app repository, install, configure and start the HomePanel app. Returns the slug. */
export async function installHomePanelApp(
  s: HaSocket,
  options: Record<string, unknown>,
  log: (m: string) => void,
  repo = HOMEPANEL_APP_REPO,
): Promise<string> {
  const store = await s.supervisor<{ repositories?: { source: string }[]; addons?: { slug: string; repository: string }[] }>("/store", "get");
  const hasRepo = (store.repositories ?? []).some((r) => r.source.replace(/\.git$/, "") === repo.replace(/\.git$/, ""));
  if (!hasRepo) {
    log(`Adding app repository ${repo}…`);
    await s.supervisor("/store/repositories", "post", { repository: repo }, 120);
  }
  const after = await s.supervisor<{ addons?: { slug: string }[] }>("/store/addons", "get").catch(async () =>
    s.supervisor<{ addons?: { slug: string }[] }>("/store", "get"),
  );
  const list = Array.isArray(after) ? (after as { slug: string }[]) : (after.addons ?? []);
  const slug = list.find((a) => a.slug.endsWith(HOMEPANEL_APP_SLUG_SUFFIX))?.slug;
  if (!slug) throw new Error("The HomePanel app did not show up in the app store after adding the repository.");
  let installed = false;
  try {
    const info = await s.supervisor(`/addons/${slug}/info`, "get");
    installed = !!info?.version;
  } catch {
    installed = false;
  }
  if (!installed) {
    log(`Installing ${slug} (building/pulling can take several minutes)…`);
    await s.supervisor(`/store/addons/${slug}/install`, "post", undefined, 1800);
  }
  await s.supervisor(`/addons/${slug}/options`, "post", { options, boot: "auto", watchdog: true });
  // restart so new options apply
  try {
    await s.supervisor(`/addons/${slug}/restart`, "post", undefined, 300);
  } catch {
    await ensureAppRunning(s, slug, log);
  }
  return slug;
}

async function ensureAdminPassword(ctx: StepContext) {
  if (!ctx.store.secrets.adminPassword) {
    ctx.out.info("Choose a password for the HomePanel admin page (approving screens, editing layouts).");
    ctx.store.setSecret("adminPassword", await ctx.secret("HomePanel admin password", { confirm: true, minLength: 6 }));
  }
  ctx.vault.add("adminPassword", ctx.store.secrets.adminPassword!);
}

export const serverStep: Step = {
  id: "server",
  title: "Install the HomePanel server",
  summary: "Install HomePanel as a Home Assistant app (HA OS) or start its Docker container.",
  plan: (ctx) =>
    ctx.store.state.haOs === false
      ? "Write the HA token, MQTT login and admin password into the Docker .env file (mode 600) and run `docker compose up -d --build homepanel`."
      : `Through the Supervisor API: add the app repository ${HOMEPANEL_APP_REPO}, install the HomePanel app, set its options ` +
        "(admin password; AI provider if you chose one) and start it on port 8080.",
  explain:
    "The HomePanel server is the hub screens connect to (port 8080). On HA OS it runs as an app (add-on) and gets " +
    "Home Assistant and MQTT access from the Supervisor automatically. With Docker it is the 'homepanel' service in compose.yaml.",
  async detect(ctx) {
    const url = ctx.store.state.serverUrl;
    if (!url) return { done: false, detail: "Server address unknown." };
    const h = await serverHealth(ctx.fetchImpl, url);
    return h.ok
      ? { done: true, detail: `HomePanel server ${h.version ?? ""} at ${url} (HA ${h.ha}, MQTT ${h.mqtt}).` }
      : { done: false, detail: `No HomePanel server at ${url} (${h.error}).` };
  },
  async run(ctx) {
    const { out, prompt } = ctx;
    await ensureAdminPassword(ctx);
    const host = haHost(ctx.store);
    ctx.store.update({ serverUrl: ctx.store.state.serverUrl ?? `http://${host}:${SERVER_PORT}` });

    if (ctx.store.state.haOs === false) {
      const dir = ctx.store.state.dockerDir;
      if (!dir || !existsSync(join(dir, "compose.yaml"))) {
        out.err("No Docker setup folder found. Run the 'host' step with 'Linux box with Docker' first.");
        return "failed";
      }
      await writeDockerEnv(ctx);
      const args = ["compose", "up", "-d", "--build", "homepanel"];
      out.info("This builds and starts the HomePanel container:");
      out.code(`cd ${dir} && ${showCmd("docker", args)}`);
      if (!(await prompt.confirm({ message: "Run it now?", default: true }))) return "manual";
      const r = await ctx.exec("docker", args, { cwd: dir, inherit: true, timeoutMs: 30 * 60_000 });
      if (r.code !== 0) {
        out.err("docker compose failed (see above).");
        return "failed";
      }
      ctx.store.update({ serverUrl: `http://${ctx.store.state.host === "127.0.0.1" ? lanIps()[0] ?? "127.0.0.1" : host}:${SERVER_PORT}` });
      out.ok(`HomePanel is starting at ${ctx.store.state.serverUrl}`);
      return "done";
    }

    if (!ctx.store.secrets.haToken) {
      out.err("Create the HA token first (token step).");
      return "failed";
    }
    const options: Record<string, unknown> = { admin_password: ctx.store.secrets.adminPassword };
    const ai = ctx.store.secrets.extra?.["ai_api_key"];
    const aiCfg = ctx.store.state.ai;
    if (aiCfg?.provider) {
      options.ai_provider = aiCfg.provider;
      if (aiCfg.model) options.ai_model = aiCfg.model;
      if (aiCfg.baseUrl) options.ai_base_url = aiCfg.baseUrl;
      if (ai) options.ai_api_key = ai;
    }
    try {
      const slug = await ctx.ha().withWs((s) => installHomePanelApp(s, options, (m) => out.info(m)));
      out.ok(`HomePanel app (${slug}) installed and started.`);
      return "done";
    } catch (e) {
      out.warn(`Automatic install failed: ${(e as Error).message}`);
      out.info("Install it by hand:");
      out.steps([
        `HA → Settings → Apps (Add-ons) → App store → ⋮ → Repositories → add ${HOMEPANEL_APP_REPO}`,
        "Refresh, open 'HomePanel' → Install.",
        "Configuration tab: set admin_password (and the AI fields if you want the assistant). Save.",
        "Info tab: Start on boot on, Watchdog on → Start.",
        `Open http://${host}:${SERVER_PORT}/admin`,
      ]);
      return "manual";
    }
  },
};
