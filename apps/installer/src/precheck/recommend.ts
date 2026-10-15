/**
 * Pick the next sensible setup mode from what the checks found. Pure: (checks, facts) → advice,
 * written for someone who doesn't want to think about it.
 */
import { getStep } from "../steps/index.js";
import type { Check, Facts, Recommendation } from "./types.js";

const stepTitle = (id: string) => getStep(id)?.title ?? id;

/** First Home Assistant wizard step that still needs doing, from live facts (not saved progress). */
export function nextHaStep(ha: NonNullable<Facts["ha"]>): string | undefined {
  if (ha.status === "unreachable") return "detect";
  if (ha.status === "preparing" || ha.status === "onboarding") return "onboard";
  if (ha.token !== "valid") return "token";
  if (ha.ipMethod === "dhcp") return "staticip";
  if (ha.haOs !== false && ha.mosquitto !== "running") return "mqtt";
  if (ha.homepanelApp !== "running" || ha.homepanelHealth === false) return "server";
  return undefined;
}

/** Plain-English list of what is still missing on Home Assistant. */
function haMissing(ha: NonNullable<Facts["ha"]>): string[] {
  const m: string[] = [];
  if (ha.status === "preparing") m.push("Home Assistant is still preparing (the first start takes 10–20 minutes)");
  if (ha.status === "onboarding") m.push("its owner account isn't created yet");
  if (ha.status === "onboarded" && ha.token === "none") m.push("HomePanel has no access token for it yet");
  if (ha.status === "onboarded" && ha.token === "invalid") m.push("the saved access token no longer works");
  if (ha.token === "valid" && ha.ipMethod === "dhcp") m.push("it doesn't have a fixed IP address yet (one router reboot could move it)");
  if (ha.token === "valid" && ha.haOs !== false && ha.mosquitto !== "running")
    m.push(ha.mosquitto === "stopped" ? "the Mosquitto app is stopped" : "the Mosquitto app isn't installed");
  if (ha.token === "valid" && ha.homepanelApp !== "running")
    m.push(ha.homepanelApp === "stopped" ? "the HomePanel app is stopped" : "the HomePanel app isn't installed");
  return m;
}

const join = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function haRec(f: Facts, then?: string): Recommendation {
  const ha = f.ha!;
  const step = nextHaStep(ha);
  const missing = haMissing(ha);
  const where =
    ha.status === "unreachable"
      ? `Home Assistant was set up at ${ha.url} but doesn't answer right now (is the VM / mini PC on?).`
      : ha.status === "preparing"
        ? `Home Assistant at ${ha.url} is still preparing.`
        : `Home Assistant answers at ${ha.url}${ha.version ? ` (${ha.version})` : ""}${ha.status === "onboarded" ? " and is set up" : ""}${ha.token === "valid" ? ", and your token works" : ""}.`;
  return {
    mode: "ha",
    ...(step ? { fromStep: step } : {}),
    title: step ? `Set up Home Assistant — continue at "${stepTitle(step)}"` : "Finish Home Assistant setup",
    why: `${where}${missing.length ? ` Still to do: ${join(missing)}.` : ""} Finished steps are skipped automatically.`,
    ...(then ? { then } : {}),
  };
}

export function recommend(_checks: Check[], f: Facts): Recommendation {
  const ha = f.ha;
  const haReady = !!ha && ha.status === "onboarded" && ha.homepanelApp !== "missing" && ha.homepanelHealth === true;
  const hosting = f.local.mode === "host" || (f.local.mode === undefined && f.tasks.server !== "missing");

  /* ---- this PC hosts the server ---- */
  if (hosting && !f.local.movedFrom) {
    if (haReady)
      return {
        mode: "move",
        title: "Move the server to Home Assistant",
        why: `The HomePanel app runs on Home Assistant (${ha!.homepanelUrl}). Moving hands your layouts over to it, so dashboards keep working when this PC is off. This PC keeps its temperatures and buttons.`,
      };
    if (ha && ha.status !== "unreachable")
      return haRec(f, "Then: move the server from this PC to Home Assistant (one click from here once the HomePanel app runs).");
    const broken: string[] = [];
    if (f.tasks.server !== "running" && f.localServer?.ok !== true) broken.push("the server isn't running");
    else if (f.localServer && !f.localServer.ok) broken.push("the server doesn't answer");
    if (f.tasks.agent === "missing") broken.push("this PC's agent isn't installed");
    else if (f.agent === "offline" || f.agent === "unregistered") broken.push("this PC's agent is offline");
    if (f.platform === "win32" && f.lhm && !f.lhm.ok) broken.push("LibreHardwareMonitor doesn't answer");
    if (broken.length)
      return {
        mode: "host",
        title: 'Repair "Host on this PC"',
        why: `This PC hosts HomePanel, but ${join(broken)}. Running it again checks every step and only redoes what's broken.`,
      };
    if (ha) return haRec(f, "Then: move the server to Home Assistant.");
    return {
      mode: "control",
      title: "Everything runs on this PC",
      why: "The server, this PC's agent and the sensors are all up.",
      then:
        f.lan.proxmox.length > 0
          ? `Optional: Proxmox found at ${f.lan.proxmox[0]} — "Set up Home Assistant" can create the Home Assistant VM there, so dashboards don't depend on this PC.`
          : 'Optional: "Set up Home Assistant" so dashboards don\'t depend on this PC being on.',
    };
  }

  /* ---- this PC joined a server (or handed its server over) ---- */
  if (f.local.mode === "join") {
    const problems: string[] = [];
    if (f.tasks.agent === "missing") problems.push("the agent isn't installed");
    else if (f.agent === "offline" || f.agent === "unregistered") problems.push(f.agent === "unregistered" ? "the server doesn't know this PC" : "the agent is offline");
    if (f.platform === "win32" && f.lhm && !f.lhm.ok) problems.push("LibreHardwareMonitor doesn't answer");
    if (problems.length)
      return {
        mode: "join",
        title: 'Repair "Join this PC"',
        why: `This PC reports to ${f.local.serverUrl ?? "a HomePanel server"}, but ${join(problems)}. Running it again only redoes what's broken.`,
      };
    if (ha && f.local.movedFrom && nextHaStep(ha)) return haRec(f);
    return {
      mode: "control",
      title: "This PC is connected",
      why: `It reports its temperatures and buttons to ${f.local.serverUrl ?? "your HomePanel server"}${f.agent === "online" ? " and is online" : ""}.`,
    };
  }

  /* ---- nothing installed on this PC yet ---- */
  if (haReady)
    return {
      mode: "join",
      title: "Join this PC to HomePanel",
      why: `HomePanel already runs on Home Assistant (${ha!.homepanelUrl}). Joining adds this PC's temperatures, drives and buttons to it.`,
    };
  const others = f.lan.homepanel;
  if (others.length)
    return {
      mode: "join",
      title: "Join this PC to HomePanel",
      why: `A HomePanel server answers at ${others[0]}. Joining adds this PC's temperatures, drives and buttons to it.`,
    };
  if (ha) return haRec(f, "Then: join this PC so its temperatures and buttons show up.");
  if (f.lan.proxmox.length)
    return {
      mode: "ha",
      title: "Set up Home Assistant",
      why: `No Home Assistant found, but Proxmox answers at ${f.lan.proxmox[0]}: setup can create the Home Assistant VM there for you.`,
      then: "Then: join this PC so its temperatures and buttons show up.",
    };
  return {
    mode: "host",
    title: "Host HomePanel on this PC",
    why: "No Home Assistant or HomePanel server found on your network. Hosting on this PC is the fastest way to a working dashboard; Home Assistant can come later and the server can move there.",
  };
}
