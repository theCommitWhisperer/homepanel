# HomePanel quickstart

This guide follows one complete setup from start to finish:

- an **ACEMAGICIAN T8 Plus** mini PC (Intel N100) running Home Assistant OS
- a **Home Assistant Connect ZBT-1** for Zigbee
- the **Mosquitto** MQTT broker and the **HomePanel** app
- a **Windows gaming PC** that shows its temperatures and drives on a screen
- an **iPad** and a **Fire HD 8** as wall screens
- a **Reolink** and/or **Eufy** doorbell
- **Tailscale** for remote access

If your hardware is different, start with the matching guide in [hardware/](hardware/). After that, the steps are the same.

> **Short on time?** Run `homepanel setup` from a HomePanel checkout on any computer on the same network
> (`pnpm install && pnpm --filter @homepanel/installer build && node apps/installer/dist/cli.js setup`).
> It walks you through every step below, automates most of them, and saves your progress so you can stop and pick up later.
> If you want, a free AI guide can explain each step as you go (see [ai-assistant.md](ai-assistant.md)).

---

## 1. Install Home Assistant OS on the T8 Plus (~45 min)

The T8 Plus comes with Windows 11. This step **erases Windows**, so back up anything you want to keep first.

Full guide with screenshots-level detail: [hardware/t8-plus-and-x86.md](hardware/t8-plus-and-x86.md). Short version:

1. On another computer, make a **Ubuntu Desktop live USB** with balenaEtcher or Rufus.
2. Connect a keyboard and monitor to the T8 Plus. Power it on and tap **Del** to open the BIOS:
   - Boot mode: **UEFI**
   - **Secure Boot: Disabled**
   - **Restore on AC Power Loss: Power On**, so it starts again by itself after a power cut
3. Boot from the USB stick (tap **F7** for the boot menu) and choose **Try Ubuntu**.
4. Download `haos_generic-x86-64-18.3.img.xz` from the
   [Home Assistant OS releases](https://github.com/home-assistant/operating-system/releases) page.
   Use the **Disks** app to write it to the **internal SSD**: select the SSD → ⋮ → *Restore Disk Image*.
   Or use the terminal script in the hardware guide, which checks that you picked the right disk.
5. Shut down, unplug the USB stick, plug in Ethernet, and power on. The first boot takes 5–20 minutes.
6. In your router, set a **DHCP reservation** for the T8 Plus so its IP address never changes.

## 2. Onboarding (~5 min)

Open `http://homeassistant.local:8123`. If that address doesn't load, use `http://<ip>:8123`.
Create your owner account and set your location, time zone and units.
`homepanel setup` can do all of this for you. It asks for the same details in the terminal (your password is hidden as you type) and then
creates a **long-lived access token** called "HomePanel".

## 3. Zigbee with the ZBT-1 (~5 min)

1. Plug the ZBT-1 into the T8 Plus **with a USB extension cable**, about 0.5–1 m long. Use a USB 2 port if there is one.
   USB 3 ports and the PC itself give off radio noise that interferes with Zigbee.
2. Go to HA → **Settings → Devices & services**. The ZBT-1 shows up as *Discovered*. Click **Add**, choose **Zigbee**, then **Submit**.
3. To pair devices, open **Zigbee Home Automation → Add device**.

More: [zigbee-zbt1.md](zigbee-zbt1.md)

## 4. Mosquitto MQTT broker (~3 min)

PC agents send their data to HomePanel over MQTT.

- With `homepanel setup`, the `mqtt` step installs the **Mosquitto broker** app and
  creates a local-only HA user `homepanel-mqtt` that the broker uses for logins. It also adds the MQTT integration.
- To do it by hand: HA → **Settings → Apps** (called *Add-ons* in older versions) → **App store** → *Mosquitto broker* →
  **Install** → turn on *Start on boot* → **Start**. Then go to **Settings → People**, add a user `homepanel-mqtt`, and
  accept the discovered **MQTT** integration in *Devices & services*.

## 5. The HomePanel app (~10 min, mostly building)

1. HA → **Settings → Apps → App store → ⋮ → Repositories**. Add the HomePanel app repository URL
   (the contents of [`deploy/ha-app`](../deploy/ha-app), published as its own git repository).
2. Find **HomePanel** in the store, click **Install**, and wait. The first install builds from source and takes a few minutes on the N100.
3. On the **Configuration** tab, set `admin_password`. Optionally fill in the AI fields too.
4. On the **Info** tab, turn on *Start on boot* and *Watchdog*, then click **Start**.
5. Open `http://<ha-ip>:8080/admin` and log in.

You don't need to enter a Home Assistant token or MQTT login. The app gets both from the Supervisor.

## 6. Gaming PC agent (~10 min)

1. On the gaming PC, install **LibreHardwareMonitor**. Run it as administrator, then enable
   *Options → Remote Web Server → Run* (port 8085) and *Run on Windows startup*.
2. In HomePanel admin → **Computers → Add**, enter the id `gaming-pc` and the name "Gaming PC". Adding the MAC address enables
   Wake-on-LAN. You get a **key**. If you use `homepanel setup`, the `pcs` step does this for you and writes a complete
   `agent-gaming-pc.yaml` to `~/.homepanel/`.
3. Copy the yaml to `C:\ProgramData\HomePanel\agent.yaml` on the PC. Then install the agent with the script in
   `apps/agent` (see the agent's README for the exact command).
4. Within a few seconds the PC shows as *online* in admin, and its temperatures appear on the `desk-monitor` profile.

## 7. Screens

**iPad** ([screens/ipad.md](screens/ipad.md))
1. In Safari, open `http://<ha-ip>:8080`, then tap **Share → Add to Home Screen**.
2. A 6-digit code appears. In admin → **Devices**, approve it and choose the `kitchen-ipad` profile.
3. Turn on **Guided Access** to lock the iPad to HomePanel, and set Auto-Lock to *Never*.

**Fire HD 8, 10th gen** ([screens/fire-hd8.md](screens/fire-hd8.md))
1. Remove the lock-screen ads. Either pay the one-time fee in your Amazon account, or use Amazon Fire Toolbox (unofficial).
2. Install **Fully Kiosk Browser** and set its *Start URL* to `http://<ha-ip>:8080`.
3. Approve the code and choose the `fire-hd8` profile. It is a *lite* profile: no animations, and camera snapshots instead of live video.
   The Fire HD 8 is slow, and this profile keeps it responsive.

## 8. Doorbells ([doorbells.md](doorbells.md))

- **Reolink**: give the doorbell a fixed IP. Then add HA's **Reolink** integration with that IP and the doorbell's admin login
  (`homepanel setup --step doorbells` can do this). In HomePanel admin → **Doorbells**, choose the
  `binary_sensor.<name>_visitor` entity as the ring trigger and the doorbell camera as the camera.
- **Eufy**: there is no official integration. The community *eufy-security-ws* app plus the *Eufy Security* integration from HACS
  work with many models. Treat this as best effort.

When someone rings, every screen shows a full-screen camera view for 60 seconds.

## 9. Remote access with Tailscale ([remote-access.md](remote-access.md))

1. HA → **Settings → Apps → App store** → **Tailscale** (from the Home Assistant Community Apps repository) → **Install** → **Start**.
2. Open its web UI and log in. Then install Tailscale on your phone and log in with the same account.
3. From anywhere, use `http://homeassistant:8123` for HA and `http://homeassistant:8080` for HomePanel.

You don't need to open any ports on your router.

## 10. Check everything

```bash
homepanel doctor
```

This checks that HA is reachable, the token works, MQTT is up, the HomePanel server is running and PC agents are online.
Each failure comes with a suggested fix.

## Next

- Change layouts: [widgets.md](widgets.md)
- Build your own widget: [writing-a-widget.md](writing-a-widget.md)
- Monitoring the mini PC itself: HA OS is an appliance, so the HomePanel agent can't be installed on it. Instead, add HA's
  **System Monitor** integration (CPU load, memory, disk) and show those sensors with `entity` widgets. If you later run
  HA in Docker or a VM on a Linux host, the agent can run on that host (it reads Linux `hwmon` sensors).
