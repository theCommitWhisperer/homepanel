/**
 * Widget SDK. A widget is one file:
 *
 *   export default defineWidget({
 *     type: "clock",
 *     name: "Clock",
 *     configSchema: z.object({ format24: z.boolean().optional() }),
 *     keys: (cfg) => [],
 *     Component: ({ config, placement }) => <div>…</div>,
 *   });
 *
 * and one line in widgets/index.ts. The dashboard validates the placement's extra keys with
 * configSchema, subscribes to keys(config) and renders Component inside an error boundary.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ComponentType } from "react";
import type { ZodType, ZodTypeDef } from "zod";
import type { ActionRequest, DataKey, DeviceInfo, WidgetPlacement } from "@homepanel/protocol";
import type { ActionResult, Connection } from "./lib/connection";

export interface WidgetProps<C> {
  config: C;
  placement: WidgetPlacement;
  /** true when the widget is shown fullscreen (idle screen) */
  fullscreen?: boolean;
}

export interface WidgetDef<C = any> {
  type: string;
  name: string;
  configSchema: ZodType<C, ZodTypeDef, unknown>;
  keys: (config: C) => DataKey[];
  Component: ComponentType<WidgetProps<C>>;
  /** draws its own surface (no card padding), e.g. camera, media */
  bleed?: boolean;
  /** the widget shows placement.title itself (the frame won't draw it) */
  ownsTitle?: boolean;
}

export function defineWidget<C>(def: WidgetDef<C>): WidgetDef<C> {
  return def;
}

export class Registry {
  private defs = new Map<string, WidgetDef>();
  register(def: WidgetDef) {
    if (this.defs.has(def.type)) throw new Error(`Widget type "${def.type}" registered twice`);
    this.defs.set(def.type, def);
    return this;
  }
  get(type: string): WidgetDef | undefined {
    return this.defs.get(type);
  }
  list(): WidgetDef[] {
    return Array.from(this.defs.values());
  }
}

/** Placement fields that belong to the grid, not the widget config. */
const PLACEMENT_KEYS = ["id", "type", "at", "title"];

export function widgetConfig(p: WidgetPlacement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(p)) if (PLACEMENT_KEYS.indexOf(k) < 0) out[k] = (p as any)[k];
  return out;
}

export type ParsedWidget =
  | { ok: true; def: WidgetDef; config: unknown; keys: DataKey[] }
  | { ok: false; reason: "unknown"; type: string }
  | { ok: false; reason: "invalid"; def: WidgetDef; errors: string[] };

export function parseWidget(registry: Registry, p: WidgetPlacement): ParsedWidget {
  const def = registry.get(p.type);
  if (!def) return { ok: false, reason: "unknown", type: p.type };
  const r = def.configSchema.safeParse(widgetConfig(p));
  if (!r.success) {
    return {
      ok: false,
      reason: "invalid",
      def,
      errors: r.error.issues.map((i) => (i.path.length ? i.path.join(".") + ": " : "") + i.message),
    };
  }
  let keys: DataKey[] = [];
  try {
    keys = def.keys(r.data);
  } catch {
    keys = [];
  }
  return { ok: true, def, config: r.data, keys };
}

/** Union of keys all given placements need. */
export function collectKeys(registry: Registry, placements: WidgetPlacement[]): DataKey[] {
  const set = new Set<DataKey>();
  for (const p of placements) {
    const r = parseWidget(registry, p);
    if (r.ok) r.keys.forEach((k) => set.add(k));
  }
  return Array.from(set).sort();
}

/* ------------------------------------------------------------------ */
/* Runtime context + hooks for widgets                                  */
/* ------------------------------------------------------------------ */
export interface WidgetEnv {
  connection: Connection;
  token: string | null;
  lite: boolean;
  device: DeviceInfo | null;
}

export const WidgetEnvContext = createContext<WidgetEnv | null>(null);

export function useEnv(): WidgetEnv {
  const env = useContext(WidgetEnvContext);
  if (!env) throw new Error("Widget rendered outside WidgetEnvContext");
  return env;
}

/** Latest value for a data key; re-renders only when that key changes. */
export function useKey<T = unknown>(key: DataKey | null | undefined): T | undefined {
  const { connection } = useEnv();
  const store = connection.store;
  const sub = useCallback((l: () => void) => (key ? store.subscribe(key, l) : () => undefined), [store, key]);
  const get = useCallback(() => (key ? store.get<T>(key) : undefined), [store, key]);
  return useSyncExternalStore(sub, get, get);
}

export function useLite() {
  return useEnv().lite;
}

export function useAction(): (a: ActionRequest, confirmed?: boolean) => Promise<ActionResult> {
  const { connection } = useEnv();
  return useCallback((a, c) => connection.action(a, c), [connection]);
}
