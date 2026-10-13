/** Command-line parsing for HomePanel.exe (no side effects; see main.ts). */
import { VERSION } from "./version.js";

export const HELP = `HomePanel ${VERSION}

Usage:
  HomePanel                        start the setup wizard (same as "HomePanel setup")
  HomePanel setup [options]        set up this PC: host the server, join a PC, or set up Home Assistant
  HomePanel doctor                 check Home Assistant, MQTT, the server and PC agents
  HomePanel server [--demo]        run the HomePanel server (port 8080; --demo = fake devices)
  HomePanel agent <command>        PC agent: run, list-sensors, test-action, init, check-config
  HomePanel --version | --help

Examples:
  HomePanel server --demo          then open http://localhost:8080/?token=demo
  HomePanel agent list-sensors     show this PC's temperatures (needs LibreHardwareMonitor)
  HomePanel agent help             all agent options
`;

/** Installer subcommands passed straight through. */
const INSTALLER_COMMANDS = new Set(["setup", "doctor", "steps", "screens", "agent-key"]);

export type Plan =
  | { kind: "installer"; argv: string[] }
  | { kind: "server"; argv: string[] }
  | { kind: "agent"; argv: string[] }
  | { kind: "print"; text: string; code: number };

export function plan(argv: string[]): Plan {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) return { kind: "installer", argv: ["setup"] };
  if (cmd === "--version" || cmd === "-v" || cmd === "version") return { kind: "print", text: VERSION, code: 0 };
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return { kind: "print", text: HELP, code: 0 };
  if (INSTALLER_COMMANDS.has(cmd)) return { kind: "installer", argv };
  if (cmd === "server") return { kind: "server", argv: rest };
  if (cmd === "agent") return { kind: "agent", argv: rest.length ? rest : ["help"] };
  return { kind: "print", text: `Unknown command "${cmd}".\n\n${HELP}`, code: 2 };
}
