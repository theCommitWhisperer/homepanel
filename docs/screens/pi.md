# Raspberry Pi + monitor as a HomePanel screen

Any Pi 3B+, 4 or 5 running **Raspberry Pi OS with desktop** works with an HDMI monitor or the official touchscreen.

```bash
# from a HomePanel checkout on your computer
scp -r deploy/pi-kiosk pi@<pi-ip>:~
ssh pi@<pi-ip>
HOMEPANEL_URL=http://<homepanel-ip>:8080 bash ~/pi-kiosk/install.sh
sudo raspi-config     # System Options → Boot / Auto Login → Desktop Autologin
sudo reboot
```

After the reboot, Chromium opens HomePanel fullscreen and shows the 6-digit code. Approve it in `/admin`.

Details, how to exit, and screen-off scheduling: [deploy/pi-kiosk/README.md](../../deploy/pi-kiosk/README.md).

Notes:
- The script covers the labwc, wayfire and X11 desktops. Raspberry Pi OS has used all three in recent years, and
  which one you have depends on when you installed it.
- A Pi 3B+ is fine for clock, lights and button profiles. Use `lite: true` there.
