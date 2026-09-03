#!/usr/bin/env node
import { loadAllThemePacks, VERSION, type LoadedThemePack } from "./index.js";

/** One line of `ch list` output — plain text, no Nerd Font glyph, so it reads before a font is set up. */
function formatPackLine(loaded: LoadedThemePack): string {
  return `${loaded.pack.manifest.slug}  ${loaded.pack.manifest.name}  (${loaded.origin})`;
}

/**
 * Lists every pack `ch` can apply right now: the bundled library plus
 * anything dropped into the user's own theme directory, each line marked
 * with its origin, and a pack that overrides a bundled one shown only once
 * — see CLAUDE.md, "ch list shows bundled and user packs together, marking
 * which is which." A malformed user pack is reported by name on stderr and
 * does not stop the rest of the list from printing.
 */
function runList(): number {
  const { packs, warnings } = loadAllThemePacks();
  for (const warning of warnings) {
    process.stderr.write(`${warning}\n`);
  }
  for (const loaded of packs) {
    process.stdout.write(`${formatPackLine(loaded)}\n`);
  }
  return 0;
}

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
  if (argv[0] === "list") {
    return runList();
  }
  process.stdout.write("chameleon: no commands yet\n");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
