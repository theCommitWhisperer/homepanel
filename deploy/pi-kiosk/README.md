# Raspberry Pi kiosk

Turns a Raspberry Pi (3B+/4/5) with Raspberry Pi OS **with desktop** into a HomePanel screen.

```bash
scp -r deploy/pi-kiosk pi@<pi-ip>:~
ssh pi@<pi-ip>
HOMEPANEL_URL=http://<homepanel-ip>:8080 bash ~/pi-kiosk/install.sh
sudo raspi-config   # System Options → Boot / Auto Login → Desktop Autologin
sudo reboot
```

- `install.sh` installs Chromium if needed, puts `homepanel-kiosk` in `~/.local/bin`, and adds it to
  the desktop autostart (labwc, wayfire and XDG autostart are all covered — Raspberry Pi OS has
  switched compositors twice, so we set all three).
- `kiosk.sh` waits for the server, starts Chromium in `--kiosk` mode and restarts it if it closes.
- The Chromium profile lives in `~/.config/homepanel/chromium`, so the device stays paired across reboots.
- Exit kiosk: plug in a keyboard and press Alt+F4 (it restarts after 3 s — run `pkill -f homepanel-kiosk` first).

Screen sleep at night: Raspberry Pi OS uses `wlr-randr` (Wayland) or `xset dpms` (X11). A cron job such as
`0 23 * * * WAYLAND_DISPLAY=wayland-0 wlr-randr --output HDMI-A-1 --off` works on labwc; the exact output
name comes from running `wlr-randr` once. (Not automated — it depends on your display.)
