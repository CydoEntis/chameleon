#!/usr/bin/env node
import {
  addSegment,
  buildLayoutSegment,
  isKnownRole,
  isSegmentType,
  layoutBlocksOnSide,
  loadAllThemePacks,
  moveSegmentBetweenBlocks,
  readOhMyPoshLayout,
  removeSegment,
  reorderSegment,
  ROLES,
  runDoctorChecks,
  SEGMENT_TYPES,
  VERSION,
  writeOhMyPoshLayout,
  type DoctorNerdFontCheck,
  type Layout,
  type LayoutBlockName,
  type LoadedThemePack,
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
  if (argv[0] === "edit") {
    return runEdit(argv.slice(1));
  }
  process.stdout.write("chameleon: no commands yet\n");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
