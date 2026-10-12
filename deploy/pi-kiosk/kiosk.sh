#!/usr/bin/env bash
# Starts Chromium in kiosk mode on HomePanel and restarts it if it exits.
set -u
[ -f "$HOME/.config/homepanel/kiosk.env" ] && . "$HOME/.config/homepanel/kiosk.env"
URL="${HOMEPANEL_URL:-http://homeassistant.local:8080}"
BROWSER="$(command -v chromium || command -v chromium-browser)"

# X11 only: no screensaver / DPMS, hide the mouse
if [ -n "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  xset s off -dpms s noblank 2>/dev/null || true
  command -v unclutter >/dev/null && unclutter -idle 1 -root &
fi

# Wait for the network / server (up to 2 minutes)
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null --max-time 2 "$URL/api/health" && break
  sleep 2
done

PROFILE="$HOME/.config/homepanel/chromium"
mkdir -p "$PROFILE"
# Tell Chromium it exited cleanly so it never shows the "restore pages" bar
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' \
  "$PROFILE/Default/Preferences" 2>/dev/null || true

while true; do
  "$BROWSER" \
    --user-data-dir="$PROFILE" \
    --kiosk "$URL" \
    --noerrdialogs --disable-infobars --no-first-run \
    --disable-session-crashed-bubble --disable-features=Translate \
    --check-for-update-interval=31536000 \
    --overscroll-history-navigation=0 \
    --autoplay-policy=no-user-gesture-required \
    --ozone-platform-hint=auto
  sleep 3
done
