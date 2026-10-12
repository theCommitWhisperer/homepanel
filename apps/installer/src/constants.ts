/**
 * Things that change over time. Update here; nothing else hard-codes them.
 * Last checked: October 2026.
 */
export const HAOS_VERSION = "18.3";
const REL = `https://github.com/home-assistant/operating-system/releases/download/${HAOS_VERSION}`;
export const HAOS_IMAGES = {
  /** Intel/AMD bare metal (ACEMAGICIAN T8 Plus, NUCs, other mini PCs) */
  genericX86: `${REL}/haos_generic-x86-64-${HAOS_VERSION}.img.xz`,
  /** VirtualBox disk */
  vdi: `${REL}/haos_ova-${HAOS_VERSION}.vdi.zip`,
  /** Proxmox / KVM disk */
  qcow2: `${REL}/haos_ova-${HAOS_VERSION}.qcow2.xz`,
  rpi4: `${REL}/haos_rpi4-64-${HAOS_VERSION}.img.xz`,
  rpi5: `${REL}/haos_rpi5-64-${HAOS_VERSION}.img.xz`,
};

/**
 * Git URL of the HomePanel Home Assistant app (add-on) repository. HA needs repository.yaml at the
 * repo root, so deploy/ha-app is published as its own repo (placeholder URL until it exists —
 * override with HOMEPANEL_APP_REPO).
 */
export const HOMEPANEL_APP_REPO = process.env.HOMEPANEL_APP_REPO ?? "https://github.com/homepanel/homepanel-ha-app";
/** Slug HA gives a third-party app: <first 8 hex of sha1(repo url)>_homepanel; we look it up instead of guessing. */
export const HOMEPANEL_APP_SLUG_SUFFIX = "_homepanel";
/** Where the compose file can be downloaded if the installer runs outside a repo checkout. */
export const HOMEPANEL_RAW_BASE =
  process.env.HOMEPANEL_RAW_BASE ?? "https://raw.githubusercontent.com/homepanel/homepanel/main";

export const HA_PORT = 8123;
export const SERVER_PORT = 8080;
export const MQTT_PORT = 1883;

export const MOSQUITTO_SLUG = "core_mosquitto";
/** Community add-ons repository (hosts the Tailscale app, slug a0d7b954_tailscale). */
export const COMMUNITY_ADDONS_REPO = "https://github.com/hassio-addons/repository";
export const TAILSCALE_SLUG = "a0d7b954_tailscale";

export const MQTT_HA_USERNAME = "homepanel-mqtt";
export const MIN_DOCKER_ENGINE = 23;

export const DOCS_URL = "https://github.com/homepanel/homepanel/tree/main/docs";
