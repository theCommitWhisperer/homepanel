# Screens

Every screen works the same way: open `http://<homepanel-ip>:8080` in a browser, a 6-digit code appears,
approve it in `http://<homepanel-ip>:8080/admin` → Devices and pick a profile (layout). `homepanel screens <type>` prints
these steps with your server's address filled in.

| Screen | Kiosk app | Profile | Doorbell can wake it? |
| --- | --- | --- | --- |
| iPad | Safari → Add to Home Screen + Guided Access | `kitchen-ipad` | no (iOS limitation) |
| Fire HD 8 (10th gen) | Fully Kiosk Browser | `fire-hd8` (lite) | yes, with Fully PLUS remote admin |
| Android tablet | Fully Kiosk Browser | any | yes, with Fully PLUS |
| Raspberry Pi + monitor | `chromium --kiosk` | any | screen stays on |
| Windows PC / monitor | Edge `--kiosk` | `desk-monitor` | screen stays on |


---

<a id="ipad"></a>

## iPad as a HomePanel screen

Any iPad that runs a current Safari will work. Older iPads stuck on iPadOS 12 may struggle, so try the demo first.

### 1. Add HomePanel to the home screen

1. In Safari, open `http://<homepanel-ip>:8080`. On HA OS that's the HA IP.
2. Tap **Share → Add to Home Screen → Add**.
3. Open **HomePanel** from the new icon. It runs fullscreen, without Safari's toolbars.

### 2. Pair it

A 6-digit code appears. On another device, open `http://<homepanel-ip>:8080/admin` → **Devices → Pending**, check the
code matches, choose a name and a profile (for example `kitchen-ipad`), and approve. The iPad switches to the dashboard.
The pairing survives restarts. If you revoke it in admin, the iPad goes back to the code screen.

### 3. Lock it to HomePanel (Guided Access)

1. **Settings → Accessibility → Guided Access → On**. Set a passcode and turn on *Accessibility Shortcut*.
2. Open HomePanel, **triple-click** the top button (or the Home button on older iPads), then tap **Start**.
3. To leave, triple-click again and enter the passcode.

### 4. Keep it on

- **Settings → Display & Brightness → Auto-Lock → Never.** Guided Access has its own *Display Auto-Lock* option. Set that to Never as well.
- Keep it plugged in. For a long-term wall mount, turn on **Settings → Battery → Optimised Charging** where available.
  Some iPads also have a *Limit to 80%* option, which is better for a battery that stays at 100% all day.

### Notes

- **The doorbell can't wake an iPad screen.** iOS doesn't let a web page turn the display on. Keep Auto-Lock on Never and use
  the profile's `idle` setting to dim to a clock instead of letting the screen sleep.
- Live camera video (MJPEG) works in Safari. If it stutters, the camera widget falls back to snapshots.


---

<a id="fire-hd8"></a>

## Amazon Fire HD 8 (10th gen, 2020) as a HomePanel screen

A cheap, good wall screen once you remove the ads and replace the browser. It is slow, so give it the `fire-hd8`
profile (`lite: true`: no animations, slower refresh, camera snapshots instead of live video).

### 1. Get rid of lock-screen ads ("Special Offers")

Pick one:

- **Official:** amazon.com → *Account → Content & Devices → Devices* → your Fire → *Remove ads* (one-time fee,
  usually around $15–20).
- **Unofficial:** **Amazon Fire Toolbox** (a free Windows tool from XDA) can disable the lock-screen ads, the Amazon launcher, and
  other bloat over USB. Turn on *Developer options → USB debugging* on the tablet first. It's a community tool, so
  results vary between Fire OS versions. Read its current XDA thread before you use it.

### 2. Install Fully Kiosk Browser

The built-in Silk browser is a poor fit for a kiosk. **Fully Kiosk Browser** is made for this job.

- **Settings → Security & Privacy → Apps from Unknown Sources** → allow Silk (or your file manager).
- In Silk, download the APK from **fully-kiosk.com** and install it.
- Or use Fire Toolbox, which can install Google Play first, and then install Fully from Play.

### 3. Configure Fully

Open Fully → swipe from the left edge → **Settings**:

| Setting | Value |
| --- | --- |
| Web Content Settings → **Start URL** | `http://<homepanel-ip>:8080` |
| Web Content Settings → Autoplay Videos | on |
| Device Management → **Keep Screen On** | on |
| Device Management → Screen Brightness | to taste (around 60%) |
| Device Management → Launch on Boot | on |
| Kiosk Mode (PLUS) → Enable Kiosk Mode | on, with a PIN |
| Power Settings → Prevent from Sleep while Screen Off | on |

### 4. Pair it

Approve the 6-digit code at `http://<homepanel-ip>:8080/admin` → Devices and choose the **fire-hd8** profile.

### 5. Optional: wake the screen when the doorbell rings (Fully PLUS)

With a Fully PLUS licence (one-time, per device), turn on **Remote Administration** (set a password, and enable remote admin from the local network).
Then add the tablet to the server config (`/admin` → Config):

```yaml
fully_kiosk:
  fire-hall:                       # any id
    url: http://192.168.1.60:2323  # the tablet's IP, Fully's remote-admin port
    password: <remote admin password>
on_ring:
  wake_screens: true
```

When the doorbell rings, HomePanel calls Fully to turn the screen on before showing the camera.

### Tips

- Turn the screen off at night with Fully's *Scheduled Wake Up / Sleep* (PLUS).
- If the tablet runs hot or slow, check the profile has `lite: true` and keep camera `refreshSec` at 10 or more.
- The 10th-gen Fire HD 8 uses USB-C. A right-angle cable makes wall mounting easier.


---

<a id="android"></a>

## Android tablet as a HomePanel screen

1. Install **Fully Kiosk Browser** from Google Play.
2. Settings → Web Content → **Start URL** `http://<homepanel-ip>:8080`. Turn on **Keep Screen On** and **Launch on Boot**.
   Turn on **Kiosk Mode** (PLUS) if you want to lock the tablet to HomePanel.
3. Approve the 6-digit code at `http://<homepanel-ip>:8080/admin` → Devices, and choose a profile.

Free alternative: Chrome → ⋮ → **Add to Home screen / Install app**, plus Android's **App pinning**
(Settings → Security → App pinning). This works, but it can't wake the screen or stop the tablet from sleeping as reliably as Fully.

For slow or older tablets, use a profile with `lite: true`.

Waking the screen on a doorbell ring needs Fully PLUS remote admin. See [fire-hd8.md](#fire-hd8).


---

<a id="raspberry-pi-screen"></a>

## Raspberry Pi + monitor as a HomePanel screen

Any Pi 3B+, 4 or 5 running **Raspberry Pi OS with desktop** works with an HDMI monitor or the official touchscreen.

```bash
## from a HomePanel checkout on your computer
scp -r deploy/pi-kiosk pi@<pi-ip>:~
ssh pi@<pi-ip>
HOMEPANEL_URL=http://<homepanel-ip>:8080 bash ~/pi-kiosk/install.sh
sudo raspi-config     # System Options → Boot / Auto Login → Desktop Autologin
sudo reboot
```

After the reboot, Chromium opens HomePanel fullscreen and shows the 6-digit code. Approve it in `/admin`.

Details, how to exit, and screen-off scheduling: [deploy/pi-kiosk/README.md](../deploy/pi-kiosk/README.md).

Notes:
- The script covers the labwc, wayfire and X11 desktops. Raspberry Pi OS has used all three in recent years, and
  which one you have depends on when you installed it.
- A Pi 3B+ is fine for clock, lights and button profiles. Use `lite: true` there.


---

<a id="windows-pc"></a>

## Windows PC or monitor as a HomePanel screen

Good for a **second monitor next to the gaming PC** (use the `desk-monitor` profile) or an old laptop on the wall.

Quick version: a desktop shortcut that opens Edge in kiosk mode.

```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk http://<homepanel-ip>:8080 --edge-kiosk-type=fullscreen --no-first-run --user-data-dir=%LOCALAPPDATA%\HomePanelKiosk
```

Copy it into `shell:startup` to start it when you log in. Press Alt+F4 to exit.

To put HomePanel on a **specific monitor**, open it once in a normal Edge window on that monitor, close it, then use the
kiosk shortcut. Edge reopens on the last monitor it used, though not every time. On a dedicated PC, set that monitor as the main display.

For a locked-down kiosk account (Windows Pro/Enterprise "Assigned Access"), see
[deploy/windows-kiosk.md](../deploy/windows-kiosk.md).

Then approve the 6-digit code at `http://<homepanel-ip>:8080/admin`.
