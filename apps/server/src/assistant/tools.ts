import YAML from "yaml";
import { BUILTIN_WIDGETS, DoorbellSchema, WidgetPlacementSchema } from "@homepanel/protocol";
import type { AgentManager } from "../mqtt/agents.js";
import type { EnvConfig } from "../config.js";
import type { DeviceStore } from "../devices.js";
import type { HaSource } from "../ha/types.js";
import type { ProfileStore } from "../profiles.js";
import type { ServerConfigStore } from "../serverConfig.js";

/** Local copy of @homepanel/ai's ToolDef (CONTRACTS.md), so the server builds without that package. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  kind: "look" | "act" | "build";
  summarize?(args: any): string;
  run(args: any): Promise<unknown>;
}
export interface AssistantDeps {
  ha: HaSource;
  agents: AgentManager;
  devices: DeviceStore;
  profiles: ProfileStore;
  config: ServerConfigStore;
  env: EnvConfig;
}

export const SYSTEM = `You are the HomePanel setup assistant inside the admin page of a self-hosted home dashboard.
HomePanel shows dashboards ("profiles", YAML) on screens (iPad, Fire tablets, monitors). Data comes from
Home Assistant entities and PC agents (temperatures, drives, actions). Screens use a grid; each widget
has \`type\` and \`at: [col, row, width, height]\` (0-based) plus its own keys.
Widget types and keys:
- clock: format24? (bool), showDate?
- pc-temps: pc, sensors? (ids), warnAt? (80), critAt? (90), style? gauges|list
- pc-drives: pc, openActions? {"C:": "open-drive-c"}
- buttons: buttons: [{label, icon?, action, confirm?}] where action is {kind: ha, domain, service, data?} | {kind: agent, pc, action} | {kind: wol, pc}; OR pc: <pcId> for all actions of a PC
- lights: entities: [light.*]
- entity: entity, label?
- camera: entity, refreshSec?
- media: src (URL or /media/<file>) and fit? cover|contain, OR folder (subfolder of media) + intervalSec? (seconds)
- text: text, size? s|m|l
Use look tools to find real entity ids, PCs and profiles before suggesting anything; never invent ids.
Use draft_widget to produce validated YAML. Changes (save_profile, register_agent, add_doorbell) need
the user's approval, which the UI asks for — describe what you will do, then call the tool.
Be brief and concrete. Never reveal tokens or keys.`;

export function toolsFor(d: AssistantDeps): ToolDef[] {
  return [
    {
      name: "list_entities",
      kind: "look",
      description: "List Home Assistant entities (id, state, friendly name). Optionally filter by domain or text.",
      parameters: {
        type: "object",
        properties: { domain: { type: "string", description: "e.g. light, camera, sensor" }, search: { type: "string" } },
      },
      async run(a: { domain?: string; search?: string }) {
        const q = a?.search?.toLowerCase();
        return d.ha
          .states()
          .filter((s) => !a?.domain || s.entity_id.startsWith(a.domain + "."))
          .filter((s) => !q || s.entity_id.includes(q) || String(s.attributes.friendly_name ?? "").toLowerCase().includes(q))
          .slice(0, 200)
          .map((s) => ({ id: s.entity_id, state: s.state, name: s.attributes.friendly_name }));
      },
    },
    {
      name: "list_agents",
      kind: "look",
      description: "List PC agents with status, and the action ids each one offers.",
      parameters: { type: "object", properties: {} },
      async run() {
        return d.agents.summaries().map((s) => ({ ...s, actions: d.agents.actionsOf(s.pcId)?.map((a) => ({ id: a.id, label: a.label, guard: a.guard })) }));
      },
    },
    {
      name: "list_devices",
      kind: "look",
      description: "List paired screens and the profile each uses, plus the available profile ids.",
      parameters: { type: "object", properties: {} },
      async run() {
        return { devices: d.devices.list(), profiles: d.profiles.list().map((p) => ({ id: p.id, name: p.name, grid: p.profile.grid, lite: p.profile.lite })) };
      },
    },
    {
      name: "get_profile",
      kind: "look",
      description: "Get the YAML of a profile.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async run(a: { id: string }) {
        const e = d.profiles.getEntry(a?.id);
        return e ? { id: e.id, yaml: e.yaml } : { error: `no profile "${a?.id}"` };
      },
    },
    {
      name: "draft_widget",
      kind: "build",
      description:
        "Validate a widget definition and return it as a YAML list item ready to paste into a profile's widgets. Pass the full widget object (type, at, and its keys).",
      parameters: {
        type: "object",
        properties: { widget: { type: "object", description: "widget object incl. type and at" } },
        required: ["widget"],
      },
      async run(a: { widget: unknown }) {
        const r = WidgetPlacementSchema.safeParse(a?.widget);
        if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
        const warnings: string[] = [];
        if (!(BUILTIN_WIDGETS as readonly string[]).includes(r.data.type)) warnings.push(`unknown widget type "${r.data.type}"`);
        const w = r.data as Record<string, unknown>;
        const ents = [w.entity, ...(Array.isArray(w.entities) ? w.entities : [])].filter((x): x is string => typeof x === "string");
        for (const e of ents) if (!d.ha.getState(e)) warnings.push(`entity ${e} not found in Home Assistant`);
        if (typeof w.pc === "string" && !d.agents.getRecord(w.pc)) warnings.push(`PC "${w.pc}" is not registered`);
        return { ok: true, yaml: YAML.stringify([r.data]), warnings };
      },
    },
    {
      name: "save_profile",
      kind: "act",
      description: "Create or replace a profile with complete YAML (id, name, grid, theme?, lite?, widgets).",
      parameters: { type: "object", properties: { id: { type: "string" }, yaml: { type: "string" } }, required: ["id", "yaml"] },
      summarize: (a: { id: string; yaml: string }) =>
        `${d.profiles.get(a?.id) ? "Replace" : "Create"} profile "${a?.id}" with:\n\n${a?.yaml}`,
      async run(a: { id: string; yaml: string }) {
        return d.profiles.put(a.id, a.yaml);
      },
    },
    {
      name: "register_agent",
      kind: "act",
      description: "Register a PC agent so it may connect. Returns its secret key (shown to the user only, not to you).",
      parameters: {
        type: "object",
        properties: { pcId: { type: "string" }, name: { type: "string" }, mac: { type: "string", description: "for Wake-on-LAN" } },
        required: ["pcId", "name"],
      },
      summarize: (a: { pcId: string; name: string; mac?: string }) =>
        `Register PC "${a?.pcId}" (${a?.name})${a?.mac ? ` with MAC ${a.mac} for Wake-on-LAN` : ""} and generate its agent key.`,
      async run(a: { pcId: string; name: string; mac?: string }) {
        d.agents.register(a.pcId, a.name, a.mac);
        return { ok: true, pcId: a.pcId, note: "Key generated. The user can copy it from Admin → PCs into the PC's agent.yaml." };
      },
    },
    {
      name: "add_doorbell",
      kind: "act",
      description: "Add or replace a doorbell in config.yaml (ring entity: binary_sensor or event.*, camera entity).",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "short name, e.g. front" },
          provider: { type: "string", enum: ["reolink", "eufy", "generic"] },
          name: { type: "string" },
          ring: { type: "string" },
          camera: { type: "string" },
          snapshot: { type: "string" },
        },
        required: ["key", "ring", "camera"],
      },
      summarize: (a: any) => `Add doorbell "${a?.key}" to config.yaml: ring when ${a?.ring} fires, show camera ${a?.camera}${a?.provider ? ` (${a.provider})` : ""}.`,
      async run(a: any) {
        const { key, ...rest } = a ?? {};
        const r = DoorbellSchema.safeParse(rest);
        if (!r.success || typeof key !== "string" || !key) return { ok: false, errors: r.success ? ["key required"] : r.error.issues.map((i) => i.message) };
        const res = d.config.update((doc) => doc.setIn(["doorbells", key], doc.createNode(r.data)));
        return res.ok ? { ok: true } : res;
      },
    },
  ];
}

