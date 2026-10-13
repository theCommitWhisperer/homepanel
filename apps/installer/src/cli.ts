#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`homepanel: ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
