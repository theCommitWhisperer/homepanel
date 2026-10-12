#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Map the app options + Supervisor services to the HomePanel server's environment.
set -e

export PORT=8080
export DATA_DIR=/data/homepanel
mkdir -p "${DATA_DIR}"

# Home Assistant: the Supervisor proxies the Core API; the Supervisor token is the HA token.
export HA_URL="http://supervisor/core"
export HA_TOKEN="${SUPERVISOR_TOKEN}"

export ADMIN_PASSWORD="$(bashio::config 'admin_password')"
if [ -z "${ADMIN_PASSWORD}" ]; then
  bashio::log.warning "admin_password is empty — the server will generate one and print it in this log."
  unset ADMIN_PASSWORD
fi

# MQTT: explicit options win; otherwise ask the Supervisor (Mosquitto app provides the service).
if bashio::config.has_value 'mqtt_url'; then
  export MQTT_URL="$(bashio::config 'mqtt_url')"
  export MQTT_USER="$(bashio::config 'mqtt_username')"
  export MQTT_PASS="$(bashio::config 'mqtt_password')"
elif bashio::services.available "mqtt"; then
  host="$(bashio::services mqtt 'host')"
  port="$(bashio::services mqtt 'port')"
  scheme="mqtt"
  if bashio::var.true "$(bashio::services mqtt 'ssl')"; then scheme="mqtts"; fi
  export MQTT_URL="${scheme}://${host}:${port}"
  export MQTT_USER="$(bashio::services mqtt 'username')"
  export MQTT_PASS="$(bashio::services mqtt 'password')"
  bashio::log.info "Using MQTT broker ${MQTT_URL} from the Supervisor."
else
  bashio::log.warning "No MQTT broker found. Install the Mosquitto broker app for PC agents."
fi

if bashio::config.has_value 'ai_provider'; then
  export AI_PROVIDER="$(bashio::config 'ai_provider')"
  bashio::config.has_value 'ai_model' && export AI_MODEL="$(bashio::config 'ai_model')"
  bashio::config.has_value 'ai_base_url' && export AI_BASE_URL="$(bashio::config 'ai_base_url')"
  bashio::config.has_value 'ai_api_key' && export AI_API_KEY="$(bashio::config 'ai_api_key')"
fi

export LOG_LEVEL="$(bashio::config 'log_level' 'info')"

bashio::log.info "Starting HomePanel on port ${PORT}"
exec node /app/dist/index.js
