# Doorbells

When a doorbell rings, HomePanel takes over the screens with a full-screen camera view for `on_ring.close_after`
(default 60 s). Any screen can show it, or only the profiles listed in `on_ring.show_on`.

HomePanel needs two Home Assistant entities per doorbell:
- a **ring** entity: a `binary_sensor` that turns `on` when someone presses the button, or an `event.*` entity
  (any new event counts as a ring)
- a **camera** entity, for snapshots and live view

Add them in `/admin` → Doorbells, or in the server config:

```yaml
doorbells:
  front:
    provider: reolink
    name: Front door
    ring: binary_sensor.front_door_visitor
    camera: camera.front_door_fluent
on_ring:
  show_on: []          # empty = all screens
  wake_screens: true   # Fully Kiosk tablets with remote admin
  close_after: 60s
```

## Reolink (recommended: official integration, local, no cloud)

1. In the Reolink app, give the doorbell an admin password and turn on **HTTP/HTTPS**, **RTSP** and **ONVIF**
   (*Settings → Network → Advanced → Server Settings*). Newer firmware may have some of these off by default.
2. In your router, give the doorbell a fixed IP.
3. HA → Settings → Devices & services → **Add integration → Reolink**. Enter the IP, username and password.
   Or run `homepanel setup --step doorbells`, which starts this same integration for you. The password is typed in the terminal
   and never shown to the AI guide.
4. Entities to use:
   - ring: `binary_sensor.<name>_visitor`
   - camera: `camera.<name>_fluent` (low-res stream, good for tablets) or `camera.<name>_clear` (high-res)

   Entity names depend on the name you gave the device. Look them up under the device page in HA.

Reolink pushes the ring to HA almost instantly (ONVIF/Baichuan push), so the screens react in about a second.

## Eufy (unofficial, best effort)

Eufy has **no official Home Assistant integration**. The community projects below work with many doorbells
(T8210, T8222, E340, …), but they depend on Eufy's private cloud API, which can break after Eufy updates. Battery doorbells
also give limited live video.

1. In the Eufy app, create a **second Eufy account** just for Home Assistant and share the doorbell with it as an admin.
   The integration keeps that account logged in, which would otherwise log you out of your phone.
2. Install the **eufy-security-ws** app: HA → Settings → Apps → App store → ⋮ → Repositories → add
   `https://github.com/bropat/hassio-eufy-security-ws` → install *Eufy Security Add-on*. In its configuration, enter the second
   account's email, password and country, then start it.
3. Install **HACS** (see hacs.xyz). Then in HACS, search for **Eufy Security** (by fuatakgun) → Download → restart HA.
4. Settings → Devices & services → Add integration → **Eufy Security**. Use the host and port shown in the app's
   documentation (port 3000).
5. Entities to use: the doorbell's **ringing** binary sensor (or event entity) as `ring`, and its camera.

Set `provider: eufy` for the doorbell in HomePanel. If live video doesn't work, the takeover still shows snapshots.

## Generic (any camera + any button)

Anything that gives Home Assistant **a camera entity** and **something that changes when the bell rings** works:
another brand's integration, a Zigbee button next to the door, an ONVIF camera with a motion sensor, a
`input_boolean` an automation flips, and so on.

```yaml
doorbells:
  side-gate:
    provider: generic
    name: Side gate
    ring: binary_sensor.gate_button_action        # or event.gate_button, or input_boolean.gate_rang
    camera: camera.side_gate                       # generic camera / ONVIF / RTSP-to-camera in HA
    snapshot: image.side_gate_snapshot             # optional image.* entity
```

Tip: for a camera that only has RTSP, add HA's **Generic Camera** integration with the RTSP URL. For a ring that
HA only sees as an *event* entity, use the `event.*` entity directly; each new event is a ring.

## Testing

Press the doorbell button. Or, in HA → Developer tools → States, set the ring binary sensor to `on` for a moment.
Every screen should show the camera within a second or two.
