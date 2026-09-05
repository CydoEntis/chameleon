#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { emitKeypressEvents, type Key } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  addSegment,
  ANSI_SLOT_NAMES,
  applyPromptPack,
  applyThemePack,
  buildLayoutSegment,
  createDefaultOhMyPoshAdapter,
  currentPack,
  currentPromptPack,
  didAnyTargetFail,
  findFamilySibling,
  isKnownRole,
  isSegmentType,
  layoutBlocksOnSide,
  listPromptPacks,
  loadAllThemePacks,
  moveSegmentBetweenBlocks,
  nextPackSlug,
  ohMyPoshMissingMessage,
  previewThemePackToFileTargets,
  prevPackSlug,
  readOhMyPoshLayout,
  removeSegment,
  reorderSegment,
  restorePromptToMine,
  ROLES,
  runDoctorChecks,
  SEGMENT_TYPES,
  undoAppliedPack,
  VERSION,
  writeOhMyPoshLayout,
  type AnsiSlotName,
  type Appearance,
  type CurrentPackReport,
  type CurrentPromptReport,
  type DoctorNerdFontCheck,
  type DoctorReport,
  type DoctorTargetCheck,
  type Layout,
  type LayoutBlockName,
  type LoadedThemePack,
  type PackActionResult,
  type PromptPackListEntry,
  type Role,
  type Scheme,
  type SegmentType,
  type Target,
} from "./index.js";

/**
 * One line of `chm themes` output: two colour swatches, then the name a
 * person actually reads — never the slug (CHM-42's "show the name, drop the
 * slug from the display"). Only a user pack carries a marker; the bundled
 * default gets none, since a tag on every row means nothing — see CLAUDE.md,
 * "Drop (bundled) entirely — it is the default and it is on every row."
 */
export function formatThemeLine(loaded: LoadedThemePack): string {
  const roleHexes = loaded.pack.payloads["oh-my-posh"];
  const userMarker = loaded.origin === "user" ? "  (user)" : "";
  return `${swatch(roleHexes.ground)}${swatch(roleHexes.accent)} ${loaded.pack.manifest.name}${userMarker}`;
}

/**
 * Prints one line per pack, in `chm themes`' own order: the plain,
 * scriptable form that `--list` forces and that a non-interactive terminal
 * or a pipe falls back to automatically.
 */
function printThemeList(packs: readonly LoadedThemePack[]): void {
  for (const loaded of packs) {
    process.stdout.write(`${formatThemeLine(loaded)}\n`);
  }
}

/**
 * One `chm doctor` row for a themeable target: plain text, no Nerd Font glyph,
 * so it reads before a font is set up. A target this platform cannot ever
 * have — Windows Terminal outside Windows — reads "not available on this
 * platform" rather than "not found": the latter would tell a Linux user a
 * Windows-only app is a problem to fix. See CHM-25.
 */
function formatTargetLine(check: DoctorTargetCheck): string {
  if (!check.isApplicable) return `${check.target}: not available on this platform`;
  return `${check.target}: ${check.isInstalled ? "installed" : "not found"}`;
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

/** Comma-joined target names, for a drift report — shared by `chm doctor` and `chm current`, see matchesVerbFor. */
function formatDriftedTargets(driftedTargets: readonly Target[]): string {
  return driftedTargets.join(", ");
}

/** "match"/"matches" agreeing with `driftedTargets`' count — the one piece of grammar both `chm doctor` and `chm current` need when reporting drift (CHM-27). */
function matchesVerbFor(driftedTargets: readonly Target[]): string {
  return driftedTargets.length === 1 ? "matches" : "match";
}

/**
 * Whether `report`'s recorded pack could not even be loaded — a slug the
 * state file still names, but that no longer resolves to a pack in the
 * library (deleted after being applied, say). `driftedTargets` comes back
 * empty in exactly this case too (see currentPack), since there is nothing
 * to compare against — but empty-because-nothing-was-checked and
 * empty-because-everything-matched are different facts, and CHM-34 is what
 * happens when `chm doctor`/`chm current` conflate them: they must never claim
 * a match for a comparison that never ran.
 */
function isPackUnloadable(report: CurrentPackReport): boolean {
  return report.name === undefined;
}

/**
 * `chm doctor`'s drift row: undefined when nothing has ever been applied —
 * there is nothing recorded to compare live configs against — "cannot
 * check" when the recorded pack no longer loads at all (CHM-34), "none"
 * when every detected target still matches the recorded pack, and otherwise
 * the targets that no longer do. See CHM-27: a partial apply that left
 * targets disagreeing must be visible here, not just at the moment it
 * happened.
 */
export function formatDriftLine(drift: DoctorReport["drift"]): string {
  if (!drift) return "drift: no pack has been applied yet — nothing to compare";
  if (isPackUnloadable(drift)) return `cannot check drift: pack "${drift.slug}" is no longer available`;
  if (drift.driftedTargets.length === 0) return `drift: none — every detected target matches "${drift.slug}"`;
  return `drift: ${formatDriftedTargets(drift.driftedTargets)} no longer ${matchesVerbFor(drift.driftedTargets)} "${drift.slug}"`;
}

/**
 * Whether `chm doctor`'s drift row should turn into a non-zero exit: either a
 * target no longer matches the recorded pack, or the recorded pack could not
 * be loaded at all, so the comparison never ran (CHM-34) — the exit code
 * must not read as success in a case that was never checked.
 */
export function hasDrift(drift: DoctorReport["drift"]): boolean {
  if (!drift) return false;
  return isPackUnloadable(drift) || drift.driftedTargets.length > 0;
}

/**
 * Reports what is installed, what is missing, and the one-line command that
 * would install each gap — never runs an installer itself, so there is
 * nothing here that blocks on a prompt stdin cannot answer. See CLAUDE.md,
 * "Delegating installs to winget / oh-my-posh font install rather than
 * reimplementing an installer." Also reports drift (CHM-27): a detected
 * target whose live config no longer matches the recorded pack is exactly
 * the state a partial apply can leave behind, and it must show up here even
 * when `chm current` was never run to notice it.
 */
function runDoctor(): number {
  const report = runDoctorChecks();

  for (const check of report.targets) {
    process.stdout.write(`${formatTargetLine(check)}\n`);
    if (check.installCommand) {
      process.stdout.write(`  would run: ${check.installCommand}\n`);
    }
    if (check.target === "claude-code" && check.isInstalled && report.claudeCodeTheme) {
      process.stdout.write(`  theme: ${report.claudeCodeTheme}\n`);
    }
  }

  process.stdout.write(`${formatNerdFontLine(report.nerdFont)}\n`);
  if (report.nerdFont.installCommand) {
    process.stdout.write(`  would run: ${report.nerdFont.installCommand}\n`);
  }

  process.stdout.write(`${formatDriftLine(report.drift)}\n`);
  return hasDrift(report.drift) ? 1 : 0;
}

/** The value following `flagName` in `args` — `chm edit`'s own flag values are always a single token, so this is all the parsing this command needs. */
function flagValue(args: readonly string[], flagName: string): string | undefined {
  const flagIndex = args.indexOf(flagName);
  return flagIndex === -1 ? undefined : args[flagIndex + 1];
}

function requireFlagValue(args: readonly string[], flagName: string): string {
  const value = flagValue(args, flagName);
  if (value === undefined) {
    throw new Error(`chm edit: missing required ${flagName} flag`);
  }
  return value;
}

/** Parses `flagName`'s value as "left" or "right" — the two blocks CHM-8 lets `chm edit` move a segment between. */
function parseBlockName(args: readonly string[], flagName: string): LayoutBlockName {
  const rawValue = requireFlagValue(args, flagName);
  if (rawValue !== "left" && rawValue !== "right") {
    throw new Error(`chm edit: ${flagName} must be "left" or "right", got "${rawValue}"`);
  }
  return rawValue;
}

/** Parses `flagName`'s value as one of Chameleon's roles — never a hex colour, which is the whole point of CHM-8's "users pick roles, never hex." */
function parseRole(args: readonly string[], flagName: string): Role {
  const rawValue = requireFlagValue(args, flagName);
  if (!isKnownRole(rawValue)) {
    throw new Error(`chm edit: unknown role "${rawValue}" for ${flagName} — pick one of: ${ROLES.join(", ")}`);
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
    throw new Error(`chm edit: unknown segment type "${rawValue}" — pick one of: ${SEGMENT_TYPES.join(", ")}`);
  }
  return rawValue;
}

function parseIndex(args: readonly string[], flagName: string): number {
  const rawValue = requireFlagValue(args, flagName);
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`chm edit: ${flagName} must be a whole number, got "${rawValue}"`);
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
 * `chm edit` silently guess which one a bare `--block left` means.
 */
function parseBlockIndex(args: readonly string[], layout: Layout, alignment: LayoutBlockName, flagName: string): number {
  const rawValue = flagValue(args, flagName);
  if (rawValue === undefined) {
    const existingBlockCount = layoutBlocksOnSide(layout, alignment).length;
    if (existingBlockCount > 1) {
      throw new Error(`chm edit: the "${alignment}" side has ${existingBlockCount} blocks — specify ${flagName} to pick one`);
    }
    return 0;
  }
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`chm edit: ${flagName} must be a whole number, got "${rawValue}"`);
  }
  return parsedValue;
}

/** `chm edit add --block <left|right> [--block-index <n>] --type <type> --foreground <role> [--background <role>] [--at <index>]` — appends by default, inserts at `--at` when given. */
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

/** `chm edit remove --block <left|right> [--block-index <n>] --at <index>` */
function runEditRemove(args: readonly string[]): number {
  const block = parseBlockName(args, "--block");
  const atIndex = parseIndex(args, "--at");

  const layout = readOhMyPoshLayout();
  const blockIndex = parseBlockIndex(args, layout, block, "--block-index");
  writeOhMyPoshLayout(removeSegment(layout, block, blockIndex, atIndex));
  process.stdout.write(`removed segment ${atIndex} from block ${blockIndex} of the ${block} side\n`);
  return 0;
}

/** `chm edit reorder --block <left|right> [--block-index <n>] --from <index> --to <index>` */
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
 * `chm edit move --from-block <left|right> [--from-block-index <n>] --at <index>
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
 * `chm edit` — add, remove, reorder and move a segment between the left
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
    process.stderr.write("chm edit: unknown subcommand — use add, remove, reorder or move\n");
    return 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * One line of `chm <theme>`/`chm undo`'s per-target report — plain text, no
 * Nerd Font glyph. An "applied" or "restored" result can still carry a
 * `detail` — CHM-39's profile-creation notice, or CHM-45's "Herdr is not
 * running, nothing to reload" — which is shown rather than dropped, since
 * both are exactly the kind of thing worth telling the user without
 * failing the command.
 */
function formatPackActionLine(result: PackActionResult): string {
  if (result.status === "applied") return result.detail ? `${result.target}: applied — ${result.detail}` : `${result.target}: applied`;
  if (result.status === "restored") return result.detail ? `${result.target}: restored — ${result.detail}` : `${result.target}: restored`;
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

/**
 * `chm <theme>` — applies that pack to every detected target, reporting per
 * target what changed. A target that is absent is skipped, never a failure;
 * this only returns non-zero when a target that *is* installed threw. A
 * failure never leaves the false impression `applied <slug>`'s own first
 * line might otherwise give — CHM-27 — so a partial result says so plainly,
 * on stderr, naming that the state file was left untouched.
 */
function runApply(slug: string): number {
  try {
    const report = applyThemePack(slug);
    process.stdout.write(`applied ${report.slug}\n`);
    printPackActionResults(report.results);
    if (!report.isFullyApplied) {
      process.stderr.write(
        `chm: ${report.slug} was only partially applied — the state file was left unchanged, and \`chm current\`/\`chm doctor\` may now report drift until this is fixed\n`,
      );
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** `chm undo` — restores every detected target from the backup its own adapter's most recent apply wrote. */
function runUndo(): number {
  try {
    const results = undoAppliedPack();
    printPackActionResults(results);
    return didAnyTargetFail(results) ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** `chm next` — cycles to the next pack in `chm themes` order, wrapping past the end, and applies it. */
function runNext(): number {
  try {
    return runApply(nextPackSlug());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** `chm prev` — the mirror of `chm next`: cycles to the previous pack in `chm themes` order, wrapping past the start, and applies it. */
function runPrev(): number {
  try {
    return runApply(prevPackSlug());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * `chm dark` / `chm light` — switches to the active pack's sibling in the same
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
      process.stderr.write(`"${result.family}" has no ${appearance} pack — try \`chm ${result.nearestAlternativeSlug}\`\n`);
    } else {
      process.stderr.write(`"${result.family}" has no ${appearance} pack, and no ${appearance} pack is available at all\n`);
    }
    return 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** `chm current`'s own prompt-layout line — CHM-47's "chm current reports the active prompt layout alongside the active theme." Printed only once a bundled layout has ever been applied at least once (currentPromptPack returning undefined); a machine that has never touched `chm prompt` has nothing new to report here. */
function formatPromptLine(promptReport: CurrentPromptReport): string {
  const label = promptReport.slug === undefined ? "mine" : (promptReport.name ?? promptReport.slug);
  return `prompt: ${label}`;
}

/**
 * `chm current [--short]` — prints the active pack's slug, or just its name
 * with `--short`, for embedding in a status bar. The slug always goes to
 * stdout even when drifted (CHM-27), so a script reading it still gets a
 * usable value; drift itself is a warning on stderr plus a non-zero exit,
 * the same "value on stdout, problem on stderr" split as `chm <theme>`'s own
 * per-target report.
 */
function runCurrent(args: readonly string[]): number {
  const current = currentPack();
  if (!current) {
    process.stderr.write("chm current: no pack has been applied yet\n");
    return 1;
  }
  const showNameOnly = args.includes("--short");
  process.stdout.write(`${showNameOnly ? (current.name ?? current.slug) : current.slug}\n`);

  const promptReport = currentPromptPack();
  if (promptReport) {
    process.stdout.write(`${formatPromptLine(promptReport)}\n`);
  }

  // CHM-34: the recorded pack itself is gone — there is nothing left to
  // compare live configs against, so this must say so rather than falling
  // through to the driftedTargets check below, which is empty for this
  // reason too and would otherwise read as a clean match.
  if (isPackUnloadable(current)) {
    process.stderr.write(`chm current: cannot check drift: pack "${current.slug}" is no longer available\n`);
    return 1;
  }

  if (current.driftedTargets.length > 0) {
    process.stderr.write(
      `chm current: drifted — ${formatDriftedTargets(current.driftedTargets)} no longer ${matchesVerbFor(current.driftedTargets)} "${current.slug}"\n`,
    );
    return 1;
  }
  return 0;
}

/** One picker row: enough to render a line with two colour swatches, filter it by slug or name, apply it, and preview it live. */
interface PickerEntry {
  readonly slug: string;
  readonly name: string;
  readonly origin: string;
  readonly groundHex: string;
  readonly accentHex: string;
  /** The full scheme this entry's live preview paints with escape codes (CHM-52) — never written to a config file until Enter commits. */
  readonly scheme: Scheme;
}

function toPickerEntry(loaded: LoadedThemePack): PickerEntry {
  const roleHexes = loaded.pack.payloads["oh-my-posh"];
  return {
    slug: loaded.pack.manifest.slug,
    name: loaded.pack.manifest.name,
    origin: loaded.origin,
    groundHex: roleHexes.ground,
    accentHex: roleHexes.accent,
    scheme: loaded.pack.payloads["windows-terminal"],
  };
}

// --- Live terminal preview (CHM-52) -----------------------------------------
//
// previewHighlighted() used to call applyThemePack on every arrow key — a
// full four-target apply, each target backed up and written to disk, ~324ms
// measured in-process. The picker's own preview only ever needs the
// *terminal* to repaint; nothing here is written to a file, and nothing here
// is undo-able, because nothing here is a config edit.

/** OSC 4's own palette index for each of the 16 ANSI slots, in the numbering every terminal shares — see ANSI_SLOT_NAMES. */
const OSC_PALETTE_INDEX_BY_SLOT: Readonly<Record<AnsiSlotName, number>> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  purple: 5,
  cyan: 6,
  white: 7,
  brightBlack: 8,
  brightRed: 9,
  brightGreen: 10,
  brightYellow: 11,
  brightBlue: 12,
  brightPurple: 13,
  brightCyan: 14,
  brightWhite: 15,
};

/** OSC codes for the terminal's own foreground, background and cursor colour — outside the 16 numbered ANSI slots (OSC 4) an application paints text with directly. */
const OSC_FOREGROUND_CODE = 10;
const OSC_BACKGROUND_CODE = 11;
const OSC_CURSOR_CODE = 12;

/** BEL — the OSC string terminator every terminal Chameleon targets accepts. The alternative, ST (`\x1b\\`), works too, but BEL is shorter and just as universal. */
const OSC_TERMINATOR = "\x07";

function oscSetPaletteColor(paletteIndex: number, hex: string): string {
  return `\x1b]4;${paletteIndex};${hex}${OSC_TERMINATOR}`;
}

function oscSetSpecialColor(oscCode: number, hex: string): string {
  return `\x1b]${oscCode};${hex}${OSC_TERMINATOR}`;
}

function oscResetPaletteColor(paletteIndex: number): string {
  return `\x1b]104;${paletteIndex}${OSC_TERMINATOR}`;
}

function oscResetSpecialColor(oscCode: number): string {
  return `\x1b]${oscCode}${OSC_TERMINATOR}`;
}

/**
 * Repaints the terminal's own colours instantly: OSC 4 sets the 16 ANSI
 * slots an application paints text with, OSC 10/11/12 set the foreground,
 * background and cursor outside any one of those slots. No config file is
 * touched and nothing here is written that `chm undo` would ever need to
 * know about — see CLAUDE.md's "Preview the terminal with escape sequences,
 * not file writes."
 */
export function buildTerminalPreviewSequence(scheme: Scheme): string {
  const paletteSequences = ANSI_SLOT_NAMES.map((slotName) => oscSetPaletteColor(OSC_PALETTE_INDEX_BY_SLOT[slotName], scheme[slotName]));
  return [
    ...paletteSequences,
    oscSetSpecialColor(OSC_FOREGROUND_CODE, scheme.foreground),
    oscSetSpecialColor(OSC_BACKGROUND_CODE, scheme.background),
    oscSetSpecialColor(OSC_CURSOR_CODE, scheme.cursorColor),
  ].join("");
}

/**
 * The reverse of buildTerminalPreviewSequence, for Esc when no pack was
 * active before the picker opened: resets every ANSI slot and the
 * foreground/background/cursor to the terminal's own configured colours
 * (OSC 104 and 110/111/112) rather than previewing a scheme that was never
 * actually applied. See runInteractivePicker's restoreTerminalPreview.
 */
export function buildTerminalResetSequence(): string {
  const paletteResets = ANSI_SLOT_NAMES.map((slotName) => oscResetPaletteColor(OSC_PALETTE_INDEX_BY_SLOT[slotName]));
  return [...paletteResets, oscResetSpecialColor(110), oscResetSpecialColor(111), oscResetSpecialColor(112)].join("");
}

/**
 * Idle delay, in ms, before a settled highlight triggers a real file write
 * for the targets a live terminal preview cannot reach — Herdr, Oh My Posh
 * and Claude Code all read their colours from a config file, never from the
 * terminal's own escape-sequence palette (see previewThemePackToFileTargets).
 * Long enough that holding an arrow key through the whole list costs one
 * file apply at the end, not one per row (CHM-52's "holding the key for 10
 * rows: 3.2s of frozen UI"); short enough that pausing on a row still writes
 * it within roughly the blink of an eye.
 */
const FILE_PREVIEW_DEBOUNCE_MS = 150;

/**
 * Schedules `applyToFileTargets` to run once movement settles, superseding
 * rather than queuing: calling `schedule` again before the pending one has
 * fired cancels it outright, so holding an arrow key through the whole list
 * costs one file apply, never one per row (CHM-52). `cancel` is what Enter
 * and Esc both call before they take over the final write themselves — a
 * settle firing after the picker has already closed would race whatever
 * commit or restore just ran.
 */
export function createSettledFileTargetPreview(
  applyToFileTargets: (slug: string) => void,
  debounceMs: number = FILE_PREVIEW_DEBOUNCE_MS,
): { schedule(slug: string): void; cancel(): void } {
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  function cancel(): void {
    if (pendingTimer === undefined) return;
    clearTimeout(pendingTimer);
    pendingTimer = undefined;
  }

  function schedule(slug: string): void {
    cancel();
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      applyToFileTargets(slug);
    }, debounceMs);
  }

  return { schedule, cancel };
}

const HEX_COLOR_PATTERN = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/**
 * Two spaces painted with `hex` as a background colour — a picker row's
 * swatch. This is deliberately a solid block of colour rather than a glyph:
 * see CLAUDE.md, "Terminal output must read without a Nerd Font installed."
 * The escape codes are plain ANSI 24-bit colour and cursor movement, nothing
 * Windows Terminal renders differently under cmd.exe, PowerShell or
 * git-bash — see CHM-24's "must not depend on a terminal feature only one
 * of them has."
 */
function swatch(hex: string): string {
  const channels = HEX_COLOR_PATTERN.exec(hex);
  if (!channels) return "  ";
  const [, redHex, greenHex, blueHex] = channels;
  const redChannel = Number.parseInt(redHex!, 16);
  const greenChannel = Number.parseInt(greenHex!, 16);
  const blueChannel = Number.parseInt(blueHex!, 16);
  return `\x1b[48;2;${redChannel};${greenChannel};${blueChannel}m  \x1b[0m`;
}

/** Whether `entry` matches the picker's type-to-filter text, by slug or by name — an empty filter matches everything. */
function matchesPickerFilter(entry: PickerEntry, filterText: string): boolean {
  if (filterText === "") return true;
  const needle = filterText.toLowerCase();
  return entry.slug.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle);
}

/** One picker row: swatches and the display name, matching `chm themes`' own formatting (CHM-42) — the slug stays typeable for the filter, but is never shown. */
function renderPickerRow(entry: PickerEntry, isHighlighted: boolean): string {
  const cursor = isHighlighted ? ">" : " ";
  const userMarker = entry.origin === "user" ? "  (user)" : "";
  return `${cursor} ${swatch(entry.groundHex)}${swatch(entry.accentHex)} ${entry.name}${userMarker}`;
}

const PICKER_HINT_LINE = "up/down move, type to filter, enter apply, esc cancel";

/** Every line of one picker frame: the hint or filter line, then one row per matching entry, or a plain "no matches" line when the filter matches nothing. */
function renderPickerFrame(entries: readonly PickerEntry[], highlightedIndex: number, filterText: string): string[] {
  const filterLine = filterText === "" ? PICKER_HINT_LINE : `filter: ${filterText}`;
  const rowLines =
    entries.length === 0 ? ["  no matches"] : entries.map((entry, index) => renderPickerRow(entry, index === highlightedIndex));
  return [filterLine, ...rowLines];
}

/** Moves the cursor back up over the previous frame and clears everything from there down, so redrawing never scrolls the screen. */
function clearPickerFrame(lineCount: number): void {
  if (lineCount === 0) return;
  process.stdout.write(`\x1b[${lineCount}A\x1b[0J`);
}

/**
 * Drives the arrow-key picker: renders the filtered list with colour
 * swatches, moves the highlight on the arrow keys, narrows the list as the
 * user types, and previews the highlighted pack immediately on every move —
 * see CHM-24's "applying as the cursor moves is the feature that makes this
 * tool worth using." CHM-52: that preview is now the terminal's own escape
 * codes (buildTerminalPreviewSequence), instant and file-free, plus a
 * debounced write for the three targets escape codes cannot reach
 * (previewThemePackToFileTargets) — never a synchronous four-target apply
 * per keystroke, and never anything Enter's own commit or Esc's own restore
 * has to race. Resolves to the slug Enter committed, or to `undefined` on
 * Esc/Ctrl-C, after restoring `originalSlug` (or undoing every target's
 * change, when nothing was active before the picker opened) and restoring
 * the terminal's own colours the same way — see restoreTerminalPreview.
 */
async function runInteractivePicker(packs: readonly LoadedThemePack[], originalSlug: string | undefined): Promise<string | undefined> {
  const allEntries = packs.map(toPickerEntry);
  const startIndex = originalSlug === undefined ? 0 : Math.max(0, allEntries.findIndex((entry) => entry.slug === originalSlug));
  const originalEntry = originalSlug === undefined ? undefined : allEntries.find((entry) => entry.slug === originalSlug);

  return new Promise<string | undefined>((resolve) => {
    let filterText = "";
    let highlightedIndex = startIndex;
    let visibleEntries = allEntries;
    let previousFrameLineCount = 0;
    let lastPreviewedSlug: string | undefined;

    const settledFileTargetPreview = createSettledFileTargetPreview((slug) => {
      try {
        previewThemePackToFileTargets(slug);
      } catch {
        // Same best-effort contract previewHighlighted always had — a
        // broken preview write is reported properly once Enter commits —
        // runApply reports it then.
      }
    });

    function previewHighlighted(): void {
      const entry = visibleEntries[highlightedIndex];
      if (entry === undefined || entry.slug === lastPreviewedSlug) return;
      lastPreviewedSlug = entry.slug;
      process.stdout.write(buildTerminalPreviewSequence(entry.scheme));
      settledFileTargetPreview.schedule(entry.slug);
    }

    function redraw(): void {
      clearPickerFrame(previousFrameLineCount);
      const frameLines = renderPickerFrame(visibleEntries, highlightedIndex, filterText);
      process.stdout.write(frameLines.map((line) => `${line}\n`).join(""));
      previousFrameLineCount = frameLines.length;
    }

    function applyFilter(nextFilterText: string): void {
      filterText = nextFilterText;
      visibleEntries = allEntries.filter((entry) => matchesPickerFilter(entry, filterText));
      highlightedIndex = 0;
      previewHighlighted();
      redraw();
    }

    function moveHighlight(step: 1 | -1): void {
      if (visibleEntries.length === 0) return;
      highlightedIndex = (highlightedIndex + step + visibleEntries.length) % visibleEntries.length;
      previewHighlighted();
      redraw();
    }

    function stopListening(): void {
      process.stdin.off("keypress", onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
    }

    /** The reverse of a live preview (CHM-52): re-paints the exact scheme that was active before the picker opened, or resets to the terminal's own configured colours when nothing was. */
    function restoreTerminalPreview(): void {
      process.stdout.write(originalEntry ? buildTerminalPreviewSequence(originalEntry.scheme) : buildTerminalResetSequence());
    }

    function cancel(): void {
      // A pending debounced write must never land after Esc has already
      // decided what every target's real state should be — see
      // createSettledFileTargetPreview's own "supersede, not queue".
      settledFileTargetPreview.cancel();
      restoreTerminalPreview();
      try {
        if (originalSlug === undefined) {
          undoAppliedPack();
        } else {
          applyThemePack(originalSlug);
        }
      } catch {
        // Best effort — the picker still exits either way; a cancel is not
        // itself a command whose failure `chm` needs to report.
      }
      stopListening();
      resolve(undefined);
    }

    function commit(): void {
      // Nothing highlighted means the filter matched no row — Enter has
      // nothing to commit, so it is a no-op rather than a cancel: cancelling
      // is Esc/Ctrl-C's job, and treating an empty filter as "cancel" would
      // exit without restoring originalSlug even though a preview is still
      // applied from before the filter narrowed to nothing.
      const chosenSlug = visibleEntries[highlightedIndex]?.slug;
      if (chosenSlug === undefined) return;
      // The caller's own runApply(chosenSlug) is what actually commits — a
      // full four-target apply, including windows-terminal, which no
      // preview here ever wrote to disk (CHM-52's "Enter still applies to
      // every target, including the ones a preview could not reach").
      settledFileTargetPreview.cancel();
      stopListening();
      resolve(chosenSlug);
    }

    function onKeypress(inputChar: string | undefined, key: Key | undefined): void {
      if (key?.ctrl && key.name === "c") return cancel();
      if (key?.name === "escape") return cancel();
      if (key?.name === "return") return commit();
      if (key?.name === "up") return moveHighlight(-1);
      if (key?.name === "down") return moveHighlight(1);
      if (key?.name === "backspace") return applyFilter(filterText.slice(0, -1));
      if (inputChar && /^[\x20-\x7e]$/.test(inputChar)) return applyFilter(filterText + inputChar);
    }

    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);

    process.stdout.write("\x1b[?25l");
    previewHighlighted();
    redraw();
  });
}

/**
 * Whether `chm themes` should print the plain list rather than open the
 * picker: an explicit `--list`, or either stream not being a real TTY — a
 * pipe on stdout, or no keyboard behind stdin. See CHM-44's "chm themes
 * --list, and the same output automatically when stdout is not a TTY, so
 * piping still works."
 */
export function wantsPlainThemeList(args: readonly string[], isStdinTTY: boolean, isStdoutTTY: boolean): boolean {
  return args.includes("--list") || !isStdinTTY || !isStdoutTTY;
}

/**
 * `chm themes` (aliased as `chm pick`) — opens the interactive picker, cursor
 * starting on whichever pack is currently applied, so the live preview that
 * makes this tool worth having is what the obvious command does (CHM-44:
 * CHM-42 had put it behind the less-obvious `chm pick` instead). Falls back
 * to the plain list whenever `wantsPlainThemeList` says so — reading arrow
 * keys needs a real stdin, and repainting frames needs a real stdout, so a
 * pipe on either end must print the scriptable list rather than block on
 * input that will never arrive or spray escape codes into it.
 */
async function runThemes(args: readonly string[]): Promise<number> {
  const { packs, warnings } = loadAllThemePacks();
  for (const warning of warnings) {
    process.stderr.write(`${warning}\n`);
  }

  if (wantsPlainThemeList(args, Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY))) {
    printThemeList(packs);
    return 0;
  }

  if (packs.length === 0) {
    process.stderr.write("chm: no themes available\n");
    return 1;
  }

  const chosenSlug = await runInteractivePicker(packs, currentPack()?.slug);
  if (chosenSlug === undefined) {
    process.stderr.write("chm: no theme chosen\n");
    return 1;
  }
  return runApply(chosenSlug);
}

/**
 * Strips everything but letters and digits, and lowercases what is left —
 * so "Catppuccin Mocha", "catppuccin-mocha" and "catppuccin_mocha" all
 * collapse to the same comparison key regardless of the separator or case a
 * person typed (CHM-42's "matched case- and separator-insensitively").
 */
export function normalizeThemeQuery(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `loaded`'s own slug and display name, each normalized — the two forms `chm <theme>` accepts for naming it. */
function themeMatchKeys(loaded: LoadedThemePack): readonly string[] {
  return [normalizeThemeQuery(loaded.pack.manifest.slug), normalizeThemeQuery(loaded.pack.manifest.name)];
}

/**
 * Classic edit distance between two strings — used only to pick `chm`'s
 * "did you mean" suggestion for a theme name it could not resolve at all, so
 * a typo like "catpucin" still lands on the right pack.
 */
function levenshteinDistance(queryText: string, candidateKey: string): number {
  const rowCount = queryText.length + 1;
  const columnCount = candidateKey.length + 1;
  const distances: number[][] = Array.from({ length: rowCount }, (_unused, rowIndex) => new Array(columnCount).fill(rowIndex));
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) distances[0]![columnIndex] = columnIndex;

  for (let rowIndex = 1; rowIndex < rowCount; rowIndex += 1) {
    for (let columnIndex = 1; columnIndex < columnCount; columnIndex += 1) {
      const substitutionCost = queryText[rowIndex - 1] === candidateKey[columnIndex - 1] ? 0 : 1;
      distances[rowIndex]![columnIndex] = Math.min(
        distances[rowIndex - 1]![columnIndex]! + 1,
        distances[rowIndex]![columnIndex - 1]! + 1,
        distances[rowIndex - 1]![columnIndex - 1]! + substitutionCost,
      );
    }
  }
  return distances[rowCount - 1]![columnCount - 1]!;
}

/** The pack whose normalized slug or name is the closest edit-distance match to `normalizedQuery` — `chm`'s "did you mean" for a name it could not resolve at all. Undefined only when `packs` is empty. */
function closestThemeByName(packs: readonly LoadedThemePack[], normalizedQuery: string): LoadedThemePack | undefined {
  let closest: LoadedThemePack | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const loaded of packs) {
    for (const key of themeMatchKeys(loaded)) {
      const distance = levenshteinDistance(normalizedQuery, key);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = loaded;
      }
    }
  }
  return closest;
}

export type ThemeQueryResult =
  | { readonly status: "resolved"; readonly loaded: LoadedThemePack }
  | { readonly status: "ambiguous"; readonly candidates: readonly LoadedThemePack[] }
  | { readonly status: "unknown"; readonly closest: LoadedThemePack | undefined };

/**
 * Resolves what a person typed after `chm` — a slug, a quoted display name,
 * or several bare words meant to be read as one name ("chm catppuccin
 * mocha") — against the loaded pack list. Matching is case- and
 * separator-insensitive (normalizeThemeQuery): an exact match is tried
 * first, then a prefix match, so "chm catppuccin" reports every Catppuccin
 * variant as ambiguous rather than silently guessing one — see CHM-42's "an
 * ambiguous prefix lists the candidates rather than guessing."
 */
export function resolveThemeQuery(packs: readonly LoadedThemePack[], rawTokens: readonly string[]): ThemeQueryResult {
  const normalizedQuery = normalizeThemeQuery(rawTokens.join(" "));

  const exactMatches = packs.filter((loaded) => themeMatchKeys(loaded).includes(normalizedQuery));
  if (exactMatches.length === 1) return { status: "resolved", loaded: exactMatches[0]! };
  if (exactMatches.length > 1) return { status: "ambiguous", candidates: exactMatches };

  const prefixMatches = packs.filter((loaded) => themeMatchKeys(loaded).some((key) => key.startsWith(normalizedQuery)));
  if (prefixMatches.length === 1) return { status: "resolved", loaded: prefixMatches[0]! };
  if (prefixMatches.length > 1) return { status: "ambiguous", candidates: prefixMatches };

  return { status: "unknown", closest: closestThemeByName(packs, normalizedQuery) };
}

/** One line of an ambiguous-match report: the name a person reads, plus the exact slug that would resolve it unambiguously. */
function formatAmbiguousCandidateLine(loaded: LoadedThemePack): string {
  return `  ${loaded.pack.manifest.name}  (chm ${loaded.pack.manifest.slug})`;
}

/**
 * `chm <theme>` — resolves `rawTokens` against the loaded pack list
 * (resolveThemeQuery) and applies the single match it finds. An ambiguous
 * prefix lists every candidate rather than guessing; a name that matches
 * nothing at all names the closest match instead, when one exists.
 */
function runApplyByQuery(rawTokens: readonly string[]): number {
  const { packs, warnings } = loadAllThemePacks();
  for (const warning of warnings) {
    process.stderr.write(`${warning}\n`);
  }

  const result = resolveThemeQuery(packs, rawTokens);
  if (result.status === "resolved") return runApply(result.loaded.pack.manifest.slug);

  const typedQuery = rawTokens.join(" ");
  if (result.status === "ambiguous") {
    const candidateLines = result.candidates.map(formatAmbiguousCandidateLine).join("\n");
    process.stderr.write(`chm: "${typedQuery}" matches more than one theme:\n${candidateLines}\n`);
    return 1;
  }

  if (result.closest) {
    process.stderr.write(`chm: no theme named "${typedQuery}" — did you mean "${result.closest.pack.manifest.name}"?\n`);
  } else {
    process.stderr.write(`chm: no theme named "${typedQuery}" — run \`chm themes\` to see what's available\n`);
  }
  return 1;
}

// --- chm prompts / chm prompt <name> / chm prompt mine (CHM-47) ------------
//
// Mirrors chm themes' own shape — "one thing to learn, not two" — but a
// prompt layout is Oh My Posh's concern alone, so there is no per-target
// fan-out and no colour swatch: a layout has no colour of its own until it
// is resolved against whatever theme is currently active (see index.ts's
// applyPromptPack). Oh My Posh missing is checked first, and named plainly,
// rather than listing layouts nothing can apply — see CHM-47's "This is the
// one moment a person has a concrete reason to install it."

/** One line of `chm prompts --list`'s plain output — the name, its description, and the Nerd Font flag CHM-47 requires a bundled layout never simply hide behind: still listed even when nothing is selected to render its glyphs, just marked. */
export function formatPromptListLine(entry: PromptPackListEntry): string {
  if (!entry.requiresNerdFont) return `${entry.name} — ${entry.description}`;
  const nerdFontFlag = entry.nerdFontWarning ? "  (needs Nerd Font — none selected)" : "  (Nerd Font)";
  return `${entry.name}${nerdFontFlag} — ${entry.description}`;
}

function printPromptList(entries: readonly PromptPackListEntry[]): void {
  for (const entry of entries) {
    process.stdout.write(`${formatPromptListLine(entry)}\n`);
  }
}

/** Whether `filterText` matches `entry` by slug or by name — the prompt picker's own version of matchesPickerFilter, kept separate rather than shared: a prompt row carries no swatches or scheme to preview, so it is not the same entry shape. */
function matchesPromptFilter(entry: PromptPackListEntry, filterText: string): boolean {
  if (filterText === "") return true;
  const needle = filterText.toLowerCase();
  return entry.slug.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle);
}

function renderPromptPickerRow(entry: PromptPackListEntry, isHighlighted: boolean): string {
  const cursor = isHighlighted ? ">" : " ";
  const nerdFontFlag = entry.requiresNerdFont ? (entry.nerdFontWarning ? "  (needs Nerd Font — none selected)" : "  (Nerd Font)") : "";
  return `${cursor} ${entry.name}${nerdFontFlag}`;
}

function renderPromptPickerFrame(entries: readonly PromptPackListEntry[], highlightedIndex: number, filterText: string): string[] {
  const filterLine = filterText === "" ? PICKER_HINT_LINE : `filter: ${filterText}`;
  const rowLines =
    entries.length === 0 ? ["  no matches"] : entries.map((entry, index) => renderPromptPickerRow(entry, index === highlightedIndex));
  return [filterLine, ...rowLines];
}

/**
 * Drives `chm prompts`' own arrow-key picker — CHM-47's "the same component
 * chm themes uses (CHM-44)": type-to-filter, arrow keys move the highlight,
 * Enter commits, Esc restores. The live preview here is a debounced real
 * apply (createSettledFileTargetPreview, CHM-52's own mechanism, reused as-
 * is) rather than themes' OSC escape codes: a prompt layout has no terminal-
 * wide colour of its own to paint instantly, only a config file and a
 * pointer to repoint, so there is nothing faster than that write to preview
 * with. Resolves to the slug Enter committed, or undefined on Esc/Ctrl-C,
 * after restoring whatever was active before the picker opened — the
 * previous bundled slug, or the user's own config when nothing was active.
 */
async function runInteractivePromptPicker(
  entries: readonly PromptPackListEntry[],
  originalSlug: string | undefined,
): Promise<string | undefined> {
  const startIndex = originalSlug === undefined ? 0 : Math.max(0, entries.findIndex((entry) => entry.slug === originalSlug));

  return new Promise<string | undefined>((resolve) => {
    let filterText = "";
    let highlightedIndex = startIndex;
    let visibleEntries = entries;
    let previousFrameLineCount = 0;
    let lastPreviewedSlug: string | undefined;

    const settledPreview = createSettledFileTargetPreview((slug) => {
      try {
        applyPromptPack(slug);
      } catch {
        // Best effort, same contract as the theme picker's own preview — a
        // real failure is reported once Enter commits, via runPromptApply.
      }
    });

    function previewHighlighted(): void {
      const entry = visibleEntries[highlightedIndex];
      if (entry === undefined || entry.slug === lastPreviewedSlug) return;
      lastPreviewedSlug = entry.slug;
      settledPreview.schedule(entry.slug);
    }

    function redraw(): void {
      clearPickerFrame(previousFrameLineCount);
      const frameLines = renderPromptPickerFrame(visibleEntries, highlightedIndex, filterText);
      process.stdout.write(frameLines.map((line) => `${line}\n`).join(""));
      previousFrameLineCount = frameLines.length;
    }

    function applyFilter(nextFilterText: string): void {
      filterText = nextFilterText;
      visibleEntries = entries.filter((entry) => matchesPromptFilter(entry, filterText));
      highlightedIndex = 0;
      previewHighlighted();
      redraw();
    }

    function moveHighlight(step: 1 | -1): void {
      if (visibleEntries.length === 0) return;
      highlightedIndex = (highlightedIndex + step + visibleEntries.length) % visibleEntries.length;
      previewHighlighted();
      redraw();
    }

    function stopListening(): void {
      process.stdin.off("keypress", onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
    }

    function cancel(): void {
      settledPreview.cancel();
      try {
        if (originalSlug === undefined) {
          restorePromptToMine();
        } else {
          applyPromptPack(originalSlug);
        }
      } catch {
        // Best effort — the picker still exits either way; a cancel is not
        // itself a command whose failure `chm` needs to report. Covers
        // "nothing was ever applied" too, the same case runInteractivePicker
        // swallows for undoAppliedPack.
      }
      stopListening();
      resolve(undefined);
    }

    function commit(): void {
      const chosenSlug = visibleEntries[highlightedIndex]?.slug;
      if (chosenSlug === undefined) return;
      settledPreview.cancel();
      stopListening();
      resolve(chosenSlug);
    }

    function onKeypress(inputChar: string | undefined, key: Key | undefined): void {
      if (key?.ctrl && key.name === "c") return cancel();
      if (key?.name === "escape") return cancel();
      if (key?.name === "return") return commit();
      if (key?.name === "up") return moveHighlight(-1);
      if (key?.name === "down") return moveHighlight(1);
      if (key?.name === "backspace") return applyFilter(filterText.slice(0, -1));
      if (inputChar && /^[\x20-\x7e]$/.test(inputChar)) return applyFilter(filterText + inputChar);
    }

    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);

    process.stdout.write("\x1b[?25l");
    previewHighlighted();
    redraw();
  });
}

/** `chm prompt <name>`'s report: applied, plus the Nerd Font warning CHM-47 asks for — never hidden, never blocking. */
function runPromptApply(slug: string): number {
  try {
    const result = applyPromptPack(slug);
    process.stdout.write(`applied prompt layout "${result.name}"\n`);
    if (result.detail) process.stdout.write(`  ${result.detail}\n`);
    if (result.nerdFontWarning) process.stderr.write(`chm: ${result.nerdFontWarning}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** `chm prompt mine` — puts the user's own config back, exactly where CLAUDE.md's "eat one user's config and the tool is dead" demands it still is. */
function runPromptMine(): number {
  try {
    restorePromptToMine();
    process.stdout.write("restored your own prompt config\n");
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** Resolves what a person typed after `chm prompt` against the bundled list — by slug or by display name, case- and separator-insensitive, the same normalizeThemeQuery themes' own resolution uses. Prompt layouts are few enough (six, at last count) that an ambiguous-prefix report is not worth the machinery resolveThemeQuery carries for it — ties fail with the same "run `chm prompts`" message an unknown name gets. */
function resolvePromptQuery(entries: readonly PromptPackListEntry[], rawQuery: string): PromptPackListEntry | undefined {
  const normalizedQuery = normalizeThemeQuery(rawQuery);
  return entries.find(
    (entry) => normalizeThemeQuery(entry.slug) === normalizedQuery || normalizeThemeQuery(entry.name) === normalizedQuery,
  );
}

/** `chm prompt <name>` / `chm prompt mine` — CHM-47's mirror of `chm <theme>`. */
function runPrompt(argv: string[]): number {
  const [nameOrMine] = argv;
  if (nameOrMine === undefined) {
    process.stderr.write("chm prompt: missing a layout name — run `chm prompts` to see what's available, or `chm prompt mine` to go back\n");
    return 1;
  }
  if (nameOrMine === "mine") return runPromptMine();

  const matched = resolvePromptQuery(listPromptPacks(), nameOrMine);
  if (!matched) {
    process.stderr.write(`chm: no prompt layout named "${nameOrMine}" — run \`chm prompts\` to see what's available\n`);
    return 1;
  }
  return runPromptApply(matched.slug);
}

/**
 * `chm prompts` (browse and pick) / `chm prompts --list` — CHM-47's mirror
 * of `chm themes`/`runThemes`. Oh My Posh missing is checked before
 * anything else: a prompt layout is Oh My Posh's concern alone, so there is
 * nothing useful to list or pick when it is not even installed — see
 * ohMyPoshMissingMessage.
 */
async function runPrompts(args: readonly string[]): Promise<number> {
  if (!createDefaultOhMyPoshAdapter().detect()) {
    process.stderr.write(`${ohMyPoshMissingMessage()}\n`);
    return 1;
  }

  const entries = listPromptPacks();

  if (wantsPlainThemeList(args, Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY))) {
    printPromptList(entries);
    return 0;
  }

  if (entries.length === 0) {
    process.stderr.write("chm: no prompt layouts available\n");
    return 1;
  }

  const chosenSlug = await runInteractivePromptPicker(entries, currentPromptPack()?.slug);
  if (chosenSlug === undefined) {
    process.stderr.write("chm: no prompt layout chosen\n");
    return 1;
  }
  return runPromptApply(chosenSlug);
}

export const USAGE = `usage: chm <command> [args]

chm themes             browse and pick a theme interactively, with live preview
chm themes --list      list every theme, with swatches, instead of picking
chm pick               alias for \`chm themes\`
chm <theme>            apply a theme, by slug or by name
chm dark / chm light   flip mode, same family
chm next / chm prev    cycle either way
chm current            print the active theme
chm undo               put it back
chm doctor             what is installed
chm edit ...           edit the Oh My Posh prompt layout

chm prompts            browse and pick a prompt layout interactively
chm prompts --list     list every layout instead of picking
chm prompt <name>      apply a layout, by slug or by name
chm prompt mine        go back to your own prompt config

run \`chm themes\` to browse what you can apply
`;

/** `chm` with no argument — prints usage and exits non-zero, applying nothing. CHM-42 makes the subcommand required; CHM-44 put the interactive picker back on `chm themes`, the one the usage text tells people to run first. */
function runUsage(): number {
  process.stderr.write(USAGE);
  return 1;
}

/**
 * Entry point: `chm <theme>` applies a pack, matched by slug or by display
 * name (resolveThemeQuery); the rest are the named commands below. `chm`
 * with no argument prints usage rather than applying anything — see
 * runUsage.
 */
async function main(argv: string[]): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const [command, ...rest] = argv;
  if (command === undefined) return runUsage();
  if (command === "themes" || command === "pick") return runThemes(rest);
  if (command === "prompts") return runPrompts(rest);
  if (command === "prompt") return runPrompt(rest);
  if (command === "doctor") return runDoctor();
  if (command === "edit") return runEdit(rest);
  if (command === "current") return runCurrent(rest);
  if (command === "undo") return runUndo();
  if (command === "next") return runNext();
  if (command === "prev") return runPrev();
  if (command === "dark") return runFamilySwitch("dark");
  if (command === "light") return runFamilySwitch("light");
  return runApplyByQuery(argv);
}

/**
 * True only when this file was launched directly — as the `chm`/`chameleon`
 * bin script, or via `node dist/cli.js` — never when a test imports it to
 * exercise its exported formatting functions. `realpathSync` resolves both
 * sides through whatever symlink npm's bin shim uses, so this holds whether
 * `chm` was invoked straight or through that shim.
 */
function isRunAsScript(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isRunAsScript()) {
  main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
