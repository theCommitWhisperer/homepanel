# Windows as a HomePanel screen

Two ways, from simple to locked-down.

## 1. Edge kiosk shortcut (any Windows 10/11 edition)

Right-click the desktop → New → Shortcut, and paste (replace the address):

```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk http://192.168.1.20:8080 --edge-kiosk-type=fullscreen --no-first-run --user-data-dir=%LOCALAPPDATA%\HomePanelKiosk
```

- `--user-data-dir` keeps HomePanel's pairing separate from your normal Edge profile.
- Exit with Alt+F4.
- Start it at login: press Win+R, type `shell:startup`, and copy the shortcut there.
- Stop the screen turning off: Settings → System → Power → Screen and sleep → Never.

This is what you want for a second monitor on the gaming PC or a small always-on PC.

## 2. Assigned Access kiosk (Windows 10/11 Pro, Enterprise, Education)

For a PC that should *only* show HomePanel:

1. Settings → Accounts → Other users → **Kiosk** → Get started.
2. Create the kiosk account (e.g. `HomePanel`), choose **Microsoft Edge**.
3. Choose **As a digital sign or interactive display**, enter `http://<server>:8080`.
4. Idle timeout: never (HomePanel handles its own idle screen).
5. Sign out; the PC now logs into the kiosk account and shows HomePanel fullscreen.

To leave the kiosk press Ctrl+Alt+Del and sign in as an admin. Windows Home does not have Assigned
Access — use option 1.

## Pairing

The first time, HomePanel shows a 6-digit code. Approve it at `http://<server>:8080/admin` → Devices,
and pick a profile (e.g. `desk-monitor`).
