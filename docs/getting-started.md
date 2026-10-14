# Getting started

**Goal for tonight:** your Windows gaming PC runs HomePanel itself — real CPU/GPU temperatures, real PC buttons,
a dashboard in your browser and on tablets. **Later:** the server moves to the mini PC (ACEMAGICIAN T8 Plus running
Proxmox, with Home Assistant OS in a VM), and the gaming PC just reports to it.

You need **one file**, `HomePanel-Setup.exe`. No Node.js, git or pnpm. The setup program installs what it needs with
**winget** (LibreHardwareMonitor, the PawnIO driver, Mosquitto), shows every action before it runs it, and remembers
its progress, so you can stop and run it again any time — finished steps are skipped.

---

## 1. Download and start (~2 min)

1. Open **<https://github.com/theCommitWhisperer/homepanel/releases>** and download **`HomePanel-Setup.exe`** from the
   newest release (under *Assets*).
2. Double-click it. Windows SmartScreen says **"Windows protected your PC"** because the file isn't code-signed:
   click **More info → Run anyway**.
3. Windows asks *"Do you want to allow this app to make changes to your device?"* → **Yes**. Setup needs administrator
   rights to install programs, scheduled tasks and firewall rules. It continues in a new window.
4. The start menu:

   | Choice | When |
   | --- | --- |
   | **1. Host HomePanel on this PC** | Tonight, on the gaming PC. Everything runs here. |
   | **2. Join this PC to my HomePanel** | Another PC already runs HomePanel; add this one's temps and buttons. |
   | **3. Set up Home Assistant / mini PC** | Home Assistant OS on the T8 Plus (Proxmox VM or bare metal), Zigbee, doorbells. |
   | **4. Move the server to Home Assistant** | After step 3, on the PC that hosted HomePanel: hands everything to the HomePanel app on HA. |

## 2. Host HomePanel on this PC (~10 min, mostly waiting for downloads)

Pick **1**. Setup lists the steps, then asks once: *show me each step and ask* (recommended the first time) or *do all
of them*. Each step is checked first and skipped when it's already done.

| Step | What it does |
| --- | --- |
| Install HomePanel.exe | Copies itself to `C:\Program Files\HomePanel\HomePanel.exe` (the scheduled tasks run that copy). |
| LibreHardwareMonitor | `winget install --id LibreHardwareMonitor.LibreHardwareMonitor -e …` |
| PawnIO driver | `winget install --id namazso.PawnIO -e --silent` — the signed driver LHM needs for CPU temps and fans. |
| LibreHardwareMonitor settings | Writes `LibreHardwareMonitor.config` next to LHM: web server **on, port 8085**, start minimized, minimize to tray. No menus to click. |
| "HomePanel Sensors" task | Starts LHM elevated at your logon, starts it now, and waits for `http://localhost:8085/data.json`. |
| Mosquitto | `winget install --id EclipseFoundation.Mosquitto -e --silent` |
| Mosquitto: login + config | `C:\ProgramData\HomePanel\mosquitto\mosquitto.conf` (port 1883, no anonymous logins), user `homepanel` with a generated password, points the *Mosquitto Broker* service at it, restarts it and tests a login. |
| Windows Firewall | Inbound TCP **8080** (dashboard) and **1883** (MQTT), **Private** networks only. If Windows thinks your home network is *Public*, it offers to switch it to Private. |
| Server settings | `C:\ProgramData\HomePanel\server\.env` (MQTT login + admin password), readable by administrators only. |
| "HomePanel Server" task | Runs the server at startup as SYSTEM (before anyone logs in), restarts it if it stops, waits for `/api/health`. |
| Register this PC + agent.yaml | Registers `gaming-pc` (with its MAC address for Wake-on-LAN) and writes `C:\ProgramData\HomePanel\agent.yaml` with the suggested buttons. |
| "HomePanel Agent" task | Runs the agent at your logon, in your session (so buttons open windows on your screen), and waits until the PC is **online**. |
| Open the dashboard | Pairs this PC's browser with the `desk-monitor` layout and opens `http://localhost:8080`. |

Questions it asks: the admin password (*make one up for me* or type your own) and this PC's id — keep **`gaming-pc`**,
the example layouts use it.

**If a "PawnIO is not installed, do you want to install it?" box appears** (only when the silent install didn't work),
click **OK**.

At the end you get a summary — **write down the admin password and the MQTT password**:

```
✔ Dashboard on this PC : http://localhost:8080
✔ Admin page           : http://localhost:8080/admin   password: ••••••••
✔ Tablets / phones     : http://192.168.1.50:8080
✔ Other PCs            : download http://192.168.1.50:8080/download/HomePanel.exe, run it, choose "Join this PC"
```

If a step fails, setup prints **how to fix it** and offers *Try again / Skip / Stop*. Run it again later and it picks up
where it stopped. Unattended re-run: `"C:\Program Files\HomePanel\HomePanel.exe" setup --mode host --yes`.

## 3. Tablets and screens (~5 min each)

On the tablet open `http://<gaming-pc-ip>:8080` (the "Tablets" line of the summary). A 6-digit code appears; approve it
in the admin page → **Screens** and pick a profile (`kitchen-ipad`, `fire-hd8`, …). Kiosk tips per device:
[screens.md](screens.md). While the server lives on the gaming PC, tablets work only when the PC is on.

## 4. Your buttons

Open `C:\ProgramData\HomePanel\agent.yaml` in Notepad (as administrator). The suggested buttons are already there
(open drives, Steam, media keys, lock, sleep…); add your own — see [pc-agent.md](pc-agent.md). Then restart the agent:
Task Scheduler → **HomePanel Agent** → End, then Run (or run setup again).

## 5. More PCs

On each other PC: download `HomePanel.exe` from the summary's "Other PCs" link (or the releases page), run it and pick
**2. Join this PC**. It finds the server on your network (or asks for its address), asks for the admin and MQTT
passwords, then installs LibreHardwareMonitor + the agent the same way.

## 6. Later: the mini PC (Proxmox + Home Assistant OS)

Run `HomePanel.exe` → **3. Set up Home Assistant / mini PC** → **Mini PC running Proxmox VE** → *Do it for me over
SSH*. Give it the Proxmox IP (it scans for one) and the root password, trust the host key, and it creates the Home
Assistant OS VM itself (download, `qm create`, EFI + system disk, ZBT-1 passthrough, start), finds the VM's IP and
goes straight on with onboarding, MQTT, the token, Zigbee, doorbells and the HomePanel app. Details and the manual
alternative: [hosts.md → Proxmox VE](hosts.md#proxmox-ve).

## 7. Move the server to Home Assistant

When step 6 finishes on the gaming PC that ran **Host on this PC**, setup offers to move the server right away (or
pick **4. Move the server to Home Assistant** later). It:

1. registers this PC with the HomePanel app on HA and points `agent.yaml` at HA's Mosquitto (your buttons stay),
   restarts the agent and waits until the new server shows the PC online;
2. copies your layouts (`C:\ProgramData\HomePanel\server\profiles\*.yaml`) and `config.yaml` to the new server;
3. removes the **HomePanel Server** task, stops Mosquitto (set to Manual; it offers to uninstall it) and removes the two
   firewall rules — the old data folder stays as a backup;
4. pairs this PC's browser with the new dashboard and prints its address.

**Screens paired to the old server must pair again:** open `http://<ha-ip>:8080` on each tablet and approve the new
6-digit code in *Admin → Screens*. Other PCs that joined the gaming PC: run `HomePanel.exe` → *Join this PC* → pick the
Home Assistant address.

## Where things are

| What | Where |
| --- | --- |
| Program | `C:\Program Files\HomePanel\HomePanel.exe` |
| Server data (profiles, paired screens, PCs) + `.env` | `C:\ProgramData\HomePanel\server\` |
| PC buttons | `C:\ProgramData\HomePanel\agent.yaml` |
| Logs | `C:\ProgramData\HomePanel\logs\server.log`, `agent.log`; Mosquitto: `C:\ProgramData\HomePanel\mosquitto\mosquitto.log` |
| Setup progress + passwords | `C:\ProgramData\HomePanel\setup\` (administrators only) |
| Scheduled tasks | Task Scheduler → *HomePanel Server*, *HomePanel Agent*, *HomePanel Sensors* |
| Check everything | `HomePanel.exe doctor` (or *Check everything* in the start menu) |

**Troubleshooting**

- *Tablets can't open the dashboard*: Windows must treat your home network as **Private** (Settings → Network &
  internet → your connection). Setup offers to fix this.
- *No temperatures, only CPU load and memory*: open <http://localhost:8085>. If it doesn't load, look for the
  LibreHardwareMonitor tray icon; [pc-agent.md](pc-agent.md#troubleshooting) has more.
- *Port 8080 or 1883 already used*: `netstat -ano | findstr :8080` shows which program has it.

---

## Appendix: by hand / Home Assistant on the T8 Plus bare metal

The steps below are the manual route (and what mode 3 automates): Home Assistant OS installed directly on the T8 Plus,
the HomePanel app inside Home Assistant. From a source checkout you can run the same setup program with
`pnpm install && pnpm -r build && node apps/installer/dist/cli.js setup`.

### A1. Install Home Assistant OS on the T8 Plus (~45 min)

The T8 Plus comes with Windows 11. This step **erases Windows**, so back up anything you want to keep first.

Full guide with screenshots-level detail: [hosts.md → x86 mini PC](hosts.md#x86-mini-pc). Short version:

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

### A2. Onboarding (~5 min)

Open `http://homeassistant.local:8123`. If that address doesn't load, use `http://<ip>:8123`.
Create your owner account and set your location, time zone and units.
`homepanel setup` can do all of this for you. It asks for the same details in the terminal (your password is hidden as you type) and then
creates a **long-lived access token** called "HomePanel".

### A3. Zigbee with the ZBT-1 (~5 min)

1. Plug the ZBT-1 into the T8 Plus **with a USB extension cable**, about 0.5–1 m long. Use a USB 2 port if there is one.
   USB 3 ports and the PC itself give off radio noise that interferes with Zigbee.
2. Go to HA → **Settings → Devices & services**. The ZBT-1 shows up as *Discovered*. Click **Add**, choose **Zigbee**, then **Submit**.
3. To pair devices, open **Zigbee Home Automation → Add device**.

More: [zigbee-zbt1.md](zigbee-zbt1.md)

### A4. Mosquitto MQTT broker (~3 min)

PC agents send their data to HomePanel over MQTT.

- With `homepanel setup`, the `mqtt` step installs the **Mosquitto broker** app and
  creates a local-only HA user `homepanel` that the broker uses for logins. It also adds the MQTT integration.
- To do it by hand: HA → **Settings → Apps** (called *Add-ons* in older versions) → **App store** → *Mosquitto broker* →
  **Install** → turn on *Start on boot* → **Start**. Then go to **Settings → People**, add a user `homepanel`, and
  accept the discovered **MQTT** integration in *Devices & services*.

### A5. The HomePanel app (~10 min, mostly building)

1. HA → **Settings → Apps → App store → ⋮ → Repositories**. Add the HomePanel app repository URL:
   `https://github.com/theCommitWhisperer/homepanel`
2. Find **HomePanel** in the store, click **Install**, and wait. The first install builds from source and takes a few minutes on the N100.
3. On the **Configuration** tab, set `admin_password`. Optionally fill in the AI fields too.
4. On the **Info** tab, turn on *Start on boot* and *Watchdog*, then click **Start**.
5. Open `http://<ha-ip>:8080/admin` and log in.

You don't need to enter a Home Assistant token or MQTT login. The app gets both from the Supervisor.

### A6. Gaming PC agent (~10 min)

Easiest: run `HomePanel.exe` on the gaming PC → **Join this PC** (it does all of this). By hand: `homepanel agent-key gaming-pc --name "Gaming PC"` registers the PC and writes its `agent.yaml`.
Details: [pc-agent.md](pc-agent.md).

1. On the gaming PC, install **LibreHardwareMonitor**. Run it as administrator, then enable
   *Options → Remote Web Server → Run* (port 8085) and *Run on Windows startup*.
2. In HomePanel admin → **Computers → Add**, enter the id `gaming-pc` and the name "Gaming PC". Adding the MAC address enables
   Wake-on-LAN. You get a **key**. If you use `homepanel setup`, the `pcs` step does this for you and writes a complete
   `agent-gaming-pc.yaml` to `~/.homepanel/`.
3. Copy the yaml to `C:\ProgramData\HomePanel\agent.yaml` on the PC. Then install the agent with the script in
   `apps/agent` (see the agent's README for the exact command).
4. Within a few seconds the PC shows as *online* in admin, and its temperatures appear on the `desk-monitor` profile.

### A7. Screens

**iPad** ([screens.md#ipad](screens.md#ipad))
1. In Safari, open `http://<ha-ip>:8080`, then tap **Share → Add to Home Screen**.
2. A 6-digit code appears. In admin → **Devices**, approve it and choose the `kitchen-ipad` profile.
3. Turn on **Guided Access** to lock the iPad to HomePanel, and set Auto-Lock to *Never*.

**Fire HD 8, 10th gen** ([screens.md#fire-hd8](screens.md#fire-hd8))
1. Remove the lock-screen ads. Either pay the one-time fee in your Amazon account, or use Amazon Fire Toolbox (unofficial).
2. Install **Fully Kiosk Browser** and set its *Start URL* to `http://<ha-ip>:8080`.
3. Approve the code and choose the `fire-hd8` profile. It is a *lite* profile: no animations, and camera snapshots instead of live video.
   The Fire HD 8 is slow, and this profile keeps it responsive.

### A8. Doorbells ([doorbells.md](doorbells.md))

- **Reolink**: give the doorbell a fixed IP. Then add HA's **Reolink** integration with that IP and the doorbell's admin login
  (`homepanel setup --step doorbells` can do this). In HomePanel admin → **Doorbells**, choose the
  `binary_sensor.<name>_visitor` entity as the ring trigger and the doorbell camera as the camera.
- **Eufy**: there is no official integration. The community *eufy-security-ws* app plus the *Eufy Security* integration from HACS
  work with many models. Treat this as best effort.

When someone rings, every screen shows a full-screen camera view for 60 seconds.

### A9. Remote access with Tailscale ([remote-access.md](remote-access.md))

1. HA → **Settings → Apps → App store** → **Tailscale** (from the Home Assistant Community Apps repository) → **Install** → **Start**.
2. Open its web UI and log in. Then install Tailscale on your phone and log in with the same account.
3. From anywhere, use `http://homeassistant:8123` for HA and `http://homeassistant:8080` for HomePanel.

You don't need to open any ports on your router.

### A10. Check everything

```bash
homepanel doctor
```

This checks that HA is reachable, the token works, MQTT is up, the HomePanel server is running and PC agents are online.
Each failure comes with a suggested fix.

### Next

- Change layouts: [widgets.md](widgets.md)
- Build your own widget: [widgets.md → Writing a new widget](widgets.md#writing-a-new-widget)
- Monitoring the mini PC itself: HA OS is an appliance, so the HomePanel agent can't be installed on it. Instead, add HA's
  **System Monitor** integration (CPU load, memory, disk) and show those sensors with `entity` widgets. If you later run
  HA in Docker or a VM on a Linux host, the agent can run on that host (it reads Linux `hwmon` sensors).
