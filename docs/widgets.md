# Profiles and widgets

A **profile** is the layout for one kind of screen. Each paired screen is assigned a profile in `/admin` → Devices.
Several screens can share a profile. Profiles are YAML. Edit them in `/admin` → Profiles: the page validates them and
pushes changes to the screens right away.

## Profile format

```yaml
id: kitchen-ipad          # lowercase letters, digits, dashes
name: Kitchen iPad
grid: { cols: 6, rows: 8 } # 1–24 each; the screen is split into equal cells
theme: dark               # dark | light | auto (default dark)
lite: false               # true for slow screens (Fire HD 8): no animations, slower refresh, snapshots not video
idle:                     # optional
  after: 5m               # after this long without touches…
  show: clock             # …show this widget (by id) fullscreen
widgets:
  - id: clock             # optional, needed for idle.show
    type: clock
    at: [0, 0, 6, 2]      # [column, row, width, height] in cells, 0-based
    title: Kitchen        # optional heading
    format: 12h           # every other key is that widget's config (below)
```

Rules: `at` is `[col, row, w, h]`, with `col + w ≤ cols` and `row + h ≤ rows`. Widgets shouldn't overlap.
Any key that isn't `id`, `type`, `at` or `title` belongs to the widget's config and is checked against that widget's schema.
A widget with bad config shows an error card that names the field. The rest of the screen keeps working.

## Built-in widgets

### `clock`
| key | type | default | |
| --- | --- | --- | --- |
| `format` | `12h` \| `24h` | `12h` | (`format24: true` is accepted as an alias for `24h`) |
| `showDate` | boolean | `true` | weekday + date under the time |

### `pc-temps`
Temperatures from a PC agent, as gauges or a list, with a 10-minute sparkline of the hottest sensor.
| key | type | default | |
| --- | --- | --- | --- |
| `pc` | string | **required** | agent id, e.g. `gaming-pc` |
| `sensors` | string[] | all temperature sensors | sensor ids in display order, e.g. `[cpu_package, gpu_core, gpu_hotspot, nvme0_temp]` |
| `warnAt` | number | `80` | °C, turns amber |
| `critAt` | number | `90` | °C, turns red |
| `style` | `gauges` \| `list` | `gauges` | |

Sensor ids come from the agent. `/admin` → Computers lists them for each PC.

### `pc-drives`
Free space per drive. Tapping a drive can open it on the PC.
| key | type | default | |
| --- | --- | --- | --- |
| `pc` | string | **required** | agent id |
| `openActions` | map drive → action id | auto | e.g. `{"C:": open-drive-c, "D:": open-games}`. Without this map, an advertised `open` action named `open-<letter>` is used if there is one. |

### `buttons`
Either explicit buttons, or every action a PC advertises.
| key | type | | |
| --- | --- | --- | --- |
| `buttons` | list | | each: `label` (string), `icon` (icon name or emoji, optional), `action` (see below), `confirm` (boolean, asks first) |
| `pc` | string | | if `buttons` is empty: show all actions this PC agent offers (their own icons and guards apply) |

`action` is one of:
```yaml
action: { kind: ha, domain: light, service: toggle, data: { entity_id: light.kitchen } }  # any HA service
action: { kind: agent, pc: gaming-pc, action: launch-steam }                             # allowlisted PC action
action: { kind: wol, pc: gaming-pc }                                                     # Wake-on-LAN (PC registered with a MAC)
```
Built-in icon names: `power restart lock bulb lamp fan plug folder drive terminal globe keyboard play moon sun camera bell
thermo monitor steam gear sliders home house send image`. An emoji also works.

### `lights`
| key | type | |
| --- | --- | --- |
| `entities` | string[], optional | `light.*` (and switches). Omit to show **every** light in Home Assistant. Tap to toggle, long-press for brightness and colour. |

### `entity`
Generic card: shows the state and unit, toggles switch/input_boolean/light/fan on tap, and renders `weather.*` as a weather card.
| key | type | |
| --- | --- | --- |
| `entity` | string, **required** | any entity id |
| `label` | string | defaults to the entity's friendly name |

### `camera`
| key | type | default | |
| --- | --- | --- | --- |
| `entity` | string | **required** | `camera.*` |
| `refreshSec` | number | `10` | snapshot refresh. Tap for live view (not on `lite` profiles, which refresh at most every 10 s). |

### `media`
A GIF, image, video or slideshow. Set **either** `src` **or** `folder`.
| key | type | default | |
| --- | --- | --- | --- |
| `src` | string | | URL, or a path under the server's `media/` folder (e.g. `gifs/cat.gif`) |
| `folder` | string | | slideshow of every image/video in `media/<folder>` (`""` = the whole media folder) |
| `fit` | `cover` \| `contain` | `cover` | |
| `interval` | duration | `10s` | slideshow interval, e.g. `10s`, `2m` (`intervalSec: 10` also works) |

The media folder is `DATA_DIR/media` on the server. Supported files: gif, png, jpg, webp, svg, avif, mp4, webm, mov.

### `text`
| key | type | default |
| --- | --- | --- |
| `text` | string, **required** | |
| `size` | `s` \| `m` \| `l` | `m` |

## Example: desk monitor next to the gaming PC

```yaml
id: desk-monitor
name: Desk monitor
grid: { cols: 12, rows: 8 }
theme: dark
idle: { after: 10m, show: clock }
widgets:
  - { id: clock, type: clock, at: [0, 0, 4, 2], format: 24h }
  - id: temps
    type: pc-temps
    title: Gaming PC
    at: [4, 0, 5, 4]
    pc: gaming-pc
    sensors: [cpu_package, gpu_core, gpu_hotspot, nvme0_temp]
    warnAt: 80
    critAt: 90
  - id: drives
    type: pc-drives
    title: Drives
    at: [9, 0, 3, 4]
    pc: gaming-pc
    openActions: { "C:": open-drive-c, "D:": open-drive-d }
  - { id: lights, type: lights, title: Lights, at: [0, 2, 4, 3], entities: [light.office, light.living_room] }
  - { id: pc-buttons, type: buttons, title: PC, at: [4, 4, 5, 4], pc: gaming-pc }
  - id: shortcuts
    type: buttons
    title: Shortcuts
    at: [0, 5, 4, 3]
    buttons:
      - { label: Wake PC, icon: power, action: { kind: wol, pc: gaming-pc } }
      - label: Desk fan
        icon: fan
        action: { kind: ha, domain: switch, service: toggle, data: { entity_id: switch.desk_fan } }
  - { id: gif, type: media, at: [9, 4, 3, 4], src: gifs/cat.gif, fit: cover }
```

The server ships example profiles `desk-monitor`, `kitchen-ipad` and `fire-hd8`. Copy one and edit it.

---

## Writing a new widget

A widget is **one file** in `apps/kiosk/src/widgets/` plus **one line** to register it. The kiosk is React + TypeScript.

### 1. The file

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

### 2. Register it

In `apps/kiosk/src/widgets/index.ts`, import it and add `.register(countdown)` to the registry.

### 3. Use it

```yaml
- { type: countdown, at: [0, 0, 4, 2], label: Christmas, until: "2026-12-25" }
```

### The parts of `defineWidget`

| field | what |
| --- | --- |
| `type` | unique id used in profiles |
| `name` | human name |
| `configSchema` | a zod schema for every placement key except `id`, `type`, `at` and `title`. Use `.default()` for optional values. Invalid config shows an error card that names the field. |
| `keys(config)` | data keys this widget needs. The screen subscribes to the union of all widgets' keys. |
| `Component` | React component. Receives `config` (already parsed by your schema), `placement`, and `fullscreen` (true on the idle screen). |
| `bleed` | optional `true` to draw edge-to-edge without card padding (cameras, images) |

### Data keys

| key | value |
| --- | --- |
| `ha:<entity_id>` | Home Assistant entity state (`HaEntityState`) |
| `agent:<pcId>:sensors` | all sensors of a PC (`AgentSensorsPayload`) |
| `agent:<pcId>:drives` | drives (`AgentDrivesPayload`) |
| `agent:<pcId>:actions` | actions the PC offers (`AgentActionsPayload`) |
| `agent:<pcId>:status` | `"online"` / `"offline"` |
| `agents` | all known PCs (`AgentSummary[]`) |

The types are in `packages/protocol/src/index.ts`.

### Hooks (from `../sdk`)

- `useKey<T>(key)` returns the latest value for a key and re-renders only when that key changes. Pass `null` to skip.
- `useAction()` returns `send(action, confirmed?)`, which runs an `ActionRequest` (HA service, PC action, Wake-on-LAN). It resolves
  to `{ ok, error? }`.
- `useLite()` returns true on lite profiles. Skip animations and refresh less often when it is true.
- `useEnv()` returns `{ connection, token, lite, device }` for advanced use (e.g. `device.remote`).

`apps/kiosk/src/components.tsx` has shared helpers the built-in widgets use (sizing, sparkline, the confirm sheet).
Read the existing widgets for examples: `text.tsx` is the smallest, and `pc-temps.tsx` is a full one.

### Tips

- Screens can be anything from a 4K monitor to a Fire HD 8. Size text from the widget's measured box, not
  fixed pixels (see `useSize` in `components.tsx`).
- Never put secrets in widget config. Screens only see data the server sends them, and the HA token stays on the server.
- Rebuild the kiosk (`pnpm --filter @homepanel/kiosk build`) and restart the server. With the HA app, rebuild the app image.
