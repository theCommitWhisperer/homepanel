/**
 * The system check: every probe runs in parallel, each check is reported the moment it finishes
 * (`onCheck`), and nothing is changed. Ends with a recommendation (recommend.ts).
 */
import { HOMEPANEL_APP_SLUG_SUFFIX, MOSQUITTO_SLUG, MQTT_PORT, SERVER_PORT } from "../constants.js";
import { cleanHaUrl } from "../ha/client.js";
import { TASK_AGENT, TASK_SENSORS, TASK_SERVER, TASK_TRAY } from "../local/flow.js";
import { recommend } from "./recommend.js";
import type { AppState, Check, CheckGroup, Facts, FoundHa, HaDetails, LanScan, PrecheckEnv, PrecheckResult } from "./types.js";

export { TASK_TRAY };

/** The checks in display order (all start as "running"). */
export const CHECKS: { id: string; group: CheckGroup; label: string }[] = [
  { id: "pc.os", group: "pc", label: "This PC" },
  { id: "pc.admin", group: "pc", label: "Administrator rights" },
  { id: "pc.winget", group: "pc", label: "Windows Package Manager" },
  { id: "pc.network", group: "pc", label: "Network" },
  { id: "pc.firewall", group: "pc", label: "Network profile" },
  { id: "pc.internet", group: "pc", label: "Internet" },
  { id: "pc.setup", group: "pc", label: "Saved setup" },
  { id: "ha.found", group: "ha", label: "Home Assistant" },
  { id: "ha.onboarded", group: "ha", label: "Onboarding" },
  { id: "ha.token", group: "ha", label: "Access token" },
  { id: "ha.os", group: "ha", label: "Home Assistant OS (apps)" },
  { id: "ha.ip", group: "ha", label: "Fixed IP address" },
  { id: "ha.mosquitto", group: "ha", label: "MQTT broker (Mosquitto)" },
  { id: "ha.zbt1", group: "ha", label: "Zigbee (ZBT-1)" },
  { id: "ha.proxmox", group: "ha", label: "Proxmox" },
  { id: "hp.app", group: "homepanel", label: "HomePanel app on Home Assistant" },
  { id: "hp.local", group: "homepanel", label: "HomePanel server on this PC" },
  { id: "hp.agent", group: "homepanel", label: "This PC's agent" },
  { id: "hp.lan", group: "homepanel", label: "Other HomePanel servers" },
  { id: "sensors.lhm", group: "sensors", label: "LibreHardwareMonitor" },
];

const CHECK_TIMEOUT_MS = 12_000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(fallback)),
    );
  });
}

const safe = <T>(p: () => Promise<T>, fallback: T, ms = CHECK_TIMEOUT_MS) => withTimeout(Promise.resolve().then(p), ms, fallback);

function taskState(t: { exists: boolean; state?: string } | undefined): AppState {
  if (!t) return "unknown";
  if (!t.exists) return "missing";
  return /running/i.test(t.state ?? "") ? "running" : "stopped";
}

function appState(addons: HaDetails["addons"], match: (slug: string) => boolean): AppState {
  if (!addons) return "unknown";
  const a = addons.find((x) => match(x.slug));
  if (!a) return "missing";
  return a.state === "started" ? "running" : "stopped";
}

const hostOf = (url: string) => new URL(url).hostname;
const haPort = (url: string) => new URL(url).port || "80";

export interface PrecheckRun extends PrecheckResult {
  facts: Facts;
}

export async function runPrechecks(env: PrecheckEnv, onCheck: (c: Check) => void = () => undefined): Promise<PrecheckRun> {
  const results = new Map<string, Check>();
  const def = new Map(CHECKS.map((c) => [c.id, c]));
  const report = (id: string, state: Check["state"], detail: string, fix?: Check["fix"]) => {
    const d = def.get(id)!;
    const c: Check = { id, group: d.group, label: d.label, state, detail, ...(fix ? { fix } : {}) };
    results.set(id, c);
    onCheck(c);
  };
  for (const c of CHECKS) onCheck({ ...c, state: "running", detail: "Checking…" });

  const win = env.platform === "win32";
  const local = env.localSaved();
  const haStore = env.haSaved();
  const l = local.state.local ?? {};
  const net = env.net();

  /* ---------------- shared probes ---------------- */
  const pTasks = safe(
    async () => {
      const [server, agent, sensors, tray] = await Promise.all([TASK_SERVER, TASK_AGENT, TASK_SENSORS, TASK_TRAY].map((n) => env.taskInfo(n)));
      return { server: taskState(server), agent: taskState(agent), sensors: taskState(sensors), tray: taskState(tray) };
    },
    { server: "unknown", agent: "unknown", sensors: "unknown", tray: "unknown" } as Facts["tasks"],
  );
  const pMosqSvc = safe(async (): Promise<AppState> => {
    const s = await env.serviceInfo("mosquitto");
    return !s.exists ? "missing" : s.running ? "running" : "stopped";
  }, "unknown" as AppState);
  const pLan = safe(() => (net.ip ? env.scanLan(net.ip) : Promise.resolve({ proxmox: [], homepanel: [] })), { proxmox: [], homepanel: [] } as LanScan, 8000);

  const pHa = safe(async () => {
    const saved = haStore.state.haUrl;
    const extra = [saved, haStore.state.proxmox?.haIp, haStore.state.host].filter((x): x is string => !!x);
    const found = await env.findHa([...new Set(extra)]);
    const live = found.filter((f) => f.status !== "unreachable");
    const savedClean = saved ? cleanHaUrl(saved) : undefined;
    let pick: FoundHa | undefined =
      live.find((f) => f.url === savedClean) ??
      (savedClean ? live.find((f) => hostOf(f.url) === hostOf(savedClean)) : undefined) ??
      live.find((f) => f.status === "onboarded") ??
      live[0];
    if (!pick && savedClean) pick = { url: savedClean, status: "unreachable" };
    // Found it somewhere else than saved (e.g. port 80 instead of 8123): remember that for every later step.
    if (pick && pick.status !== "unreachable" && pick.url !== savedClean) env.rememberHa?.(pick.url);
    if (!pick) return { found, pick: undefined };
    const token = haStore.secrets.haToken;
    let tokenState: NonNullable<Facts["ha"]>["token"] = token ? "unknown" : "none";
    let details: HaDetails | undefined;
    let progress: string | undefined;
    if (pick.status === "preparing") progress = await env.haPreparingProgress(pick.url).catch(() => undefined);
    if (pick.status === "onboarded" && token) {
      tokenState = (await env.haTokenValid(pick.url, token).catch(() => false)) ? "valid" : "invalid";
      if (tokenState === "valid") details = await env.haDetails(pick.url, token).catch((e: Error) => ({ haOs: haStore.state.haOs !== false, zha: "unknown" as const, error: e.message }));
    }
    return { found, pick, tokenState, details, progress };
  }, { found: [] as FoundHa[], pick: undefined as FoundHa | undefined, tokenState: undefined, details: undefined, progress: undefined } as {
    found: FoundHa[];
    pick?: FoundHa;
    tokenState?: NonNullable<Facts["ha"]>["token"];
    details?: HaDetails;
    progress?: string;
  });

  const pHpApp = pHa.then(async (h) => {
    if (!h.pick) return undefined;
    const url = haStore.state.serverUrl && hostOf(haStore.state.serverUrl) === hostOf(h.pick.url) ? haStore.state.serverUrl : `http://${hostOf(h.pick.url)}:${SERVER_PORT}`;
    const health = h.pick.status === "unreachable" ? undefined : await safe(() => env.serverHealth(url), undefined, 6000);
    return { url, health };
  });

  const hosting = l.mode === "host" && !l.movedFrom;
  const pLocalServer = pTasks.then(async (t) => {
    if (!hosting && t.server === "missing") return undefined;
    const h = await safe(() => env.serverHealth(`http://127.0.0.1:${SERVER_PORT}`), undefined, 6000);
    return { ok: !!h?.ok, version: h?.version };
  });

  const pAgent = safe(async (): Promise<Facts["agent"]> => {
    if (!l.pcId || !l.serverUrl) return "none";
    if (local.secrets.adminPassword) {
      const s = await env.agentStatusAdmin(l.serverUrl, local.secrets.adminPassword, l.pcId);
      if (s === "online") return "online";
      if (s === "unregistered") return "unregistered";
      if (s) return "offline";
    }
    if (local.secrets.mqttPassword && l.mqttHost) {
      const s = await env.agentStatusMqtt(`mqtt://${l.mqttHost}:${MQTT_PORT}`, l.mqttUser ?? "homepanel", local.secrets.mqttPassword, l.pcId);
      if (s) return s;
    }
    return "unknown";
  }, "unknown" as Facts["agent"], 8000);

  const pLhm = safe(() => env.lhm(), { ok: false, count: 0 }, 5000);

  /* ---------------- This PC ---------------- */
  const jobs: Promise<unknown>[] = [];
  jobs.push(
    safe(() => env.osInfo(), { name: "unknown" }).then((os) => {
      if (!win) return report("pc.os", "info", `${os.name} — setup on Windows installs more (LibreHardwareMonitor, scheduled tasks).`);
      if (os.build !== undefined && os.build < 19044)
        return report("pc.os", "warn", `${os.name} (build ${os.build}). Windows 10 21H2 or newer is needed for hidden background windows.`, {
          label: "Open Windows Update",
          href: "ms-settings:windowsupdate",
        });
      report("pc.os", "ok", `${os.name}${os.build ? ` (build ${os.build})` : ""} · ${net.hostname}`);
    }),
  );
  jobs.push(
    safe(() => env.isElevated(), false).then((el) =>
      el
        ? report("pc.admin", "ok", "Running as administrator: setup can install programs and scheduled tasks.")
        : report("pc.admin", win ? "warn" : "info", win ? "Not running as administrator. Setup asks Windows for permission when it needs it." : "Not root. Host/Join on Linux need sudo."),
    ),
  );
  jobs.push(
    (win ? safe(() => env.wingetPresent(), false) : Promise.resolve(true)).then((ok) =>
      !win
        ? report("pc.winget", "info", "Not needed on this system.")
        : ok
          ? report("pc.winget", "ok", "winget is available for installing LibreHardwareMonitor and Mosquitto.")
          : report("pc.winget", "warn", "winget was not found. Setup needs it to install LibreHardwareMonitor and Mosquitto.", {
              label: "Get App Installer",
              href: "ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1",
            }),
    ),
  );
  jobs.push(
    Promise.resolve().then(() =>
      net.ip
        ? report("pc.network", "ok", `${net.ip}${net.mac ? ` · MAC ${net.mac}` : ""}`)
        : report("pc.network", "fail", "No network address found. Connect this PC to your home network (cable or Wi-Fi)."),
    ),
  );
  jobs.push(
    (win ? safe(() => env.networkCategory(), "") : Promise.resolve("")).then((cat) => {
      if (!win) return report("pc.firewall", "info", "Not a Windows PC.");
      if (/public/i.test(cat))
        return report("pc.firewall", "warn", "Windows treats this network as Public: tablets can't reach a dashboard hosted on this PC.", {
          label: "Mark as Private (home) network",
          action: "network/private",
        });
      if (!cat) return report("pc.firewall", "info", "Could not read the network profile.");
      report("pc.firewall", "ok", `${cat} network (home): other devices may connect.`);
    }),
  );
  jobs.push(
    safe(() => env.internet(), false, 6000).then((ok) =>
      ok
        ? report("pc.internet", "ok", "Internet reachable (downloads, updates, the AI guide).")
        : report("pc.internet", "warn", "No internet right now. Setup needs it to download LibreHardwareMonitor, Mosquitto and Home Assistant apps."),
    ),
  );
  jobs.push(
    Promise.resolve().then(() => {
      const parts: string[] = [];
      if (l.mode === "host" && !l.movedFrom) parts.push("this PC hosts HomePanel");
      else if (l.movedFrom) parts.push(`server moved to ${l.serverUrl}`);
      else if (l.mode === "join") parts.push(`joined ${l.serverUrl ?? "a server"}`);
      if (l.pcId) parts.push(`PC id "${l.pcId}"`);
      const haDone = Object.entries(haStore.state.steps).filter(([, v]) => v.status === "done").map(([k]) => k);
      if (haDone.length) parts.push(`Home Assistant steps done: ${haDone.join(", ")}`);
      if (!parts.length) return report("pc.setup", "info", "Nothing set up on this PC yet.");
      report("pc.setup", "info", parts.join(" · "));
    }),
  );

  /* ---------------- Home Assistant ---------------- */
  jobs.push(
    pHa.then((h) => {
      const p = h.pick;
      if (!p) {
        report("ha.found", "warn", "No Home Assistant found on your network (looked via mDNS and homeassistant.local on ports 8123 and 80).", {
          label: "Set up Home Assistant",
          mode: "ha",
          fromStep: "detect",
        });
        for (const id of ["ha.onboarded", "ha.token", "ha.os", "ha.ip", "ha.mosquitto"]) report(id, "info", "Needs Home Assistant.");
        return;
      }
      if (p.status === "unreachable")
        report("ha.found", "fail", `Saved address ${p.url} doesn't answer (also tried port ${haPort(p.url) === "80" ? "8123" : "80"}). Is the VM / mini PC running?`, {
          label: "Find it again",
          mode: "ha",
          fromStep: "detect",
        });
      else report("ha.found", "ok", `${p.url}${p.name ? ` (${p.name})` : ""}${haPort(p.url) === "80" ? " — port 80" : ""}${h.details?.version ? ` · ${h.details.version}` : p.version ? ` · ${p.version}` : ""}`);

      if (p.status === "preparing")
        report("ha.onboarded", "warn", `Still preparing (first start downloads ~700 MB, 10–20 min)${h.progress ? `: ${h.progress}` : ""}.`, {
          label: "Wait for it and onboard",
          mode: "ha",
          fromStep: "onboard",
        });
      else if (p.status === "onboarding")
        report("ha.onboarded", "warn", "Waiting for its owner account (onboarding).", { label: "Onboard Home Assistant", mode: "ha", fromStep: "onboard" });
      else if (p.status === "onboarded") report("ha.onboarded", "ok", "Owner account created; Home Assistant is set up.");
      else report("ha.onboarded", "info", "Unknown while Home Assistant doesn't answer.");

      if (p.status !== "onboarded") report("ha.token", "info", "Comes after onboarding.");
      else if (h.tokenState === "valid") report("ha.token", "ok", "Saved token works.");
      else if (h.tokenState === "invalid")
        report("ha.token", "fail", "The saved token is rejected (revoked or expired).", { label: "Create a new token", mode: "ha", fromStep: "token" });
      else report("ha.token", "warn", "No token saved: HomePanel setup can't look inside Home Assistant yet.", { label: "Add a token", mode: "ha", fromStep: "token" });

      const d = h.details;
      if (!d) {
        report("ha.os", "info", h.tokenState === "valid" ? "Could not ask Home Assistant." : "Needs a working token.");
        report("ha.mosquitto", "info", h.tokenState === "valid" ? "Could not ask Home Assistant." : "Needs a working token.");
        report("ha.ip", "info", h.tokenState === "valid" ? "Could not ask Home Assistant." : "Needs a working token.");
        return;
      }
      if (d.ip?.method === "static") report("ha.ip", "ok", `Fixed address ${d.ip.address ?? "set"}${d.ip.iface ? ` on ${d.ip.iface}` : ""}.`);
      else if (d.ip?.method === "dhcp")
        report("ha.ip", "warn", `Uses ${d.ip.address ?? "an address"} from your router (DHCP), which can change after a reboot and break every screen and PC.`, {
          label: "Give it a fixed IP",
          mode: "ha",
          fromStep: "staticip",
        });
      else if (!d.haOs) report("ha.ip", "info", "Set a fixed IP on the Docker host, or reserve it in your router.", { label: "Fixed IP step", mode: "ha", fromStep: "staticip" });
      else report("ha.ip", "info", "Couldn't read Home Assistant's network settings.");
      report("ha.os", d.haOs ? "ok" : "info", d.haOs ? "Home Assistant OS: apps (add-ons) available." : "Home Assistant Container: no apps; MQTT and HomePanel run in Docker.");
      if (!d.haOs) return report("ha.mosquitto", "info", "Runs in Docker next to Home Assistant (no apps on this install).");
      const m = appState(d.addons, (s) => s === MOSQUITTO_SLUG);
      if (m === "running") report("ha.mosquitto", "ok", "Mosquitto app installed and running.");
      else if (m === "stopped") report("ha.mosquitto", "warn", "Mosquitto app installed but stopped.", { label: "Start it (MQTT step)", mode: "ha", fromStep: "mqtt" });
      else if (m === "missing") report("ha.mosquitto", "warn", "Mosquitto app not installed yet.", { label: "Install MQTT", mode: "ha", fromStep: "mqtt" });
      else report("ha.mosquitto", "info", `Could not list the apps${d.error ? `: ${d.error}` : ""}.`);
    }),
  );
  jobs.push(
    Promise.all([pHa, safe(() => env.usbZbt1(), undefined)]).then(([h, usb]) => {
      const zha = h.details?.zha ?? "unknown";
      if (zha === "loaded") return report("ha.zbt1", "ok", "Home Assistant's Zigbee (ZHA) is set up.");
      if (zha === "discovered")
        return report("ha.zbt1", "warn", "Home Assistant found a Zigbee stick (ZBT-1) waiting to be set up.", { label: "Set up Zigbee", mode: "ha", fromStep: "zigbee" });
      if (usb)
        return report("ha.zbt1", "warn", "A ZBT-1 is plugged into THIS PC. It belongs on the Home Assistant machine (pass it through to the VM).");
      if (zha === "none") return report("ha.zbt1", "info", "Zigbee isn't set up in Home Assistant yet (optional).", { label: "Set up Zigbee", mode: "ha", fromStep: "zigbee" });
      report("ha.zbt1", "info", h.pick ? "Unknown (needs a working token)." : "Needs Home Assistant.");
    }),
  );
  jobs.push(
    pLan.then((lan) =>
      lan.proxmox.length
        ? report("ha.proxmox", "info", `Proxmox at ${lan.proxmox.map((h) => `https://${h}:8006`).join(", ")}.`, { label: "Open Proxmox", href: `https://${lan.proxmox[0]}:8006` })
        : report("ha.proxmox", "info", "No Proxmox host found on this network (only needed to create a Home Assistant VM)."),
    ),
  );

  /* ---------------- HomePanel ---------------- */
  jobs.push(
    Promise.all([pHa, pHpApp]).then(([h, app]) => {
      if (!h.pick || !app) return report("hp.app", "info", "Needs Home Assistant.");
      const st = appState(h.details?.addons, (s) => s.endsWith(HOMEPANEL_APP_SLUG_SUFFIX));
      if (app.health?.ok) return report("hp.app", "ok", `Answers at ${app.url} (v${app.health.version ?? "?"}, MQTT ${app.health.mqtt ?? "?"}).`, { label: "Open dashboard", href: app.url });
      if (st === "running") return report("hp.app", "warn", `Installed and started, but ${app.url}/api/health doesn't answer yet.`, { label: "Check the app", mode: "ha", fromStep: "server" });
      if (st === "stopped") return report("hp.app", "warn", "Installed but stopped.", { label: "Start it", mode: "ha", fromStep: "server" });
      if (st === "missing") return report("hp.app", "warn", "Not installed on Home Assistant yet.", { label: "Install the HomePanel app", mode: "ha", fromStep: "server" });
      report("hp.app", "info", `${app.url} doesn't answer${h.details ? "" : " (app list needs a working token)"}.`);
    }),
  );
  jobs.push(
    Promise.all([pTasks, pLocalServer, pMosqSvc]).then(([t, s, mq]) => {
      if (!s) return report("hp.local", "info", l.movedFrom ? `Retired: the server moved to ${l.serverUrl}.` : "This PC doesn't host a HomePanel server.");
      const broker = mq === "running" ? "Mosquitto running" : mq === "missing" ? "no Mosquitto service" : `Mosquitto ${mq}`;
      if (s.ok) return report("hp.local", "ok", `Answers on port ${SERVER_PORT} (v${s.version ?? "?"}) · task ${t.server} · ${broker}.`, { label: "Open dashboard", href: `http://localhost:${SERVER_PORT}` });
      if (t.server === "missing") return report("hp.local", "fail", `Set up as host, but the "${TASK_SERVER}" task is missing.`, { label: "Repair Host on this PC", mode: "host" });
      report("hp.local", "fail", `Doesn't answer on port ${SERVER_PORT} (task ${t.server} · ${broker}).`, { label: "Start the server", action: "server/restart" });
    }),
  );
  jobs.push(
    Promise.all([pTasks, pAgent]).then(([t, a]) => {
      if (a === "none" && t.agent === "missing") return report("hp.agent", "info", "This PC isn't connected to HomePanel yet.");
      if (t.agent === "missing") return report("hp.agent", "fail", `The "${TASK_AGENT}" task is missing.`, { label: "Repair", mode: l.mode === "host" ? "host" : "join" });
      const who = l.pcId ? `"${l.pcId}"` : "This PC";
      if (a === "online") return report("hp.agent", "ok", `${who} is online on ${l.serverUrl} (task ${t.agent}).`);
      if (a === "unregistered") return report("hp.agent", "fail", `${l.serverUrl} doesn't know ${who}.`, { label: "Register again", mode: l.mode === "host" ? "host" : "join" });
      if (a === "offline") return report("hp.agent", "fail", `${who} is offline on ${l.serverUrl} (task ${t.agent}).`, { label: "Restart the agent", action: "agent/restart" });
      report("hp.agent", t.agent === "running" ? "info" : "warn", `Task ${t.agent}; online status unknown (no saved login for ${l.serverUrl ?? "the server"}).`, t.agent === "running" ? undefined : { label: "Start the agent", action: "agent/start" });
    }),
  );
  jobs.push(
    Promise.all([pLan, pHpApp]).then(([lan, app]) => {
      const others = lan.homepanel.filter((u) => !app || hostOf(u) !== hostOf(app.url));
      if (others.length) return report("hp.lan", "info", `Also answering: ${others.join(", ")}.`);
      report("hp.lan", "info", "No other HomePanel server on this network.");
    }),
  );

  /* ---------------- Sensors ---------------- */
  jobs.push(
    Promise.all([pLhm, pTasks]).then(([lhm, t]) => {
      if (!win && !lhm.ok) return report("sensors.lhm", "info", "Windows only (Linux reads hwmon directly).");
      if (lhm.ok) return report("sensors.lhm", "ok", `Web server answers on port 8085 with ${lhm.count} sensors.`);
      if (t.sensors === "missing" && !l.mode) return report("sensors.lhm", "info", "Installed by Host or Join this PC.");
      if (t.sensors === "missing") return report("sensors.lhm", "fail", `The "${TASK_SENSORS}" task is missing.`, { label: "Repair", mode: l.mode === "join" ? "join" : "host" });
      report("sensors.lhm", "fail", "LibreHardwareMonitor's web server (port 8085) doesn't answer.", { label: "Start LibreHardwareMonitor", action: "sensors/start" });
    }),
  );

  await Promise.all(jobs);
  const [tasks, mq, lan, h, app, localServer, agent, lhm] = await Promise.all([pTasks, pMosqSvc, pLan, pHa, pHpApp, pLocalServer, pAgent, pLhm]);
  const facts: Facts = {
    platform: env.platform,
    local: { mode: l.mode, movedFrom: l.movedFrom, serverUrl: l.serverUrl, pcId: l.pcId },
    tasks,
    mosquittoService: mq,
    ...(localServer ? { localServer } : {}),
    ...(h.pick
      ? {
          ha: {
            url: h.pick.url,
            status: h.pick.status,
            version: h.details?.version ?? h.pick.version,
            token: h.tokenState ?? "none",
            haOs: h.details?.haOs ?? haStore.state.haOs,
            mosquitto: appState(h.details?.addons, (s) => s === MOSQUITTO_SLUG),
            homepanelApp: appState(h.details?.addons, (s) => s.endsWith(HOMEPANEL_APP_SLUG_SUFFIX)),
            homepanelHealth: app?.health ? app.health.ok : h.pick.status === "unreachable" ? undefined : false,
            homepanelUrl: app?.url ?? `http://${hostOf(h.pick.url)}:${SERVER_PORT}`,
            zha: h.details?.zha ?? "unknown",
            ...(h.details?.ip ? { ipMethod: h.details.ip.method } : {}),
          },
        }
      : {}),
    agent,
    lhm,
    lan: { proxmox: lan.proxmox, homepanel: lan.homepanel.filter((u) => !app || hostOf(u) !== hostOf(app.url)) },
  };
  const checks = CHECKS.map((c) => results.get(c.id) ?? { ...c, state: "info" as const, detail: "Not checked." });
  return { checks, recommendation: recommend(checks, facts), facts };
}
