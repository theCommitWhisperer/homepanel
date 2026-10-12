# Amazon Fire HD 8 (10th gen, 2020) as a HomePanel screen

A cheap, good wall screen once you remove the ads and replace the browser. It is slow, so give it the `fire-hd8`
profile (`lite: true`: no animations, slower refresh, camera snapshots instead of live video).

## 1. Get rid of lock-screen ads ("Special Offers")

Pick one:

- **Official:** amazon.com → *Account → Content & Devices → Devices* → your Fire → *Remove ads* (one-time fee,
  usually around $15–20).
- **Unofficial:** **Amazon Fire Toolbox** (a free Windows tool from XDA) can disable the lock-screen ads, the Amazon launcher, and
  other bloat over USB. Turn on *Developer options → USB debugging* on the tablet first. It's a community tool, so
  results vary between Fire OS versions. Read its current XDA thread before you use it.

## 2. Install Fully Kiosk Browser

The built-in Silk browser is a poor fit for a kiosk. **Fully Kiosk Browser** is made for this job.

- **Settings → Security & Privacy → Apps from Unknown Sources** → allow Silk (or your file manager).
- In Silk, download the APK from **fully-kiosk.com** and install it.
- Or use Fire Toolbox, which can install Google Play first, and then install Fully from Play.

## 3. Configure Fully

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

## 4. Pair it

Approve the 6-digit code at `http://<homepanel-ip>:8080/admin` → Devices and choose the **fire-hd8** profile.

## 5. Optional: wake the screen when the doorbell rings (Fully PLUS)

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

## Tips

- Turn the screen off at night with Fully's *Scheduled Wake Up / Sleep* (PLUS).
- If the tablet runs hot or slow, check the profile has `lite: true` and keep camera `refreshSec` at 10 or more.
- The 10th-gen Fire HD 8 uses USB-C. A right-angle cable makes wall mounting easier.
