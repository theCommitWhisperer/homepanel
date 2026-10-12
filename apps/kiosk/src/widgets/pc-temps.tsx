import { useEffect, useRef } from "react";
import { z } from "zod";
import type { AgentSensor, AgentSensorsPayload, AgentSummary } from "@homepanel/protocol";
import { defineWidget, useKey, useLite } from "../sdk";
import { Sparkline, useNow, useRunAction, useSize } from "../components";
import { History } from "../lib/store";
import { Icon } from "../icons";
import { level, levelColor } from "./temps-util";

export const schema = z.object({
  pc: z.string(),
  sensors: z.array(z.string()).optional(),
  warnAt: z.number().default(80),
  critAt: z.number().default(90),
  style: z.enum(["gauges", "list"]).default("gauges"),
});

// history survives profile reloads/re-mounts
const histories = new Map<string, History>();
// order fixed the first time a PC's sensor set is seen (hottest first) so gauges don't reshuffle every update
const orders = new Map<string, string[]>();

/** Temperature sensors to show: the configured ids in that order, else every temperature sensor, hottest first. */
export function pickTemps(sensors: AgentSensor[], wanted: string[] | undefined, memoKey?: string): AgentSensor[] {
  if (wanted && wanted.length) {
    return sensors.filter((s) => wanted.indexOf(s.id) >= 0).sort((a, b) => wanted.indexOf(a.id) - wanted.indexOf(b.id));
  }
  const temps = sensors.filter((s) => s.kind === "temperature");
  const sig = temps.map((s) => s.id).sort().join(",");
  let order = memoKey ? orders.get(memoKey + "|" + sig) : undefined;
  if (!order) {
    order = temps.slice().sort((a, b) => b.value - a.value).map((s) => s.id);
    if (memoKey) orders.set(memoKey + "|" + sig, order);
  }
  return temps.sort((a, b) => order!.indexOf(a.id) - order!.indexOf(b.id));
}

function Gauge({ s, warnAt, critAt, size }: { s: AgentSensor; warnAt: number; critAt: number; size: number }) {
  const max = Math.max(100, critAt + 10);
  const frac = Math.max(0, Math.min(1, s.value / max));
  const r = 40, c = 2 * Math.PI * r, arc = 0.75;
  const col = levelColor[level(s.value, warnAt, critAt)];
  return (
    <div className="gauge" style={{ width: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <circle cx={50} cy={50} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={9}
          strokeDasharray={`${c * arc} ${c}`} transform="rotate(135 50 50)" strokeLinecap="round" />
        <circle cx={50} cy={50} r={r} fill="none" stroke={col} strokeWidth={9}
          strokeDasharray={`${c * arc * frac} ${c}`} transform="rotate(135 50 50)" strokeLinecap="round" />
        <text x={50} y={56} textAnchor="middle" fontSize={24} fontWeight={500} fill="var(--ink)" className="num">{Math.round(s.value)}°</text>
      </svg>
      <div className="gauge-label">{s.name}</div>
    </div>
  );
}

function PcTemps({ config, title }: { config: z.infer<typeof schema>; title?: string }) {
  const data = useKey<AgentSensorsPayload>(`agent:${config.pc}:sensors`);
  const status = useKey<string>(`agent:${config.pc}:status`);
  const agents = useKey<AgentSummary[]>("agents");
  const lite = useLite();
  const now = useNow(lite ? 10_000 : 2_000);
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [sparkRef, spark] = useSize<HTMLDivElement>();
  const { run, state, sheet } = useRunAction();

  let hist = histories.get(config.pc);
  if (!hist) histories.set(config.pc, (hist = new History(10 * 60_000)));

  const temps = pickTemps((data?.sensors ?? []).slice(), config.sensors, config.pc);
  const hottest = temps.reduce<AgentSensor | null>((m, s) => (!m || s.value > m.value ? s : m), null);

  const lastTs = useRef(0);
  useEffect(() => {
    if (!data || !hottest || data.ts === lastTs.current) return;
    lastTs.current = data.ts;
    hist!.push("hot", hottest.value, Date.now(), lite ? 10_000 : 0);
  }, [data, hottest, lite, hist]);

  const summary = agents?.find((a) => a.pcId === config.pc);
  const name = title ?? summary?.name ?? data?.hostname ?? config.pc;
  const offline = status === "offline" || (status == null && summary?.status !== "online" && !data);
  const others = temps.filter((s) => s !== hottest);

  const lv = hottest ? level(hottest.value, config.warnAt, config.critAt) : "ok";
  const compact = h < 230 || w < 300;
  const bigSize = Math.max(44, Math.min(h * (compact ? 0.42 : 0.3), w * 0.26));

  // layout: gauges row sizing
  const gaugeArea = Math.max(0, Math.min(h * 0.42, h - bigSize * 1.45 - 46));
  const gaugeCount = Math.max(1, others.length);
  const gaugeSize = Math.max(64, Math.min(150, gaugeArea * 0.78, (w - 36) / Math.min(gaugeCount, Math.max(1, Math.floor((w - 36) / 90))) - 14));
  const perRow = Math.max(1, Math.floor((w - 36 + 14) / (gaugeSize + 14)));
  const shownOthers = config.style === "gauges" ? others.slice(0, perRow * Math.max(1, Math.floor((gaugeArea + 10) / (gaugeSize + 30)))) : others;
  void now;

  return (
    <div ref={ref} className={"pctemps" + (offline ? " is-offline" : "")}>
      <div className="pc-head">
        <span className={"dot" + (offline ? "" : " on")} />
        <span className="pc-name">{name}</span>
        <span className="pc-state">{offline ? "offline" : "online"}</span>
      </div>
      {offline ? (
        <div className="pc-offline">
          <Icon name="moon" size={Math.min(64, Math.max(32, h * 0.16))} />
          <div className="pc-offline-title">PC offline</div>
          {summary?.hasMac ? (
            <button className="btn primary" disabled={state === "pending"} onClick={() => run({ kind: "wol", pc: config.pc }, "Wake " + name)}>
              {state === "pending" ? <span className="spinner" /> : <Icon name="power" size={20} />} Wake
            </button>
          ) : (
            <div className="muted">Temperatures appear when it wakes up.</div>
          )}
        </div>
      ) : !hottest ? (
        <div className="empty">Waiting for sensors…</div>
      ) : (
        <>
          <div className={"hot" + (compact ? " compact" : "")}>
            <div className="hot-main">
              <div className={"hot-value num lv-" + lv} style={{ fontSize: bigSize }}>
                {Math.round(hottest.value)}<span className="hot-unit">°</span>
              </div>
              <div className="hot-label">
                <span>{hottest.name}</span>
                {lv !== "ok" && <span className={"badge lv-" + lv}>{lv === "crit" ? "Too hot" : "Warm"}</span>}
              </div>
            </div>
            {!compact && !lite && (
              <div className="hot-spark" ref={sparkRef}>
                <Sparkline points={hist.get("hot")} w={spark.w} h={Math.max(0, spark.h - 26)} color={levelColor[lv]} />
                <div className="spark-cap">last 10 min</div>
              </div>
            )}
          </div>
          {shownOthers.length > 0 && config.style === "gauges" && !compact && (
            <div className="gauges">
              {shownOthers.map((s) => <Gauge key={s.id} s={s} warnAt={config.warnAt} critAt={config.critAt} size={gaugeSize} />)}
            </div>
          )}
          {others.length > 0 && (config.style === "list" || compact) && (
            <ul className="temp-list">
              {others.map((s) => {
                const l = level(s.value, config.warnAt, config.critAt);
                return (
                  <li key={s.id}>
                    <span className="tl-name">{s.name}</span>
                    <span className="tl-bar"><span style={{ width: Math.min(100, s.value) + "%", background: levelColor[l] }} /></span>
                    <span className={"tl-val num lv-" + l}>{Math.round(s.value)}°</span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {sheet}
    </div>
  );
}

export default defineWidget({
  type: "pc-temps",
  name: "PC temperatures",
  configSchema: schema,
  keys: (c) => [`agent:${c.pc}:sensors`, `agent:${c.pc}:status`, "agents"],
  ownsTitle: true,
  Component: ({ config, placement }) => <PcTemps config={config} title={placement.title} />,
});
