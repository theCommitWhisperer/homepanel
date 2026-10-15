/** Command-line parsing for HomePanel.exe (no side effects; see main.ts). */
import { VERSION } from "./version.js";

export const HELP = `HomePanel ${VERSION}

Usage:
  HomePanel                        open the HomePanel window (system check, setup, control)
  HomePanel ui [--no-open] [--view setup|control]
                                   the same window; --no-open prints its address instead
  HomePanel tray                   tray icon + window server (started at logon by setup)
  HomePanel setup --console        the terminal setup wizard (host, join, Home Assistant, move)
  HomePanel setup [options]        terminal setup with options, e.g. --mode host --yes
  HomePanel doctor                 check Home Assistant, MQTT, the server and PC agents
  HomePanel host-key <ip>          show a host's SSH key fingerprint (Proxmox setup asks you to trust it)
  HomePanel server [--demo]        run the HomePanel server (port 8080; --demo = fake devices)
  HomePanel agent <command>        PC agent: run, list-sensors, test-action, init, check-config
  HomePanel --version | --help

Examples:
  HomePanel server --demo          then open http://localhost:8080/?token=demo
  HomePanel agent list-sensors     show this PC's temperatures (needs LibreHardwareMonitor)
  HomePanel agent help             all agent options
`;

/** Installer subcommands passed straight through. */
const INSTALLER_COMMANDS = new Set(["setup", "doctor", "steps", "screens", "agent-key", "host-key", "ha-address"]);

export type Plan =
  | { kind: "ui"; argv: string[]; doubleClick: boolean }
  | { kind: "tray"; argv: string[] }
  | { kind: "installer"; argv: string[] }
  | { kind: "server"; argv: string[] }
  | { kind: "agent"; argv: string[] }
  | { kind: "print"; text: string; code: number };

export function plan(argv: string[]): Plan {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) return { kind: "ui", argv: [], doubleClick: true };
  if (cmd === "ui") return { kind: "ui", argv: rest, doubleClick: false };
  if (cmd === "tray") return { kind: "tray", argv: rest };
  // `setup --console` = the terminal wizard (same as plain `setup`; the flag just says so)
  if (cmd === "setup") return { kind: "installer", argv: ["setup", ...rest.filter((a) => a !== "--console")] };
  if (cmd === "--version" || cmd === "-v" || cmd === "version") return { kind: "print", text: VERSION, code: 0 };
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return { kind: "print", text: HELP, code: 0 };
  if (INSTALLER_COMMANDS.has(cmd)) return { kind: "installer", argv };
  if (cmd === "server") return { kind: "server", argv: rest };
  if (cmd === "agent") return { kind: "agent", argv: rest.length ? rest : ["help"] };
  return { kind: "print", text: `Unknown command "${cmd}".\n\n${HELP}`, code: 2 };
}
