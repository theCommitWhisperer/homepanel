import { useState } from "react";
import { z } from "zod";
import type { HaEntityState } from "@homepanel/protocol";
import { defineWidget, useAction, useKey, useKeysMatching } from "../sdk";
import { Sheet, usePress, useSize } from "../components";
import { fitGrid } from "../lib/store";
import { toast } from "../lib/toast";
import { Icon } from "../icons";
import { brightnessPct, domainOf, friendly, isOn, lightRgb, supportsBrightness, supportsColor, unavailable } from "./ha-util";

/** entities omitted → every light Home Assistant has (wildcard key `ha:light.*`). */
const schema = z.object({ entities: z.array(z.string()).min(1).optional() });
export const ALL_LIGHTS = "ha:light.*";
export const lightKeys = (c: { entities?: string[] }) => (c.entities && c.entities.length ? c.entities.map((id) => "ha:" + id) : [ALL_LIGHTS]);

const SWATCHES: [string, number[]][] = [
  ["Warm", [255, 180, 107]], ["Daylight", [255, 244, 229]], ["Red", [255, 64, 48]], ["Orange", [255, 140, 0]],
  ["Green", [60, 220, 110]], ["Teal", [40, 210, 200]], ["Blue", [60, 110, 255]], ["Purple", [170, 80, 255]],
];

function LightSheet({ id, e, onClose }: { id: string; e?: HaEntityState; onClose: () => void }) {
  const send = useAction();
  const current = brightnessPct(e);
  const [pct, setPct] = useState<number>(isOn(e) ? current ?? 100 : 0);
  const apply = async (data: Record<string, unknown>) => {
    const r = await send({ kind: "ha", domain: "light", service: "turn_on", data: { entity_id: id, ...data } });
    if (!r.ok) toast(friendly(e, id) + ": " + (r.error ?? "failed"), "error");
  };
  const commit = (v: number) => {
    if (v <= 0) void send({ kind: "ha", domain: "light", service: "turn_off", data: { entity_id: id } });
    else void apply({ brightness_pct: v });
  };
  return (
    <Sheet onClose={onClose} label={friendly(e, id)}>
      <h2>{friendly(e, id)}</h2>
      <p className="num">{pct > 0 ? pct + "% brightness" : "Off"}</p>
      {supportsBrightness(e) && (
        <input
          className="bright-slider"
          type="range" min={0} max={100} step={1} value={pct}
          aria-label="Brightness"
          style={{ ["--fill" as any]: pct + "%" }}
          onChange={(ev) => setPct(Number(ev.target.value))}
          onPointerUp={(ev) => commit(Number((ev.target as HTMLInputElement).value))}
          onKeyUp={(ev) => commit(Number((ev.target as HTMLInputElement).value))}
        />
      )}
      {supportsColor(e) && (
        <div className="swatches">
          {SWATCHES.map(([name, rgb]) => (
            <button key={name} className="swatch" aria-label={name} style={{ background: `rgb(${rgb.join(",")})` }}
              onClick={() => void apply({ rgb_color: rgb })} />
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 20 }}>
        <button className="btn" onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}

function LightTile({ id, dense }: { id: string; dense: boolean }) {
  const e = useKey<HaEntityState>("ha:" + id);
  const send = useAction();
  const [optimistic, setOptimistic] = useState<{ on: boolean; at: number } | null>(null);
  const [sheet, setSheet] = useState(false);
  const domain = domainOf(id);
  const reallyOn = isOn(e);
  const on = optimistic && Date.now() - optimistic.at < 3000 && e && optimistic.on !== reallyOn ? optimistic.on : reallyOn;
  const na = unavailable(e);
  const rgb = lightRgb(e);
  const pct = brightnessPct(e);
  const toggle = async () => {
    if (na) return;
    setOptimistic({ on: !on, at: Date.now() });
    const svcDomain = domain === "light" ? "light" : domain === "switch" || domain === "input_boolean" || domain === "fan" ? domain : "homeassistant";
    const r = await send({ kind: "ha", domain: svcDomain, service: "toggle", data: { entity_id: id } });
    if (!r.ok) {
      setOptimistic(null);
      toast(friendly(e, id) + ": " + (r.error ?? "failed"), "error");
    }
  };
  const press = usePress(toggle, domain === "light" && !na ? () => setSheet(true) : undefined);
  const glow = rgb ? `rgb(${rgb.join(",")})` : "var(--glow)";
  const soft = rgb ? `rgba(${rgb.join(",")},0.2)` : "var(--glow-soft)";
  return (
    <>
      <button
        className={"light" + (on ? " on" : "") + (na ? " na" : "") + (dense ? " dense" : "")}
        style={on ? ({ ["--lc" as any]: glow, ["--lc-soft" as any]: soft } as any) : undefined}
        aria-pressed={on}
        {...press}
      >
        <span className="light-icon"><Icon name={domain === "light" ? "bulb" : domain === "fan" ? "fan" : "plug"} size={dense ? 24 : 30} /></span>
        <span className="light-name">{friendly(e, id)}</span>
        <span className="light-state num">{na ? (e ? "Unavailable" : "…") : on ? (pct != null ? pct + "%" : "On") : "Off"}</span>
      </button>
      {sheet && <LightSheet id={id} e={e} onClose={() => setSheet(false)} />}
    </>
  );
}

export default defineWidget({
  type: "lights",
  name: "Lights",
  configSchema: schema,
  keys: lightKeys,
  Component: ({ config }) => {
    const all = useKeysMatching(config.entities && config.entities.length ? null : ALL_LIGHTS);
    const ids = config.entities && config.entities.length ? config.entities : all.map((k) => k.slice(3));
    const [ref, { w, h }] = useSize<HTMLDivElement>();
    const { cols, rows, scroll } = fitGrid(Math.max(1, ids.length), w, h, 120, 64);
    const dense = scroll || h / rows < 110 || w / cols < 130;
    return (
      <div ref={ref} className={"lights" + (scroll ? " scroll" : "")} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gridTemplateRows: scroll ? `repeat(${rows}, 72px)` : `repeat(${rows}, minmax(0,1fr))` }}>
        {!ids.length && <div className="empty">Looking for lights…</div>}
        {ids.map((id) => <LightTile key={id} id={id} dense={dense} />)}
      </div>
    );
  },
});
