import { z } from "zod";
import { defineWidget } from "../sdk";
import { useNow, useSize } from "../components";

export default defineWidget({
  type: "clock",
  name: "Clock",
  configSchema: z.object({ format24: z.boolean().optional(), showDate: z.boolean().optional() }),
  keys: () => [],
  Component: ({ config }) => {
    const now = new Date(useNow(1000));
    const [ref, { w, h }] = useSize<HTMLDivElement>();
    const h24 = config.format24 ?? false;
    let hh = now.getHours();
    const ampm = hh >= 12 ? "PM" : "AM";
    if (!h24) hh = hh % 12 || 12;
    const hs = h24 ? String(hh).padStart(2, "0") : String(hh);
    const mm = String(now.getMinutes()).padStart(2, "0");
    const showDate = config.showDate ?? true;
    const chars = hs.length + 3 + (h24 ? 0 : 1.2);
    const size = Math.max(24, Math.min(h * (showDate ? 0.62 : 0.8), (w / chars) * 1.6));
    const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    return (
      <div ref={ref} className="clock">
        <div className="clock-time num" style={{ fontSize: size }}>
          <span>{hs}</span>
          <span className="clock-colon">:</span>
          <span>{mm}</span>
          {!h24 && <span className="clock-ampm" style={{ fontSize: Math.max(14, size * 0.2) }}>{ampm}</span>}
        </div>
        {showDate && (
          <div className="clock-date" style={{ fontSize: Math.max(15, Math.min(size * 0.17, w / 16)) }}>{date}</div>
        )}
      </div>
    );
  },
});
