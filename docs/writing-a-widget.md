# Writing your own widget

A widget is **one file** in `apps/kiosk/src/widgets/` plus **one line** to register it. The kiosk is React + TypeScript.

## 1. The file

`apps/kiosk/src/widgets/countdown.tsx`:

```tsx
import { z } from "zod";
import { defineWidget, useKey } from "../sdk";
import type { HaEntityState } from "@homepanel/protocol";

const schema = z.object({
  label: z.string(),
  until: z.string(),                 // ISO date, e.g. "2026-12-25"
  entity: z.string().optional(),     // optional HA entity to show underneath
});

export default defineWidget({
  type: "countdown",                 // the `type:` used in profile YAML
  name: "Countdown",                 // shown in the admin UI
  configSchema: schema,              // validates the widget's keys in the profile
  keys: (c) => (c.entity ? ["ha:" + c.entity] : []), // data the widget needs (see below)
  Component: ({ config }) => {
    const e = useKey<HaEntityState>(config.entity ? "ha:" + config.entity : null);
    const days = Math.ceil((new Date(config.until).getTime() - Date.now()) / 86_400_000);
    return (
      <div className="text-widget size-l">
        {days} days until {config.label}
        {e && <div className="entity-label">{e.state}</div>}
      </div>
    );
  },
});
```

## 2. Register it

In `apps/kiosk/src/widgets/index.ts`, import it and add `.register(countdown)` to the registry.

## 3. Use it

```yaml
- { type: countdown, at: [0, 0, 4, 2], label: Christmas, until: "2026-12-25" }
```

## The parts of `defineWidget`

| field | what |
| --- | --- |
| `type` | unique id used in profiles |
| `name` | human name |
| `configSchema` | a zod schema for every placement key except `id`, `type`, `at` and `title`. Use `.default()` for optional values. Invalid config shows an error card that names the field. |
| `keys(config)` | data keys this widget needs. The screen subscribes to the union of all widgets' keys. |
| `Component` | React component. Receives `config` (already parsed by your schema), `placement`, and `fullscreen` (true on the idle screen). |
| `bleed` | optional `true` to draw edge-to-edge without card padding (cameras, images) |

## Data keys

| key | value |
| --- | --- |
| `ha:<entity_id>` | Home Assistant entity state (`HaEntityState`) |
| `agent:<pcId>:sensors` | all sensors of a PC (`AgentSensorsPayload`) |
| `agent:<pcId>:drives` | drives (`AgentDrivesPayload`) |
| `agent:<pcId>:actions` | actions the PC offers (`AgentActionsPayload`) |
| `agent:<pcId>:status` | `"online"` / `"offline"` |
| `agents` | all known PCs (`AgentSummary[]`) |

The types are in `packages/protocol/src/index.ts`.

## Hooks (from `../sdk`)

- `useKey<T>(key)` returns the latest value for a key and re-renders only when that key changes. Pass `null` to skip.
- `useAction()` returns `send(action, confirmed?)`, which runs an `ActionRequest` (HA service, PC action, Wake-on-LAN). It resolves
  to `{ ok, error? }`.
- `useLite()` returns true on lite profiles. Skip animations and refresh less often when it is true.
- `useEnv()` returns `{ connection, token, lite, device }` for advanced use (e.g. `device.remote`).

`apps/kiosk/src/components.tsx` has shared helpers the built-in widgets use (sizing, sparkline, the confirm sheet).
Read the existing widgets for examples: `text.tsx` is the smallest, and `pc-temps.tsx` is a full one.

## Tips

- Screens can be anything from a 4K monitor to a Fire HD 8. Size text from the widget's measured box, not
  fixed pixels (see `useSize` in `components.tsx`).
- Never put secrets in widget config. Screens only see data the server sends them, and the HA token stays on the server.
- Rebuild the kiosk (`pnpm --filter @homepanel/kiosk build`) and restart the server. With the HA app, rebuild the app image.
