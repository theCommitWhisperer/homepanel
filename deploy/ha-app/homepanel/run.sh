#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Map the app options + Supervisor services to the HomePanel server's environment.
set -e

export PORT=8080
export DATA_DIR="${DATA_DIR:-/data/homepanel}"
export KIOSK_DIST=/app/kiosk-dist
export AGENT_DIST=/app/agent-dist
mkdir -p "${DATA_DIR}"

# Outside Home Assistant (CI smoke test, plain `docker run`) there is no Supervisor to read options
# from: use the environment as given (ADMIN_PASSWORD, HA_URL/HA_TOKEN, MQTT_URL/MQTT_USER/MQTT_PASS, ...).
if [ -z "${SUPERVISOR_TOKEN:-}" ]; then
  echo "[homepanel] No Supervisor found: using environment variables only."
  exec node /app/dist/index.js
fi

# Home Assistant: the Supervisor proxies the Core API; the Supervisor token is the HA token.
export HA_URL="http://supervisor/core"
export HA_TOKEN="${SUPERVISOR_TOKEN}"

# bashio::config prints "null" for options that are not set, so check has_value before reading.
if bashio::config.has_value 'admin_password'; then
  ADMIN_PASSWORD="$(bashio::config 'admin_password')"
  export ADMIN_PASSWORD
else
  bashio::log.warning "admin_password is empty — the server will generate one and print it in this log."
  unset ADMIN_PASSWORD
fi

# MQTT: explicit options win; otherwise ask the Supervisor (the Mosquitto broker app provides the service).
if bashio::config.has_value 'mqtt_url'; then
  MQTT_URL="$(bashio::config 'mqtt_url')"
  export MQTT_URL
  if bashio::config.has_value 'mqtt_username'; then MQTT_USER="$(bashio::config 'mqtt_username')"; export MQTT_USER; fi
  if bashio::config.has_value 'mqtt_password'; then MQTT_PASS="$(bashio::config 'mqtt_password')"; export MQTT_PASS; fi
  bashio::log.info "Using MQTT broker ${MQTT_URL} from the app options."
elif bashio::services.available "mqtt"; then
  host="$(bashio::services mqtt 'host')"
  port="$(bashio::services mqtt 'port')"
  scheme="mqtt"
  if bashio::var.true "$(bashio::services mqtt 'ssl')"; then scheme="mqtts"; fi
  export MQTT_URL="${scheme}://${host}:${port}"
  MQTT_USER="$(bashio::services mqtt 'username')"
  MQTT_PASS="$(bashio::services mqtt 'password')"
  export MQTT_USER MQTT_PASS
  bashio::log.info "Using MQTT broker ${MQTT_URL} from the Supervisor."
else
  bashio::log.warning "No MQTT broker found. Install the Mosquitto broker app for PC agents."
fi

if bashio::config.has_value 'ai_provider'; then
  AI_PROVIDER="$(bashio::config 'ai_provider')"
  export AI_PROVIDER
  if bashio::config.has_value 'ai_model'; then AI_MODEL="$(bashio::config 'ai_model')"; export AI_MODEL; fi
  if bashio::config.has_value 'ai_base_url'; then AI_BASE_URL="$(bashio::config 'ai_base_url')"; export AI_BASE_URL; fi
  if bashio::config.has_value 'ai_api_key'; then AI_API_KEY="$(bashio::config 'ai_api_key')"; export AI_API_KEY; fi
fi

LOG_LEVEL="$(bashio::config 'log_level' 'info')"
export LOG_LEVEL

bashio::log.info "Starting HomePanel on port ${PORT}"
exec node /app/dist/index.js
