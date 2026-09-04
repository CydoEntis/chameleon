#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import {
  addSegment,
  applyThemePack,
  buildLayoutSegment,
  currentPack,
  findFamilySibling,
  isKnownRole,
  isSegmentType,
  layoutBlocksOnSide,
  loadAllThemePacks,
  moveSegmentBetweenBlocks,
  nextPackSlug,
  readOhMyPoshLayout,
  removeSegment,
  reorderSegment,
  ROLES,
  runDoctorChecks,
  SEGMENT_TYPES,
  undoAppliedPack,
  VERSION,
  writeOhMyPoshLayout,
  type Appearance,
  type DoctorNerdFontCheck,
  type Layout,
  type LayoutBlockName,
  type LoadedThemePack,
  type PackActionResult,
  type Role,
  type SegmentType,
} from "./index.js";

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

/** The value following `flagName` in `args` — `ch edit`'s own flag values are always a single token, so this is all the parsing this command needs. */
function flagValue(args: readonly string[], flagName: string): string | undefined {
  const flagIndex = args.indexOf(flagName);
  return flagIndex === -1 ? undefined : args[flagIndex + 1];
}

function requireFlagValue(args: readonly string[], flagName: string): string {
  const value = flagValue(args, flagName);
  if (value === undefined) {
    throw new Error(`ch edit: missing required ${flagName} flag`);
  }
  return value;
}

/** Parses `flagName`'s value as "left" or "right" — the two blocks CHM-8 lets `ch edit` move a segment between. */
function parseBlockName(args: readonly string[], flagName: string): LayoutBlockName {
  const rawValue = requireFlagValue(args, flagName);
  if (rawValue !== "left" && rawValue !== "right") {
    throw new Error(`ch edit: ${flagName} must be "left" or "right", got "${rawValue}"`);
  }
  return rawValue;
}

/** Parses `flagName`'s value as one of Chameleon's roles — never a hex colour, which is the whole point of CHM-8's "users pick roles, never hex." */
function parseRole(args: readonly string[], flagName: string): Role {
  const rawValue = requireFlagValue(args, flagName);
  if (!isKnownRole(rawValue)) {
    throw new Error(`ch edit: unknown role "${rawValue}" for ${flagName} — pick one of: ${ROLES.join(", ")}`);
  }
  return rawValue;
}

function parseOptionalRole(args: readonly string[], flagName: string): Role | undefined {
  return flagValue(args, flagName) === undefined ? undefined : parseRole(args, flagName);
}

/** Parses `--type`'s value as one of the standard Oh My Posh segment types CHM-8's "add" offers. */
function parseSegmentType(args: readonly string[]): SegmentType {
  const rawValue = requireFlagValue(args, "--type");
  if (!isSegmentType(rawValue)) {
    throw new Error(`ch edit: unknown segment type "${rawValue}" — pick one of: ${SEGMENT_TYPES.join(", ")}`);
  }
  return rawValue;
}

function parseIndex(args: readonly string[], flagName: string): number {
  const rawValue = requireFlagValue(args, flagName);
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`ch edit: ${flagName} must be a whole number, got "${rawValue}"`);
  }
  return parsedValue;
}

function parseOptionalIndex(args: readonly string[], flagName: string): number | undefined {
  return flagValue(args, flagName) === undefined ? undefined : parseIndex(args, flagName);
}

/**
 * `flagName`'s value as a block index, defaulting to 0 when omitted — but
 * only when that leaves no ambiguity: a side with at most one block still
 * resolves without it, while a side carrying more than one requires the
 * flag by name, naming the count. See CHM-16's "operates on a config with
 * multiple blocks per side, addressing them unambiguously" — a config like
 * the real "chips" theme, which carries two "left" blocks, must not have
 * `ch edit` silently guess which one a bare `--block left` means.
 */
function parseBlockIndex(args: readonly string[], layout: Layout, alignment: LayoutBlockName, flagName: string): number {
  const rawValue = flagValue(args, flagName);
  if (rawValue === undefined) {
    const existingBlockCount = layoutBlocksOnSide(layout, alignment).length;
    if (existingBlockCount > 1) {
      throw new Error(`ch edit: the "${alignment}" side has ${existingBlockCount} blocks — specify ${flagName} to pick one`);
    }
    return 0;
  }
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`ch edit: ${flagName} must be a whole number, got "${rawValue}"`);
  }
  return parsedValue;
}

/** `ch edit add --block <left|right> [--block-index <n>] --type <type> --foreground <role> [--background <role>] [--at <index>]` — appends by default, inserts at `--at` when given. */
function runEditAdd(args: readonly string[]): number {
  const block = parseBlockName(args, "--block");
  const segmentType = parseSegmentType(args);
  const foregroundRole = parseRole(args, "--foreground");
  const backgroundRole = parseOptionalRole(args, "--background");
  const atIndex = parseOptionalIndex(args, "--at");

  const layout = readOhMyPoshLayout();
  const blockIndex = parseBlockIndex(args, layout, block, "--block-index");
  const segment = buildLayoutSegment(segmentType, foregroundRole, backgroundRole);
  writeOhMyPoshLayout(addSegment(layout, block, blockIndex, segment, atIndex));
  process.stdout.write(`added ${segmentType} to block ${blockIndex} of the ${block} side\n`);
  return 0;
}

/** `ch edit remove --block <left|right> [--block-index <n>] --at <index>` */
function runEditRemove(args: readonly string[]): number {
  const block = parseBlockName(args, "--block");
  const atIndex = parseIndex(args, "--at");

  const layout = readOhMyPoshLayout();
  const blockIndex = parseBlockIndex(args, layout, block, "--block-index");
  writeOhMyPoshLayout(removeSegment(layout, block, blockIndex, atIndex));
  process.stdout.write(`removed segment ${atIndex} from block ${blockIndex} of the ${block} side\n`);
  return 0;
}

/** `ch edit reorder --block <left|right> [--block-index <n>] --from <index> --to <index>` */
function runEditReorder(args: readonly string[]): number {
  const block = parseBlockName(args, "--block");
  const fromIndex = parseIndex(args, "--from");
  const toIndex = parseIndex(args, "--to");

  const layout = readOhMyPoshLayout();
  const blockIndex = parseBlockIndex(args, layout, block, "--block-index");
  writeOhMyPoshLayout(reorderSegment(layout, block, blockIndex, fromIndex, toIndex));
  process.stdout.write(`moved segment ${fromIndex} to ${toIndex} in block ${blockIndex} of the ${block} side\n`);
  return 0;
}

/**
 * `ch edit move --from-block <left|right> [--from-block-index <n>] --at <index>
 * --to-block <left|right> [--to-block-index <n>] [--to <index>]` — the one
 * command that crosses a segment between the prompt and the status line, or
 * between two blocks on the same side.
 */
function runEditMove(args: readonly string[]): number {
  const fromBlock = parseBlockName(args, "--from-block");
  const atIndex = parseIndex(args, "--at");
  const toBlock = parseBlockName(args, "--to-block");
  const toIndex = parseOptionalIndex(args, "--to");

  const layout = readOhMyPoshLayout();
  const fromBlockIndex = parseBlockIndex(args, layout, fromBlock, "--from-block-index");
  const toBlockIndex = parseBlockIndex(args, layout, toBlock, "--to-block-index");
  writeOhMyPoshLayout(moveSegmentBetweenBlocks(layout, fromBlock, fromBlockIndex, atIndex, toBlock, toBlockIndex, toIndex));
  process.stdout.write(
    `moved segment ${atIndex} from block ${fromBlockIndex} of the ${fromBlock} side to block ${toBlockIndex} of the ${toBlock} side\n`,
  );
  return 0;
}

/**
 * `ch edit` — add, remove, reorder and move a segment between the left
 * prompt block and the right-hand status line. Every error this or a
 * subcommand throws — a bad flag, an undefined role, an out-of-range index —
 * is reported by message on stderr rather than as an uncaught crash, since
 * every one of them is a user mistake to correct, not a bug in Chameleon.
 */
function runEdit(argv: string[]): number {
  const [subcommand, ...rest] = argv;
  try {
    if (subcommand === "add") return runEditAdd(rest);
    if (subcommand === "remove") return runEditRemove(rest);
    if (subcommand === "reorder") return runEditReorder(rest);
    if (subcommand === "move") return runEditMove(rest);
    process.stderr.write("ch edit: unknown subcommand — use add, remove, reorder or move\n");
    return 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** One line of `ch <slug>`/`ch undo`'s per-target report — plain text, no Nerd Font glyph. */
function formatPackActionLine(result: PackActionResult): string {
  if (result.status === "applied") return `${result.target}: applied`;
  if (result.status === "restored") return `${result.target}: restored`;
  if (result.status === "skipped") return `${result.target}: skipped (${result.detail})`;
  return `${result.target}: failed — ${result.detail}`;
}

/** Prints one line per target — a failure on stderr, everything else on stdout — so a script can tell success from failure without parsing text. */
function printPackActionResults(results: readonly PackActionResult[]): void {
  for (const result of results) {
    const line = formatPackActionLine(result);
    if (result.status === "failed") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}

function hasFailure(results: readonly PackActionResult[]): boolean {
  return results.some((result) => result.status === "failed");
}

/**
 * `ch <slug>` — applies that pack to every detected target, reporting per
 * target what changed. A target that is absent is skipped, never a failure;
 * this only returns non-zero when a target that *is* installed threw.
 */
function runApply(slug: string): number {
  try {
    const report = applyThemePack(slug);
    process.stdout.write(`applied ${report.slug}\n`);
    printPackActionResults(report.results);
    return hasFailure(report.results) ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** `ch undo` — restores every detected target from the backup its own adapter's most recent apply wrote. */
function runUndo(): number {
  try {
    const results = undoAppliedPack();
    printPackActionResults(results);
    return hasFailure(results) ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** `ch next` — cycles to the next pack in `ch list` order, wrapping past the end, and applies it. */
function runNext(): number {
  try {
    return runApply(nextPackSlug());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * `ch dark` / `ch light` — switches to the active pack's sibling in the same
 * family. A family with no sibling in that mode never fails silently: it
 * names the nearest alternative instead, or says plainly that none exists.
 */
function runFamilySwitch(appearance: Appearance): number {
  try {
    const result = findFamilySibling(appearance);
    if (result.siblingSlug) {
      return runApply(result.siblingSlug);
    }
    if (result.nearestAlternativeSlug) {
      process.stderr.write(`"${result.family}" has no ${appearance} pack — try \`ch ${result.nearestAlternativeSlug}\`\n`);
    } else {
      process.stderr.write(`"${result.family}" has no ${appearance} pack, and no ${appearance} pack is available at all\n`);
    }
    return 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** `ch current [--short]` — prints the active pack's slug, or just its name with `--short`, for embedding in a status bar. */
function runCurrent(args: readonly string[]): number {
  const current = currentPack();
  if (!current) {
    process.stderr.write("ch current: no pack has been applied yet\n");
    return 1;
  }
  const showNameOnly = args.includes("--short");
  process.stdout.write(`${showNameOnly ? (current.name ?? current.slug) : current.slug}\n`);
  return 0;
}

/** Prompts interactively for a pack to apply: a numbered list, then a free-form answer of either the number or the slug directly. Empty input picks nothing. */
async function promptForPackSlug(packs: readonly LoadedThemePack[]): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    packs.forEach((loaded, index) => process.stdout.write(`${index + 1}) ${formatPackLine(loaded)}\n`));
    const answer = (await rl.question("Apply which pack (number or slug)? ")).trim();
    if (answer === "") return undefined;

    const chosenIndex = Number(answer);
    if (Number.isInteger(chosenIndex) && chosenIndex >= 1 && chosenIndex <= packs.length) {
      return packs[chosenIndex - 1]!.pack.manifest.slug;
    }
    return answer;
  } finally {
    rl.close();
  }
}

/**
 * `ch` with no argument — picks a pack interactively. When stdin is not a
 * TTY there is nobody to answer a prompt, so this prints the same list
 * `ch list` would and exits, rather than blocking on a read that would never
 * resolve.
 */
async function runPick(): Promise<number> {
  const { packs, warnings } = loadAllThemePacks();
  for (const warning of warnings) {
    process.stderr.write(`${warning}\n`);
  }

  if (!process.stdin.isTTY) {
    for (const loaded of packs) {
      process.stdout.write(`${formatPackLine(loaded)}\n`);
    }
    return 0;
  }

  const chosenSlug = await promptForPackSlug(packs);
  if (chosenSlug === undefined) {
    process.stderr.write("ch: no pack chosen\n");
    return 1;
  }
  return runApply(chosenSlug);
}

/**
 * Entry point: `ch <slug>` applies that pack; `ch` with no argument picks
 * one interactively; the rest are the named commands below. An argument
 * that matches none of them is tried as a pack slug, so `ch catppuccin-dark`
 * needs no verb of its own.
 */
async function main(argv: string[]): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const [command, ...rest] = argv;
  if (command === undefined) return runPick();
  if (command === "list") return runList();
  if (command === "doctor") return runDoctor();
  if (command === "edit") return runEdit(rest);
  if (command === "current") return runCurrent(rest);
  if (command === "undo") return runUndo();
  if (command === "next") return runNext();
  if (command === "dark") return runFamilySwitch("dark");
  if (command === "light") return runFamilySwitch("light");
  return runApply(command);
}

main(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
