/**
 * homepanel-agent — command line entry. All logic lives in main.ts.
 *
 *   homepanel-agent run [--config f] [--mock] [--dry-run] [--supervise]
 *   homepanel-agent list-sensors [--all] [--json] [--mock]
 *   homepanel-agent test-action <id> [--really]
 *   homepanel-agent init [--pc-id x --name x --mqtt-url x --mqtt-user x --mqtt-pass x --key x] [--force]
 *   homepanel-agent check-config | config-path | version
 */
import { main } from "./main.js";

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
