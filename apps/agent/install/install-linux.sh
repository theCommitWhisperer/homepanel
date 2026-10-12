#!/bin/sh
# HomePanel PC agent — Linux install (per user, no root needed except for optional linger).
# Run from the unzipped release folder:  sh install-linux.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
APP="$HOME/.local/share/homepanel"
CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/homepanel"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

NODE=$(command -v node || true)
if [ -z "$NODE" ]; then echo "Node.js 22+ is required (https://nodejs.org)"; exit 1; fi
MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 22 ]; then echo "Node.js 22+ is required, found $("$NODE" --version)"; exit 1; fi

mkdir -p "$APP" "$CFG_DIR" "$UNIT_DIR"
cp "$HERE/agent.cjs" "$APP/agent.cjs"
if [ ! -f "$CFG_DIR/agent.yaml" ]; then
  cp "$HERE/agent.example.yaml" "$CFG_DIR/agent.yaml"
  chmod 600 "$CFG_DIR/agent.yaml"
  echo "Created $CFG_DIR/agent.yaml — edit pcId, mqtt and key, and replace the Windows actions."
  NEED_EDIT=1
fi
sed "s#^ExecStart=/usr/bin/node #ExecStart=$NODE #" "$HERE/homepanel-agent.service" > "$UNIT_DIR/homepanel-agent.service"
systemctl --user daemon-reload
systemctl --user enable homepanel-agent >/dev/null
if [ "${NEED_EDIT:-0}" = 1 ]; then
  echo "Then start it:  systemctl --user start homepanel-agent"
else
  systemctl --user restart homepanel-agent
  echo "Agent (re)started. Logs: journalctl --user -u homepanel-agent -f"
fi
echo "Sensors on this machine:  $NODE $APP/agent.cjs list-sensors"
echo "Keep it running without a login:  sudo loginctl enable-linger $USER"
