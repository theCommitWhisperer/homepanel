import { z } from "zod";
import { defineWidget } from "../sdk";

export default defineWidget({
  type: "text",
  name: "Text",
  configSchema: z.object({ text: z.string(), size: z.enum(["s", "m", "l"]).optional() }),
  keys: () => [],
  Component: ({ config }) => <div className={"text-widget size-" + (config.size ?? "m")}>{config.text}</div>,
});
