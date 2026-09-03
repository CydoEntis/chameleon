#!/usr/bin/env node
import { VERSION } from "./index.js";

/**
 * Entry point. Argument parsing and the command table land with the tickets
 * that add real commands; for now this exists so `bin` resolves and the
 * package is installable end to end.
 */
function main(argv: string[]): number {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  process.stdout.write("chameleon: no commands yet\n");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
