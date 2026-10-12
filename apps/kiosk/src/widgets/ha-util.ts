import type { HaEntityState } from "@homepanel/protocol";

export const domainOf = (id: string) => id.split(".")[0] ?? "";
export const friendly = (e: HaEntityState | undefined, id: string) =>
  (e?.attributes?.friendly_name as string | undefined) ?? id.split(".").slice(1).join(".").replace(/_/g, " ");
export const isOn = (e?: HaEntityState) => !!e && (e.state === "on" || e.state === "open" || e.state === "playing" || e.state === "home");
export const unavailable = (e?: HaEntityState) => !e || e.state === "unavailable" || e.state === "unknown";

/** rgb tuple for an "on" light, if HA reports one */
export function lightRgb(e?: HaEntityState): [number, number, number] | null {
  const rgb = e?.attributes?.rgb_color;
  if (Array.isArray(rgb) && rgb.length === 3) return rgb as [number, number, number];
  return null;
}
export function supportsColor(e?: HaEntityState) {
  const modes = (e?.attributes?.supported_color_modes as string[] | undefined) ?? [];
  return modes.some((m) => m === "rgb" || m === "hs" || m === "xy" || m === "rgbw" || m === "rgbww");
}
export function supportsBrightness(e?: HaEntityState) {
  const modes = (e?.attributes?.supported_color_modes as string[] | undefined) ?? [];
  if (!modes.length) return e?.attributes?.brightness != null;
  return modes.some((m) => m !== "onoff");
}
export function brightnessPct(e?: HaEntityState): number | null {
  const b = e?.attributes?.brightness;
  return typeof b === "number" ? Math.round((b / 255) * 100) : null;
}
