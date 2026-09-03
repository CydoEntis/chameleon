#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import {
  buildDoctorReport,
  describeDoctorActions,
  installNerdFont,
  installOhMyPosh,
  loadAllThemePacks,
  setDefaultFontFace,
  VERSION,
  type DoctorAction,
  type DoctorReport,
  type LoadedThemePack,
  type TargetDoctorStatus,
} from "./index.js";

/** One line of `ch list` output — plain text, no Nerd Font glyph, so it reads before a font is set up. */
function formatPackLine(loaded: LoadedThemePack): string {
  return `${loaded.pack.manifest.slug}  ${loaded.pack.manifest.name}  (${loaded.origin})`;
}

/** One line of `ch doctor`'s target report. Plain text, no glyph — see CLAUDE.md, "Terminal output must read without a Nerd Font installed." */
function formatTargetLine(status: TargetDoctorStatus): string {
  return `${status.target}: ${status.isInstalled ? "installed" : "not found"}`;
}

/**
 * `ch doctor`'s Nerd Font lines — one summary line, plus a second line
 * naming the exact setting to change when the font is on the machine but
 * Windows Terminal is not pointed at it. See CLAUDE.md, "Catches a Nerd
 * Font that is installed but not selected, and names the exact setting to
 * change."
 */
function formatNerdFontLines(report: DoctorReport): string[] {
  const { nerdFont } = report;
  if (!nerdFont.isInstalled) {
    return ["nerd font: not found"];
  }
  if (nerdFont.isSelected) {
    return [`nerd font: installed and selected (${String(nerdFont.selectedFontFace)})`];
  }
  const currentFace = nerdFont.selectedFontFace ? `"${nerdFont.selectedFontFace}"` : "nothing";
  return [
    "nerd font: installed, but not selected",
    `  Windows Terminal's profiles.defaults.fontFace is set to ${currentFace} — not a Nerd Font.`,
  ];
}

/** The [y/N]-style question this action's own fix or install is offered behind — never run without it, see CLAUDE.md, "run only on explicit confirmation." */
function formatActionPrompt(action: DoctorAction): string {
  const command = action.commandLine ? ` (runs: ${action.commandLine})` : "";
  return `${action.description}${command}? [y/N] `;
}

/** Runs the one adapter export each doctor action kind maps to — see describeDoctorActions for why this is plain data instead of a closure the library hands back. */
function runDoctorAction(action: DoctorAction): void {
  switch (action.kind) {
    case "install-oh-my-posh":
      installOhMyPosh();
      return;
    case "install-nerd-font":
      installNerdFont();
      return;
    case "select-nerd-font":
      if (action.fontFamilyName) {
        setDefaultFontFace(action.fontFamilyName);
      }
      return;
  }
}

/**
 * Reports every target's state and the Nerd Font check, then offers to
 * close each gap it can — one at a time, run only once the user answers
 * "y". A gap Chameleon cannot or should not close on its own (Herdr is
 * never installed, see CLAUDE.md's "Out of scope") is reported and skipped
 * silently. Nothing here throws for a missing target — see
 * CLAUDE.md, "Never hard-fails because something is missing."
 */
async function runDoctor(): Promise<number> {
  const report = buildDoctorReport();

  for (const status of report.targets) {
    process.stdout.write(`${formatTargetLine(status)}\n`);
  }
  for (const line of formatNerdFontLines(report)) {
    process.stdout.write(`${line}\n`);
  }

  const actions = describeDoctorActions(report);
  if (actions.length === 0) {
    return 0;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const action of actions) {
      const answer = (await rl.question(`\n${formatActionPrompt(action)}`)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        continue;
      }
      try {
        runDoctorAction(action);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    rl.close();
  }

  return 0;
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
 * package is installable end to end. Async because `doctor` prompts on
 * stdin before it will run an install.
 */
async function main(argv: string[]): Promise<number> {
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

main(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
