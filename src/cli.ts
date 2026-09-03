#!/usr/bin/env node
import { loadAllThemePacks, runDoctorChecks, VERSION, type DoctorNerdFontCheck, type LoadedThemePack } from "./index.js";

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

/** One `ch doctor` row for a themeable target: plain text, no Nerd Font glyph, so it reads before a font is set up. */
function formatTargetLine(target: string, isInstalled: boolean): string {
  return `${target}: ${isInstalled ? "installed" : "not found"}`;
}

/**
 * The Nerd Font row is three distinct cases, not two — installed-and-selected,
 * installed-but-not-selected, and not-installed-at-all — because installed
 * and selected answer different questions. See CLAUDE.md, "The distinction
 * between a font being installed and being selected — the whole point of
 * the ticket."
 */
function formatNerdFontLine(nerdFont: DoctorNerdFontCheck): string {
  if (!nerdFont.isInstalled) return "nerd font: not found";
  if (!nerdFont.isSelected) {
    return "nerd font: installed, not selected — set profiles.defaults.font.face (or the legacy profiles.defaults.fontFace) in Windows Terminal's settings.json";
  }
  return `nerd font: installed and selected (${nerdFont.selectedFontFace})`;
}

/**
 * Reports what is installed, what is missing, and the one-line command that
 * would install each gap — never runs an installer itself, so there is
 * nothing here that blocks on a prompt stdin cannot answer. See CLAUDE.md,
 * "Delegating installs to winget / oh-my-posh font install rather than
 * reimplementing an installer."
 */
function runDoctor(): number {
  const report = runDoctorChecks();

  for (const check of report.targets) {
    process.stdout.write(`${formatTargetLine(check.target, check.isInstalled)}\n`);
    if (check.installCommand) {
      process.stdout.write(`  would run: ${check.installCommand}\n`);
    }
  }

  process.stdout.write(`${formatNerdFontLine(report.nerdFont)}\n`);
  if (report.nerdFont.installCommand) {
    process.stdout.write(`  would run: ${report.nerdFont.installCommand}\n`);
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
  if (argv[0] === "doctor") {
    return runDoctor();
  }
  process.stdout.write("chameleon: no commands yet\n");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
