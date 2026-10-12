# Windows PC or monitor as a HomePanel screen

Good for a **second monitor next to the gaming PC** (use the `desk-monitor` profile) or an old laptop on the wall.

Quick version: a desktop shortcut that opens Edge in kiosk mode.

```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk http://<homepanel-ip>:8080 --edge-kiosk-type=fullscreen --no-first-run --user-data-dir=%LOCALAPPDATA%\HomePanelKiosk
```

Copy it into `shell:startup` to start it when you log in. Press Alt+F4 to exit.

To put HomePanel on a **specific monitor**, open it once in a normal Edge window on that monitor, close it, then use the
kiosk shortcut. Edge reopens on the last monitor it used, though not every time. On a dedicated PC, set that monitor as the main display.

For a locked-down kiosk account (Windows Pro/Enterprise "Assigned Access"), see
[deploy/windows-kiosk.md](../../deploy/windows-kiosk.md).

Then approve the 6-digit code at `http://<homepanel-ip>:8080/admin`.
