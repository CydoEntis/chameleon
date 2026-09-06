#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { emitKeypressEvents, type Key } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  acquireLock,
  activePackRoleHexes,
  addSegment,
  ANSI_SLOT_NAMES,
  applyThemePack,
  beginThemePreview,
  buildLayoutSegment,
  createDefaultOhMyPoshAdapter,
  currentGitBranch,
  currentLockHolder,
  currentPack,
  didAnyTargetFail,
  findFamilySibling,
  isKnownRole,
  isSegmentType,
  layoutBlocksOnSide,
  loadAllThemePacks,
  moveSegmentBetweenBlocks,
  nextPackSlug,
  previewThemePackToFileTargets,
  prevPackSlug,
  readOhMyPoshLayout,
  removeSegment,
  reorderSegment,
  resyncInterruptedPreview,
  ROLES,
  runDoctorChecks,
  SEGMENT_TYPES,
  undoAppliedPack,
  VERSION,
  writeOhMyPoshLayout,
  type AnsiSlotName,
  type Appearance,
  type CurrentPackReport,
  type DoctorNerdFontCheck,
  type DoctorReport,
  type DoctorTargetCheck,
  type Layout,
  type LayoutBlockName,
  type LoadedThemePack,
  type LockInfo,
  type PackActionResult,
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

/**
 * `chm doctor`'s Claude Code row grows one more line naming the restart it
 * needs — undefined, so the row prints nothing extra, when Claude Code is not
 * installed. An apply already says this (see reloadClaudeCode), but doctor is
 * what someone runs when a theme looks wrong, and a running session holding a
 * stale theme is the single most common reason for that (CHM-65). Whether a
 * session is actually running is never checked — the note is unconditional,
 * same as an apply's own — see CHM-65's "Out of scope."
 */
export function formatClaudeCodeRestartNote(isInstalled: boolean): string | undefined {
  if (!isInstalled) return undefined;
  return "  restart Claude Code to pick up a theme change — it reads its theme once, at startup";
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
 * `chm current`/`chm doctor`'s shared wording for CHM-55's own distinction: a
 * target disagreeing with the recorded pack because a preview is (or was)
 * showing it is not the same fact as something else changing a config behind
 * Chameleon's back — see CurrentPackReport's own `previewInFlight` doc
 * comment. The reporter's own bug was exactly this: a drift warning that was
 * really just the picker running. Names `chm undo` as the fix either way — it
 * resyncs from ground truth when a preview marker is on record, see
 * resyncInterruptedPreview.
 */
function formatPreviewInFlightNotice(driftedTargets: readonly Target[]): string {
  return `a theme preview is in progress, or one did not exit cleanly — ${formatDriftedTargets(driftedTargets)} still ${matchesVerbFor(driftedTargets)} the previewed theme, not drift; run \`chm undo\` to resync`;
}

/**
 * `chm doctor`'s drift row: undefined when nothing has ever been applied —
 * there is nothing recorded to compare live configs against — "cannot
 * check" when the recorded pack no longer loads at all (CHM-34), "none"
 * when every detected target still matches the recorded pack, and otherwise
 * the targets that no longer do. See CHM-27: a partial apply that left
 * targets disagreeing must be visible here, not just at the moment it
 * happened. CHM-55: a disagreement caused by a preview still (or recently)
 * in flight is reported as that, never as drift — see
 * formatPreviewInFlightNotice.
 */
export function formatDriftLine(drift: DoctorReport["drift"]): string {
  if (!drift) return "drift: no pack has been applied yet — nothing to compare";
  if (isPackUnloadable(drift)) return `cannot check drift: pack "${drift.slug}" is no longer available`;
  if (drift.driftedTargets.length === 0) return `drift: none — every detected target matches "${drift.slug}"`;
  if (drift.previewInFlight) return `drift: ${formatPreviewInFlightNotice(drift.driftedTargets)}`;
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
    if (check.target === "claude-code") {
      const restartNote = formatClaudeCodeRestartNote(check.isInstalled);
      if (restartNote) process.stdout.write(`${restartNote}\n`);
    }
  }

  process.stdout.write(`${formatNerdFontLine(report.nerdFont)}\n`);
  if (report.nerdFont.installCommand) {
    process.stdout.write(`  would run: ${report.nerdFont.installCommand}\n`);
  }

  process.stdout.write(`${formatDriftLine(report.drift)}\n`);
  return hasDrift(report.drift) ? 1 : 0;
}

// --- `chm statusline` (CHM-68) -----------------------------------------
//
// The command Claude Code's own settings.json points `statusLine` at (see
// adapters/claude-code.ts's ensureStatusLineConfigured). Reads the session
// JSON Claude Code hands it on stdin, and prints exactly one line — nothing
// to stderr, ever, since Claude Code renders this command's stdout verbatim
// and a stray warning would land directly in its UI.

/**
 * The slice of Claude Code's own statusline payload this command reads —
 * see CLAUDE.md's "confirm the payload's real shape... do not assume field
 * names": every field below is exactly as documented at
 * https://docs.claude.com/en/docs/claude-code/statusline, and everything
 * else Claude Code sends is passed through unvalidated, never inspected.
 * Every field is optional — this command must still print a usable line
 * when the payload is missing pieces, not just when it is missing outright
 * (see buildStatuslineText).
 */
const StatuslinePayloadSchema = z
  .object({
    cwd: z.string().optional(),
    model: z.object({ display_name: z.string().optional() }).catchall(z.unknown()).optional(),
    workspace: z.object({ current_dir: z.string().optional() }).catchall(z.unknown()).optional(),
    context_window: z.object({ used_percentage: z.number().nullable().optional() }).catchall(z.unknown()).optional(),
  })
  .catchall(z.unknown());

export type StatuslinePayload = z.infer<typeof StatuslinePayloadSchema>;

/**
 * Parses Claude Code's own stdin payload, or undefined for anything that is
 * not the JSON object this command expects — malformed JSON, or valid JSON
 * that is not even an object. Never throws: an unreadable payload is exactly
 * the case CLAUDE.md's "fail to a plain, uncoloured line ... and exit 0"
 * exists for, not a reason to crash.
 */
export function parseStatuslinePayload(rawStdin: string): StatuslinePayload | undefined {
  try {
    const parsedJson: unknown = JSON.parse(rawStdin);
    const validated = StatuslinePayloadSchema.safeParse(parsedJson);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directory Claude Code's own payload names. `workspace.current_dir` and
 * `cwd` always carry the same value (see the docs above); `workspace.current_dir`
 * is read first only for consistency with `workspace.project_dir`, which
 * this command does not use. Falls back to this process's own working
 * directory — which Claude Code itself launched this command inside — when
 * the payload could not be read at all.
 */
function statuslineDirectory(payload: StatuslinePayload | undefined): string {
  return payload?.workspace?.current_dir ?? payload?.cwd ?? process.cwd();
}

/** Whole-percentage context-window usage, or undefined when the payload never got there — `context_window.used_percentage` is `null` before the first API response of a session (see the docs above), not merely absent. */
function statuslineContextPercent(payload: StatuslinePayload | undefined): number | undefined {
  const usedPercentage = payload?.context_window?.used_percentage;
  return typeof usedPercentage === "number" ? Math.round(usedPercentage) : undefined;
}

/** Joins every present segment with a plain, Nerd-Font-free separator — see CLAUDE.md's "no emoji, no box drawing." */
const STATUSLINE_SEGMENT_SEPARATOR = "  ·  ";

/**
 * Paints `text` in `hex` and resets immediately after, reusing the same SGR
 * 24-bit escape this file's own picker already paints rows with (sgrColor,
 * SGR_RESET) — one pure formatter for "a hex colour around some text",
 * rather than a second one just for this command. `hex` undefined — no pack
 * recorded as active, or it could not be loaded — prints `text` with no
 * colour at all rather than guess at one.
 */
function paintStatuslineSegment(hex: string | undefined, text: string): string {
  return hex === undefined ? text : `${sgrColor(SGR_FOREGROUND_BASE, hex)}${text}${SGR_RESET}`;
}

/**
 * `chm statusline`'s own one-line output: the model name, the working
 * directory's own name, the git branch (when `cwd` is inside a repository),
 * and whole-percentage context usage — Claude Code's own payload fields
 * that are always present or safely defaultable, per CLAUDE.md's "One line,
 * fields that are always present." Coloured from the active pack's own
 * accent/body/success/muted roles (`roleHexes`) so the line can never show a
 * colour the terminal itself is not also showing (CHM-68) — plain text, no
 * escape codes at all, when `roleHexes` is undefined: no pack has ever been
 * applied, or the recorded one could not be loaded. `gitBranch` is the
 * caller's own best-effort read (see adapters/git.ts's currentGitBranch),
 * passed in rather than read here so this stays a pure formatter, testable
 * without a real git repository.
 */
export function buildStatuslineText(
  payload: StatuslinePayload | undefined,
  roleHexes: Readonly<Record<Role, string>> | undefined,
  gitBranch: string | undefined,
): string {
  const modelName = payload?.model?.display_name ?? "Claude Code";
  const directoryName = path.basename(statuslineDirectory(payload));
  const contextPercent = statuslineContextPercent(payload);

  const segments = [paintStatuslineSegment(roleHexes?.accent, modelName), paintStatuslineSegment(roleHexes?.body, directoryName)];
  if (gitBranch !== undefined) segments.push(paintStatuslineSegment(roleHexes?.success, gitBranch));
  if (contextPercent !== undefined) segments.push(paintStatuslineSegment(roleHexes?.muted, `${contextPercent}% context`));

  return segments.join(STATUSLINE_SEGMENT_SEPARATOR);
}

/** Reads Claude Code's own stdin payload in one shot — small, and always closed before this process could do anything else with it, the same one-shot read every documented example script uses. */
function readStatuslineStdin(): string {
  return readFileSync(0, "utf8");
}

/**
 * `chm statusline` — see the section comment above. Every failure this can
 * hit — unreadable stdin, a corrupted pack, git not installed or not even on
 * PATH — falls back to the plainest line this process's own working
 * directory can still make, rather than ever throwing or writing to stderr:
 * see CLAUDE.md's "fail to a plain, uncoloured line ... and exit 0."
 */
function runStatusline(): number {
  try {
    const payload = parseStatuslinePayload(readStatuslineStdin());
    const roleHexes = activePackRoleHexes();
    const gitBranch = currentGitBranch(statuslineDirectory(payload));
    process.stdout.write(`${buildStatuslineText(payload, roleHexes, gitBranch)}\n`);
  } catch {
    process.stdout.write(`${path.basename(process.cwd())}\n`);
  }
  return 0;
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
 * `chm <theme>`/`chm undo`'s own per-target report, once a caller has
 * already printed its one-line "applied <slug>"/"restored" headline — CHM-67:
 * silence means success, so a target that simply did what the command name
 * already promised earns no line of its own. Only two things still do:
 *
 * - A failure, on stderr, naming the target and why — and once any target
 *   fails, every other target's line is dropped too (CHM-27's own partial-
 *   apply warning is the thing to read next, not a wall of "this one was
 *   fine").
 * - A carried `detail` on an outright success — Oh My Posh's own profile-
 *   creation notice (CHM-39), Herdr's "nothing running to reload" (CHM-45),
 *   Claude Code's restart notice (CHM-49) — because that is new information
 *   the plain "applied"/"restored" status never was.
 *
 * A plain "skipped (not installed)" is deliberately never one of the two: it
 * is the routine, unchanging fact a person without Herdr would otherwise see
 * on every single apply, and `chm doctor` already reports it, once,
 * compactly, for whoever actually wants it.
 */
export function formatNoteworthyResultLines(results: readonly PackActionResult[]): {
  readonly stdoutLines: readonly string[];
  readonly stderrLines: readonly string[];
} {
  const failedResults = results.filter((result) => result.status === "failed");
  if (failedResults.length > 0) {
    return { stdoutLines: [], stderrLines: failedResults.map((result) => `${result.target}: failed — ${result.detail}`) };
  }

  const stdoutLines = results
    .filter((result) => result.status !== "skipped" && result.detail !== undefined)
    .map((result) => `${result.target}: ${result.status} — ${result.detail}`);
  return { stdoutLines, stderrLines: [] };
}

/** Prints whatever formatNoteworthyResultLines found worth saying — nothing at all when every target simply did what the command's own headline already said. */
function printNoteworthyResults(results: readonly PackActionResult[]): void {
  const { stdoutLines, stderrLines } = formatNoteworthyResultLines(results);
  for (const line of stdoutLines) process.stdout.write(`${line}\n`);
  for (const line of stderrLines) process.stderr.write(`${line}\n`);
}

// --- Chameleon's single-writer lock (CHM-56) --------------------------------
//
// Two `chm` processes have no idea the other exists: an open picker holds
// the theme that was active when it opened and restores it on exit, silently
// undoing a real `chm <theme>` applied by a second process while it was up.
// The fix is one exclusive lock every write goes through — a one-shot
// command for the duration of its own apply/undo, a picker for its whole
// browsing session (see runThemes) — so a second `chm` that
// cannot take it says so, naming what holds it, rather than proceeding.

/** `chm`'s own "someone else is writing" message — names the pid and the command holding the lock, rather than silently racing it or queueing behind it. `holder` is only ever undefined when the lock file exists but could not be read — still held by someone, just not nameable. */
export function formatLockHeldMessage(holder: LockInfo | undefined): string {
  if (!holder) return "chm: another chm process is writing right now — try again in a moment";
  return `chm: another chm process is writing right now ("${holder.command}", pid ${holder.pid}) — try again once it exits`;
}

/**
 * Runs `body` while holding Chameleon's single-writer lock for `commandLabel`
 * — see the section comment above. A lock some other live process holds is
 * reported by name and nothing runs at all; `body` never starts, so nothing
 * it would have written ever gets written.
 */
function runWithWriteLock(commandLabel: string, body: () => number): number {
  const lock = acquireLock(commandLabel);
  if (lock.status === "held") {
    process.stderr.write(`${formatLockHeldMessage(lock.holder)}\n`);
    return 1;
  }
  try {
    return body();
  } finally {
    lock.release();
  }
}

/**
 * `chm <theme>` — applies that pack to every detected target, reporting per
 * target what changed. A target that is absent is skipped, never a failure;
 * this only returns non-zero when a target that *is* installed threw. A
 * failure never leaves the false impression `applied <slug>`'s own first
 * line might otherwise give — CHM-27 — so a partial result says so plainly,
 * on stderr, naming that the state file was left untouched. Also the funnel
 * every one-shot command that changes the active theme runs through —
 * runNext, runPrev and runFamilySwitch all call this — so wrapping it here in
 * runWithWriteLock (CHM-56) covers them all in one place.
 */
function runApply(slug: string): number {
  return runWithWriteLock(`chm ${slug}`, () => {
    try {
      const report = applyThemePack(slug);
      process.stdout.write(`applied ${report.slug}\n`);
      printNoteworthyResults(report.results);
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
  });
}

/**
 * `chm undo` — restores every detected target from the backup its own
 * adapter's most recent apply wrote. CHM-55: when a preview is recorded as
 * in flight — a picker still running in another pane, or one that was killed
 * outright — a plain backup restore is not trustworthy (a preview session can
 * back up over itself several times before it ends, see
 * resyncInterruptedPreview's own doc comment), so this resyncs from ground
 * truth instead: the pack `chm` last recorded as active, reapplied fresh, or
 * a plain restore when nothing had ever been applied. Either way, this is
 * the fix `chm current`/`chm doctor` name when they report a preview in
 * flight (formatPreviewInFlightNotice) — the "offer to resync" this ticket
 * asks for.
 */
function runUndo(): number {
  // CHM-56's write lock wraps CHM-55's own interrupted-preview resync: both
  // are writes to every target, and both must be the only one in flight.
  return runWithWriteLock("chm undo", () => {
    try {
      const resync = resyncInterruptedPreview();
      if (resync.status === "resynced-to-pack") {
        process.stdout.write(`chm undo: a theme preview was in progress — resynced every target back to "${resync.report.slug}"\n`);
        printNoteworthyResults(resync.report.results);
        return resync.report.isFullyApplied ? 0 : 1;
      }
      if (resync.status === "resynced-to-undo") {
        process.stdout.write("chm undo: a theme preview was in progress — restoring your original configuration\n");
        printNoteworthyResults(resync.results);
        return didAnyTargetFail(resync.results) ? 1 : 0;
      }

      const results = undoAppliedPack();
      // CHM-67: the same one-line headline runApply's own "applied <slug>"
      // is — undo just has no slug of its own to name, since each target is
      // restored from its own independent backup rather than a pack applied
      // as one unit.
      process.stdout.write("chm undo: restored\n");
      printNoteworthyResults(results);
      return didAnyTargetFail(results) ? 1 : 0;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  });
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

/** `chm current`'s own message when Chameleon's write lock is held live (CHM-56) — a target's live config can legitimately disagree with the recorded pack for as long as a debounced preview write is in flight, and that is not the drift `chm current`/`chm doctor` exist to catch. */
export function formatPreviewInProgressLine(holder: LockInfo): string {
  return `a preview is running ("${holder.command}") — drift not checked until it finishes`;
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

  // CHM-56: a picker's debounced write, or a one-shot apply/undo, can be
  // mid-flight right now — a target briefly disagreeing with the recorded
  // pack in that window is not drift, it just hasn't landed yet. Reported
  // instead of drift, not alongside it, since the comparison below cannot
  // tell the two apart while a write is still in progress.
  const activeLockHolder = currentLockHolder();
  if (activeLockHolder) {
    process.stderr.write(`chm current: ${formatPreviewInProgressLine(activeLockHolder)}\n`);
    return 0;
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
    if (current.previewInFlight) {
      process.stderr.write(`chm current: ${formatPreviewInFlightNotice(current.driftedTargets)}\n`);
      return 1;
    }
    process.stderr.write(
      `chm current: drifted — ${formatDriftedTargets(current.driftedTargets)} no longer ${matchesVerbFor(current.driftedTargets)} "${current.slug}"\n`,
    );
    return 1;
  }
  return 0;
}

/** One picker row: enough to paint the row in its own pack's ground and body (CHM-64), filter it by slug or name, apply it, and preview it live. CHM-66 dropped the accent swatch, so the accent hex itself is no longer carried here — see renderPickerRow. */
export interface PickerEntry {
  readonly slug: string;
  readonly name: string;
  readonly origin: string;
  readonly groundHex: string;
  readonly bodyHex: string;
  /**
   * The full scheme this entry's live preview paints with escape codes
   * (CHM-52), instantly, in the pane the picker itself is running in. CHM-55:
   * a debounced write of this same scheme also lands on Windows Terminal's
   * own settings.json (previewThemePackToFileTargets) once the highlight
   * settles, so every other pane of that terminal repaints too — escape
   * codes reach only the one pane, but the file every pane's host reads from
   * reaches all of them.
   */
  readonly scheme: Scheme;
}

export function toPickerEntry(loaded: LoadedThemePack): PickerEntry {
  const roleHexes = loaded.pack.payloads["oh-my-posh"];
  return {
    slug: loaded.pack.manifest.slug,
    name: loaded.pack.manifest.name,
    origin: loaded.origin,
    groundHex: roleHexes.ground,
    bodyHex: roleHexes.body,
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
 * Idle delay, in ms, before a settled highlight triggers a real file write to
 * every target's own config (previewThemePackToFileTargets) — Herdr, Oh My
 * Posh and Claude Code all read their colours from a config file, never from
 * the terminal's own escape-sequence palette, and Windows Terminal's own
 * settings.json is what CHM-55 added: the escape-sequence palette repaints
 * only the pane the picker is running in, and this debounced write is what
 * reaches every other pane of the same multiplexer, since Windows Terminal
 * watches that file and repaints from it. Long enough that holding an arrow
 * key through the whole list costs one file apply at the end, not one per
 * row (CHM-52's "holding the key for 10 rows: 3.2s of frozen UI"); short
 * enough that pausing on a row still writes it within roughly the blink of
 * an eye.
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

/** Parses a 6-digit hex colour into its three 0-255 channels, or undefined for anything HEX_COLOR_PATTERN does not match — the one guard sgrColor and swatch both sit behind, so a bad hex degrades to "paint nothing" rather than a garbled escape sequence. */
function parseHexChannels(hex: string): { red: number; green: number; blue: number } | undefined {
  const channels = HEX_COLOR_PATTERN.exec(hex);
  if (!channels) return undefined;
  const [, redHex, greenHex, blueHex] = channels;
  return {
    red: Number.parseInt(redHex!, 16),
    green: Number.parseInt(greenHex!, 16),
    blue: Number.parseInt(blueHex!, 16),
  };
}

/** SGR's own base codes for "set foreground" and "set background" in the 24-bit `<base>;2;r;g;b` form — see sgrColor. */
const SGR_FOREGROUND_BASE = 38;
const SGR_BACKGROUND_BASE = 48;
const SGR_RESET = "\x1b[0m";

/** A 24-bit SGR escape setting the foreground or background (sgrBase) to `hex` — empty for a hex parseHexChannels cannot read. */
function sgrColor(sgrBase: number, hex: string): string {
  const channels = parseHexChannels(hex);
  if (!channels) return "";
  return `\x1b[${sgrBase};2;${channels.red};${channels.green};${channels.blue}m`;
}

/**
 * Two spaces painted with `hex` as a background colour — the accent swatch
 * `chm themes --list` and every picker row still carry (CHM-64: "keep the
 * accent visible somewhere per row; the pack's accent is the second thing
 * people are choosing on"). Deliberately a solid block of colour rather than
 * a glyph: see CLAUDE.md, "Terminal output must read without a Nerd Font
 * installed." The escape codes are plain ANSI 24-bit colour, nothing Windows
 * Terminal renders differently under cmd.exe, PowerShell or git-bash — see
 * CHM-24's "must not depend on a terminal feature only one of them has."
 */
function swatch(hex: string): string {
  const channels = parseHexChannels(hex);
  if (!channels) return "  ";
  return `${sgrColor(SGR_BACKGROUND_BASE, hex)}  ${SGR_RESET}`;
}

/** Whether `entry` matches the picker's type-to-filter text, by slug or by name — an empty filter matches everything. */
function matchesPickerFilter(entry: PickerEntry, filterText: string): boolean {
  if (filterText === "") return true;
  const needle = filterText.toLowerCase();
  return entry.slug.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle);
}

/** SGR 7 — reverse video, swapping whatever foreground and background are already active. This is the highlight mechanism CHM-64 asks for: it stands out on every pack without ever reading that pack's own colours, so it cannot vanish the way a fixed highlight background could on a pack that happens to share it. */
const SGR_REVERSE_VIDEO = "\x1b[7m";

/**
 * The background-then-foreground SGR prefix a picker row is painted with:
 * that pack's own ground behind its own body (CHM-64). Highlighted adds
 * reverse video on top of the same two codes — see SGR_REVERSE_VIDEO for why
 * that, and not a tint, is what marks the highlighted row.
 */
function sgrRowPaint(groundHex: string, bodyHex: string, isHighlighted: boolean): string {
  const reverseVideo = isHighlighted ? SGR_REVERSE_VIDEO : "";
  return `${reverseVideo}${sgrColor(SGR_BACKGROUND_BASE, groundHex)}${sgrColor(SGR_FOREGROUND_BASE, bodyHex)}`;
}

/**
 * The one-character column to the left of every row's number (CHM-66):
 * blank for an ordinary row, `>` for wherever the cursor is, `*` for the
 * pack actually applied. Rendered outside any of that row's own paint (see
 * renderPickerRow), so it stays legible on the lightest and darkest bundled
 * pack alike rather than depending on colours it is supposed to stand out
 * from. Highlighted wins when the cursor sits on the applied row — which
 * key is being pressed is the more useful fact while browsing.
 */
const PICKER_HIGHLIGHTED_MARKER = ">";
const PICKER_APPLIED_MARKER = "*";
const PICKER_BLANK_MARKER = " ";

function pickerRowMarker(isHighlighted: boolean, isApplied: boolean): string {
  if (isHighlighted) return PICKER_HIGHLIGHTED_MARKER;
  if (isApplied) return PICKER_APPLIED_MARKER;
  return PICKER_BLANK_MARKER;
}

/**
 * `displayNumber` right-aligned to `gutterDigits` and period-terminated, so
 * "1.", "10." and "100." all end at the same column no matter how many
 * digits the number itself has (CHM-66). `gutterDigits` is sized once per
 * frame from how many entries are currently showing — see
 * computePickerRowLayout.
 */
function formatPickerRowNumber(displayNumber: number, gutterDigits: number): string {
  return `${String(displayNumber).padStart(gutterDigits, " ")}.`;
}

/**
 * Two leading spaces, the row's number, two more spaces, then the name and
 * its user marker — the part of a picker row that gets painted in the
 * pack's own colours and padded to `PickerRowLayout.contentWidth` (CHM-66).
 * Shared by renderPickerRow and computePickerRowLayout, so measuring a row
 * and painting it can never disagree.
 */
function pickerRowContent(entry: PickerEntry, displayNumber: number, gutterDigits: number): string {
  const userMarker = entry.origin === "user" ? "  (user)" : "";
  return `  ${formatPickerRowNumber(displayNumber, gutterDigits)}  ${entry.name}${userMarker}`;
}

/**
 * Where one row sits in the frame currently being drawn: its displayed
 * position — renumbered every time a filter narrows the list (CHM-66) —
 * and the two facts that decide its marker, whether the cursor is on it and
 * whether it is the pack actually applied.
 */
interface PickerRowPosition {
  readonly displayNumber: number;
  readonly isHighlighted: boolean;
  readonly isApplied: boolean;
}

/**
 * The gutter width and total content width every row in one frame shares —
 * CHM-66's "every row the same width", so the painted background forms a
 * clean block rather than a ragged edge at each name's end. Computed once
 * per frame by computePickerRowLayout, never per row, so two rows can never
 * disagree about where the name column starts.
 */
interface PickerRowLayout {
  readonly gutterDigits: number;
  readonly contentWidth: number;
}

/**
 * Sizes one frame's gutter and row width from every entry in the current
 * filter, not just the ones inside the visible scroll window — so the
 * layout does not shift as the highlight scrolls the window past names of
 * different lengths.
 */
function computePickerRowLayout(entries: readonly PickerEntry[]): PickerRowLayout {
  const gutterDigits = Math.max(1, String(entries.length).length);
  const contentWidth = entries.reduce(
    (widestSoFar, entry, index) => Math.max(widestSoFar, pickerRowContent(entry, index + 1, gutterDigits).length),
    0,
  );
  return { gutterDigits, contentWidth };
}

/**
 * One picker row, painted end to end in that pack's own colours — its own
 * ground behind its own body, the way tint's picker reads at a glance
 * (CHM-64) — with tint's own marker and number gutter in front of it
 * (CHM-66): a plain, unpainted one-character marker, then the row's number
 * and name padded to `layout.contentWidth` so the painted block lines up
 * into a clean rectangle down the whole list. No accent swatch — the row's
 * own background already carries the theme. The slug stays typeable for the
 * filter, but is never shown.
 */
export function renderPickerRow(entry: PickerEntry, position: PickerRowPosition, layout: PickerRowLayout): string {
  const marker = pickerRowMarker(position.isHighlighted, position.isApplied);
  const rowPaint = sgrRowPaint(entry.groundHex, entry.bodyHex, position.isHighlighted);
  const content = pickerRowContent(entry, position.displayNumber, layout.gutterDigits).padEnd(layout.contentWidth, " ");
  return `${marker}${rowPaint}${content}${SGR_RESET}`;
}

/**
 * tint's own three-part navigation line, copied exactly (CHM-66): plain
 * text but for the two arrows, which are ordinary Unicode rather than a
 * Nerd Font icon, so it reads with no Nerd Font installed (CLAUDE.md).
 * Shown on every frame, replacing the old hint/filter line that disappeared
 * the moment someone started typing — the filter now gets its own line
 * instead, see renderPickerFrame.
 */
const PICKER_HEADER_LINE = "↑/↓ Navigate    Enter: Select    Esc: Cancel";

/** The arrow the footer's "N more" line points down with — see renderPickerFrame. */
const PICKER_FOOTER_ARROW = "↓";

/**
 * How many rows renderPickerFrame shows at once before it scrolls (CHM-66):
 * "every rendered row is the same width" and "a footer when the list is
 * longer than the visible window" both assume a bounded window rather than
 * every matching entry regardless of list length.
 */
const PICKER_VISIBLE_ROW_COUNT = 15;

/**
 * The first index of the contiguous slice of `totalCount` rows to actually
 * draw, chosen so `highlightedIndex` always falls inside it: the window
 * starts at the top of the list until the highlight would run past its far
 * edge, then follows the highlight down, and never scrolls past the point
 * where the window's last row is the list's last entry.
 */
function pickerWindowStart(totalCount: number, highlightedIndex: number, maxVisibleRows: number): number {
  if (totalCount <= maxVisibleRows) return 0;
  return Math.min(Math.max(0, highlightedIndex - maxVisibleRows + 1), totalCount - maxVisibleRows);
}

/**
 * Every line of one picker frame: the fixed navigation header, the filter
 * line once someone has typed anything, one row per visible entry — scrolled
 * to keep the highlight in view rather than every matching entry regardless
 * of list length (CHM-66) — and a footer naming how many more entries sit
 * below the window. `appliedSlug` is the pack actually applied (see
 * runInteractivePicker's own `originalSlug`), never the one merely
 * previewed by the highlight, so the `*` marker does not chase the cursor
 * around the list.
 */
export function renderPickerFrame(
  entries: readonly PickerEntry[],
  highlightedIndex: number,
  filterText: string,
  appliedSlug: string | undefined,
): string[] {
  const filterLine = filterText === "" ? [] : [`filter: ${filterText}`];
  if (entries.length === 0) return [PICKER_HEADER_LINE, ...filterLine, "  no matches"];

  const layout = computePickerRowLayout(entries);
  const windowStart = pickerWindowStart(entries.length, highlightedIndex, PICKER_VISIBLE_ROW_COUNT);
  const windowEnd = Math.min(entries.length, windowStart + PICKER_VISIBLE_ROW_COUNT);
  const rowLines = entries.slice(windowStart, windowEnd).map((entry, windowIndex) => {
    const index = windowStart + windowIndex;
    return renderPickerRow(
      entry,
      { displayNumber: index + 1, isHighlighted: index === highlightedIndex, isApplied: entry.slug === appliedSlug },
      layout,
    );
  });
  const hiddenBelowCount = entries.length - windowEnd;
  const footerLine = hiddenBelowCount > 0 ? [`${PICKER_FOOTER_ARROW} ${hiddenBelowCount} more`] : [];

  return [PICKER_HEADER_LINE, ...filterLine, ...rowLines, ...footerLine];
}

/** Moves the cursor back up over the previous frame and clears everything from there down, so redrawing never scrolls the screen. */
function clearPickerFrame(lineCount: number): void {
  if (lineCount === 0) return;
  process.stdout.write(`\x1b[${lineCount}A\x1b[0J`);
}

/**
 * Whether the picker's Esc/Ctrl-C should restore `originalSlug` on exit —
 * only when the active selection is still exactly what it was when the
 * picker opened (CHM-56). A real `chm <theme>` from another process while
 * the picker was up changes `currentActiveSlug`
 * without ever touching the picker's own `originalSlug` — and that is the
 * user's more recent explicit choice, so the picker must leave it alone
 * rather than silently reverting it. Both undefined (nothing was active
 * before, and nothing is active now) still counts as unchanged.
 */
export function shouldRestoreOriginalSelectionOnExit(originalSlug: string | undefined, currentActiveSlug: string | undefined): boolean {
  return currentActiveSlug === originalSlug;
}

/**
 * Drives the arrow-key picker: renders the filtered list with each row
 * painted in its own pack's colours (CHM-64) behind tint's own header,
 * numbered gutter and footer (CHM-66), moves the highlight on the arrow
 * keys, narrows the list as the user types, and previews the highlighted
 * pack immediately on every move —
 * see CHM-24's "applying as the cursor moves is the feature that makes this
 * tool worth using." CHM-52: that preview is now the terminal's own escape
 * codes (buildTerminalPreviewSequence), instant and file-free, plus a
 * debounced write to every target's own config, Windows Terminal included
 * (previewThemePackToFileTargets, CHM-55) — never a synchronous four-target
 * apply per keystroke, and never anything Enter's own commit or Esc's own
 * restore has to race. The escape codes repaint only this pane, instantly;
 * the debounced file write is what reaches every other pane of the same
 * multiplexer once the highlight settles (CHM-55) — see beginThemePreview's
 * own doc comment for what happens if this process never gets a chance to
 * finish that job. Resolves to the slug Enter committed, or to `undefined`
 * on Esc/Ctrl-C, after restoring `originalSlug` (or undoing every target's
 * change, when nothing was active before the picker opened) and restoring
 * the terminal's own colours the same way — see restoreTerminalPreview.
 * CHM-56: Esc only restores when nothing else changed the active theme
 * while the picker was open (shouldRestoreOriginalSelectionOnExit) — a real
 * apply from another process wins over the picker's own restore. `releaseLock`
 * is the caller's own session-wide write lock (see runThemes), released the
 * moment this resolves either way, so the picker never keeps holding it a
 * moment longer than it is actually open.
 */
async function runInteractivePicker(
  packs: readonly LoadedThemePack[],
  originalSlug: string | undefined,
  releaseLock: () => void,
): Promise<string | undefined> {
  const allEntries = packs.map(toPickerEntry);
  const startIndex = originalSlug === undefined ? 0 : Math.max(0, allEntries.findIndex((entry) => entry.slug === originalSlug));
  const originalEntry = originalSlug === undefined ? undefined : allEntries.find((entry) => entry.slug === originalSlug);

  // CHM-55: recorded before the first frame ever renders, so a picker killed
  // outright — a closed terminal, `kill -9`, a crash — before it can run its
  // own cancel() still leaves something on record. Cleared by whichever real
  // command ends this session: cancel's own applyThemePack/undoAppliedPack,
  // or commit's caller applying the chosen slug (runThemes's own runApply).
  beginThemePreview(originalSlug);

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
      // originalSlug, not currentPack()?.slug: the `*` marker names the pack
      // this session actually applied, not whatever the highlight is merely
      // previewing — see renderPickerFrame's own doc comment.
      const frameLines = renderPickerFrame(visibleEntries, highlightedIndex, filterText, originalSlug);
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
      // CHM-56: a real `chm <theme>` from another process while this picker
      // was open already changed the active pack — that is a more recent,
      // explicit choice, and restoring originalSlug over it would be exactly
      // the silent revert this ticket exists to stop.
      if (shouldRestoreOriginalSelectionOnExit(originalSlug, currentPack()?.slug)) {
        try {
          // Both branches also clear CHM-55's own preview-in-flight marker
          // (applyThemePack/undoAppliedPack do that themselves) — a clean Esc
          // or Ctrl-C is exactly the "real command" that ends this session.
          if (originalSlug === undefined) {
            undoAppliedPack();
          } else {
            applyThemePack(originalSlug);
          }
        } catch {
          // Best effort — the picker still exits either way; a cancel is not
          // itself a command whose failure `chm` needs to report.
        }
      } else {
        process.stderr.write(
          `chm: the active theme changed while the picker was open — leaving it as "${currentPack()?.slug ?? "nothing"}"\n`,
        );
      }
      releaseLock();
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
      // full four-target apply that also clears CHM-55's own preview-in-
      // flight marker (applyThemePack does that itself), the same "real
      // command ends the session" contract cancel()'s own restore has. The
      // session lock is released here, before that final apply runs, so
      // runApply's own lock (CHM-56) is a fresh acquisition, not nested.
      settledFileTargetPreview.cancel();
      releaseLock();
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

  // CHM-56: held for the picker's whole browsing session, not per preview —
  // a second `chm` cannot write while this is open, and must say so rather
  // than racing it. See runInteractivePicker's own release of this at Esc/Enter.
  const lock = acquireLock("chm themes");
  if (lock.status === "held") {
    process.stderr.write(`${formatLockHeldMessage(lock.holder)}\n`);
    return 1;
  }

  const chosenSlug = await runInteractivePicker(packs, currentPack()?.slug, lock.release);
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
chm statusline         print one themed line for Claude Code's own status bar

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
  if (command === "doctor") return runDoctor();
  if (command === "edit") return runEdit(rest);
  if (command === "statusline") return runStatusline();
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
