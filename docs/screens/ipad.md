# iPad as a HomePanel screen

Any iPad that runs a current Safari will work. Older iPads stuck on iPadOS 12 may struggle, so try the demo first.

## 1. Add HomePanel to the home screen

1. In Safari, open `http://<homepanel-ip>:8080`. On HA OS that's the HA IP.
2. Tap **Share → Add to Home Screen → Add**.
3. Open **HomePanel** from the new icon. It runs fullscreen, without Safari's toolbars.

## 2. Pair it

A 6-digit code appears. On another device, open `http://<homepanel-ip>:8080/admin` → **Devices → Pending**, check the
code matches, choose a name and a profile (for example `kitchen-ipad`), and approve. The iPad switches to the dashboard.
The pairing survives restarts. If you revoke it in admin, the iPad goes back to the code screen.

## 3. Lock it to HomePanel (Guided Access)

1. **Settings → Accessibility → Guided Access → On**. Set a passcode and turn on *Accessibility Shortcut*.
2. Open HomePanel, **triple-click** the top button (or the Home button on older iPads), then tap **Start**.
3. To leave, triple-click again and enter the passcode.

## 4. Keep it on

- **Settings → Display & Brightness → Auto-Lock → Never.** Guided Access has its own *Display Auto-Lock* option. Set that to Never as well.
- Keep it plugged in. For a long-term wall mount, turn on **Settings → Battery → Optimised Charging** where available.
  Some iPads also have a *Limit to 80%* option, which is better for a battery that stays at 100% all day.

## Notes

- **The doorbell can't wake an iPad screen.** iOS doesn't let a web page turn the display on. Keep Auto-Lock on Never and use
  the profile's `idle` setting to dim to a clock instead of letting the screen sleep.
- Live camera video (MJPEG) works in Safari. If it stutters, the camera widget falls back to snapshots.
