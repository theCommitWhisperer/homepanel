/**
 * Read-only system check shown when the HomePanel window opens (UI-CONTRACT.md "Pre-checks").
 * Every probe goes through PrecheckEnv so the checks and the recommendation are unit-testable.
 */
import type { TaskInfo, ServiceInfo } from "../local/ops.js";
import type { SecretsFile, SetupState } from "../state.js";

export type CheckState = "ok" | "warn" | "fail" | "info" | "running";
export type CheckGroup = "pc" | "ha" | "homepanel" | "sensors";
export type ModeId = "host" | "join" | "ha" | "move";

export interface Fix {
  label: string;
  /** start this setup mode … */
  mode?: ModeId;
  /** … at this step */
  fromStep?: string;
  /** a safe control action: "<item>/<op>" → POST /api/control/<item>/<op> (e.g. "agent/restart") */
  action?: string;
  /** a page to open */
  href?: string;
}

export interface Check {
  id: string;
  /** which box the UI puts it in: This PC · Home Assistant · HomePanel · Sensors */
  group: CheckGroup;
  label: string;
  state: CheckState;
  detail: string;
  fix?: Fix;
}

export interface Recommendation {
  mode: ModeId | "control" | "done";
  /** start the mode at this step (UI passes it to POST /api/setup/start) */
  fromStep?: string;
  title: string;
  why: string;
  then?: string;
}

export interface PrecheckResult {
  checks: Check[];
  recommendation: Recommendation;
}

export type AppState = "running" | "stopped" | "missing" | "unknown";

export interface HaDetails {
  version?: string;
  /** HA OS / Supervised: apps (add-ons) available */
  haOs: boolean;
  /** installed apps (undefined when the Supervisor could not be asked) */
  addons?: { slug: string; state: string; version?: string }[];
  /** ZHA: config entry loaded / a discovered flow waits / nothing */
  zha: "loaded" | "discovered" | "none" | "unknown";
  error?: string;
}

export interface FoundHa {
  url: string;
  status: "onboarding" | "onboarded" | "preparing" | "unreachable";
  name?: string;
  version?: string;
}

export interface LanScan {
  /** hosts answering on :8006 that look like Proxmox */
  proxmox: string[];
  /** HomePanel servers (http://ip:8080) answering /api/health, other than this PC */
  homepanel: string[];
}

export interface PrecheckEnv {
  platform: NodeJS.Platform;
  osInfo(): Promise<{ name: string; build?: number }>;
  isElevated(): Promise<boolean>;
  wingetPresent(): Promise<boolean>;
  net(): { ip?: string; mac?: string; hostname: string };
  /** Windows network profile of the main connection (Private/Public/DomainAuthenticated) */
  networkCategory(): Promise<string>;
  internet(): Promise<boolean>;
  /** "Host / Join this PC" state (%ProgramData%\HomePanel\setup) */
  localSaved(): { state: SetupState; secrets: SecretsFile };
  /** Home Assistant wizard state (~/.homepanel) */
  haSaved(): { state: SetupState; secrets: SecretsFile };
  /** mDNS + homeassistant.local + extra addresses, each on :8123 and :80 */
  findHa(extra: string[]): Promise<FoundHa[]>;
  haPreparingProgress(url: string): Promise<string | undefined>;
  haTokenValid(url: string, token: string): Promise<boolean>;
  haDetails(url: string, token: string): Promise<HaDetails>;
  serverHealth(url: string): Promise<{ ok: boolean; version?: string; mqtt?: string; ha?: string } | undefined>;
  /** status of pcId on its server via the admin API; "unregistered" when the server does not know it */
  agentStatusAdmin(serverUrl: string, adminPassword: string, pcId: string): Promise<"online" | "offline" | "never-seen" | "unregistered" | undefined>;
  /** retained homepanel/agent/<pcId>/status */
  agentStatusMqtt(mqttUrl: string, user: string, pass: string, pcId: string): Promise<"online" | "offline" | undefined>;
  taskInfo(name: string): Promise<TaskInfo>;
  serviceInfo(name: string): Promise<ServiceInfo>;
  /** LibreHardwareMonitor web server: answering + number of sensors */
  lhm(): Promise<{ ok: boolean; count: number }>;
  /** ZBT-1 plugged into THIS PC (undefined = can't tell) */
  usbZbt1(): Promise<boolean | undefined>;
  scanLan(ip: string): Promise<LanScan>;
}

/** What the checks found, in a form the recommendation can reason about. */
export interface Facts {
  platform: NodeJS.Platform;
  local: {
    mode?: "host" | "join";
    movedFrom?: string;
    serverUrl?: string;
    pcId?: string;
  };
  tasks: { server: AppState; agent: AppState; sensors: AppState; tray: AppState };
  mosquittoService: AppState;
  localServer?: { ok: boolean; version?: string };
  /** the Home Assistant we picked (found, or saved but not answering) */
  ha?: {
    url: string;
    status: FoundHa["status"];
    version?: string;
    token: "valid" | "invalid" | "none" | "unknown";
    haOs?: boolean;
    mosquitto: AppState;
    homepanelApp: AppState;
    homepanelHealth?: boolean;
    homepanelUrl: string;
    zha: HaDetails["zha"];
  };
  agent: "online" | "offline" | "unregistered" | "unknown" | "none";
  lhm?: { ok: boolean; count: number };
  lan: LanScan;
}
