#!/usr/bin/env bash
# HomePanel kiosk for Raspberry Pi OS (Bookworm or newer, with desktop).
# Makes Chromium open HomePanel fullscreen at login, hides the cursor and stops screen blanking.
#
#   HOMEPANEL_URL=http://192.168.1.20:8080 bash install.sh
#
# Undo: rm ~/.config/autostart/homepanel-kiosk.desktop ~/.config/labwc/autostart.d/homepanel 2>/dev/null
set -euo pipefail

URL="${HOMEPANEL_URL:-${1:-}}"
if [ -z "$URL" ]; then
  read -rp "HomePanel URL (e.g. http://192.168.1.20:8080): " URL
fi
case "$URL" in http://*|https://*) ;; *) echo "URL must start with http:// or https://"; exit 1;; esac

DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
install -m 755 "$DIR/kiosk.sh" "$BIN/homepanel-kiosk"
mkdir -p "$HOME/.config/homepanel"
echo "HOMEPANEL_URL=$URL" > "$HOME/.config/homepanel/kiosk.env"

if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  echo "Installing Chromium…"
  sudo apt-get update && sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser
fi
command -v unclutter >/dev/null || sudo apt-get install -y unclutter || true

# Autostart: labwc (Raspberry Pi OS since late 2024), wayfire (Bookworm 2023/24), and XDG (X11/LXDE)
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/homepanel-kiosk.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=HomePanel kiosk
Exec=$BIN/homepanel-kiosk
X-GNOME-Autostart-enabled=true
DESK
if [ -d "$HOME/.config/labwc" ] || command -v labwc >/dev/null; then
  mkdir -p "$HOME/.config/labwc"
  touch "$HOME/.config/labwc/autostart"
  grep -q homepanel-kiosk "$HOME/.config/labwc/autostart" || echo "$BIN/homepanel-kiosk &" >> "$HOME/.config/labwc/autostart"
fi
if [ -f "$HOME/.config/wayfire.ini" ]; then
  grep -q homepanel "$HOME/.config/wayfire.ini" || printf '\n[autostart]\nhomepanel = %s\n' "$BIN/homepanel-kiosk" >> "$HOME/.config/wayfire.ini"
fi

# Screen blanking off (raspi-config non-interactive: 1 = disable)
if command -v raspi-config >/dev/null; then sudo raspi-config nonint do_blanking 1 || true; fi

echo
echo "Done. Turn on desktop auto-login (sudo raspi-config → System Options → Boot / Auto Login → Desktop Autologin)"
echo "and reboot. HomePanel opens at $URL — approve the 6-digit code in $URL/admin."
