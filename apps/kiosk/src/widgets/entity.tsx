import { z } from "zod";
import type { HaEntityState } from "@homepanel/protocol";
import { defineWidget, useAction, useKey } from "../sdk";
import { useSize } from "../components";
import { toast } from "../lib/toast";
import { Icon } from "../icons";
import { domainOf, friendly, isOn, unavailable } from "./ha-util";

const schema = z.object({ entity: z.string(), label: z.string().optional() });
const TOGGLE = ["switch", "input_boolean", "light", "fan"];

const WEATHER: Record<string, [string, string]> = {
  "clear-night": ["moon", "Clear"], cloudy: ["cloud", "Cloudy"], fog: ["fog", "Fog"], hail: ["rain", "Hail"],
  lightning: ["storm", "Lightning"], "lightning-rainy": ["storm", "Thunderstorms"], partlycloudy: ["cloud", "Partly cloudy"],
  pouring: ["rain", "Pouring"], rainy: ["rain", "Rain"], snowy: ["snow", "Snow"], "snowy-rainy": ["snow", "Sleet"],
  sunny: ["sun", "Sunny"], windy: ["fog", "Windy"], "windy-variant": ["fog", "Windy"], exceptional: ["alert", "Exceptional"],
};

function Weather({ e, label }: { e: HaEntityState; label: string }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [icon, cond] = WEATHER[e.state] ?? ["cloud", e.state];
  const a = e.attributes;
  const unit = (a.temperature_unit as string) ?? "°";
  const temp = typeof a.temperature === "number" ? Math.round(a.temperature as number) : null;
  const big = Math.max(36, Math.min(h * 0.42, w * 0.3));
  const fc = (a.forecast as { datetime: string; temperature: number; templow?: number; condition: string }[] | undefined) ?? [];
  return (
    <div ref={ref} className="weather">
      <div className="weather-top">
        <Icon name={icon} size={Math.round(big * 0.8)} stroke={1.6} style={{ color: "var(--ink-2)", flex: "none" }} />
        <div className="weather-temp num" style={{ fontSize: big }}>{temp ?? "–"}<span className="unit">{unit.replace("C", "").replace("F", "")}</span></div>
      </div>
      <div className="weather-cond">{cond}</div>
      <div className="weather-meta">
        {typeof a.humidity === "number" && <span className="num">{Math.round(a.humidity as number)}% humidity</span>}
        <span>{label}</span>
      </div>
      {h > 260 && fc.length > 0 && (
        <div className="forecast">
          {fc.slice(0, Math.max(1, Math.floor(w / 80))).map((f) => (
            <div key={f.datetime} className="fc">
              <span>{new Date(f.datetime).toLocaleDateString(undefined, { weekday: "short" })}</span>
              <Icon name={(WEATHER[f.condition] ?? ["cloud"])[0]} size={22} />
              <span className="num">{Math.round(f.temperature)}°</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default defineWidget({
  type: "entity",
  name: "Entity",
  configSchema: schema,
  keys: (c) => ["ha:" + c.entity],
  Component: ({ config }) => {
    const e = useKey<HaEntityState>("ha:" + config.entity);
    const send = useAction();
    const [ref, { w, h }] = useSize<HTMLDivElement>();
    const domain = domainOf(config.entity);
    const label = config.label ?? friendly(e, config.entity);
    if (e && domain === "weather") return <Weather e={e} label={label} />;
    const canToggle = TOGGLE.indexOf(domain) >= 0 && !unavailable(e);
    const unit = (e?.attributes?.unit_of_measurement as string | undefined) ?? "";
    const num = e ? Number(e.state) : NaN;
    const value = !e ? "…" : unavailable(e) ? "Unavailable" : isFinite(num) && e.state.trim() !== "" ? String(Math.round(num * 10) / 10) : e.state.replace(/_/g, " ");
    const big = Math.max(26, Math.min(h * 0.4, (w / Math.max(3, value.length + unit.length * 0.5)) * 1.5));
    const toggle = async () => {
      const r = await send({ kind: "ha", domain: domain === "light" ? "light" : domain, service: "toggle", data: { entity_id: config.entity } });
      if (!r.ok) toast(label + ": " + (r.error ?? "failed"), "error");
    };
    const on = isOn(e);
    const body = (
      <>
        <div className="entity-label">{label}</div>
        <div className={"entity-value num" + (canToggle && on ? " on" : "")} style={{ fontSize: canToggle ? Math.min(big, 44) : big }}>
          {canToggle ? (on ? "On" : "Off") : value}
          {!canToggle && unit && isFinite(num) && <span className="unit">{unit}</span>}
        </div>
        {canToggle && <span className={"switch" + (on ? " on" : "")} aria-hidden><span /></span>}
      </>
    );
    return canToggle ? (
      <button ref={ref as any} className="entity tappable" aria-pressed={on} onClick={toggle}>{body}</button>
    ) : (
      <div ref={ref} className="entity">{body}</div>
    );
  },
});
