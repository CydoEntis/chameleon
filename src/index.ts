/**
 * Public surface of the library half of Chameleon. The CLI in `cli.ts` is a
 * thin shell over these exports so the conversion and repair logic can be
 * tested without spawning a process.
 */

import {
  claudeCodeMatchesAppearance,
  createClaudeCodeAdapter,
  describeStatusLine,
  isClaudeCodeStatusLineEnabled,
  undoClaudeCode,
} from "./adapters/claude-code.js";
import type { Role } from "./constants.js";
import { checkLiveContrastInventory, type DoctorContrastReport } from "./doctor.js";
import { detectNerdFontInstalled, isNerdFontFamilyName, nerdFontInstallCommand } from "./adapters/fonts.js";
import { currentGitBranch } from "./adapters/git.js";
import { createHerdrAdapter, herdrMatchesScheme, undoHerdr } from "./adapters/herdr.js";
import {
  createDefaultOhMyPoshAdapter,
  createOhMyPoshAdapter,
  ohMyPoshMatchesScheme,
  ohMyPoshOwnedConfigStatus,
  OH_MY_POSH_WINGET_PACKAGE_ID,
  undoOhMyPosh,
  type OhMyPoshOwnedConfigStatus,
} from "./adapters/oh-my-posh.js";
import {
  captureOriginalSnapshotIfMissing,
  readOriginalSnapshot,
  restoreClaudeCodeFromSnapshot,
  restoreHerdrFromSnapshot,
  restoreOhMyPoshFromSnapshot,
  restoreWindowsTerminalFromSnapshot,
  type OriginalSnapshot,
} from "./adapters/original-snapshot.js";
import { isWindows } from "./adapters/platform.js";
import { clearPreviewState, readPreviewState, writePreviewState } from "./adapters/preview-state.js";
import { readActivePackState, writeActivePackState } from "./adapters/state.js";
import { loadUserThemePacks } from "./adapters/user-theme-packs.js";
import {
  createWindowsTerminalAdapter,
  selectedFontFace,
  undoWindowsTerminal,
  windowsTerminalMatchesScheme,
  WINDOWS_TERMINAL_WINGET_PACKAGE_ID,
} from "./adapters/windows-terminal.js";
import { toPalette, type Appearance } from "./palette/palette.js";
import type { Scheme } from "./palette/scheme.js";
import { loadCuratedThemePacks, mergeThemePacksBySlug, type LoadedThemePack } from "./palette/theme-pack-library.js";
import type { StatuslineMeterHexes, ThemePackPayloads } from "./palette/theme-pack.js";

export const VERSION = "0.0.0";

/** Every target Chameleon can theme. An adapter exists per entry. */
export const TARGETS = ["windows-terminal", "oh-my-posh", "herdr", "claude-code"] as const;

export type Target = (typeof TARGETS)[number];

export type { Role } from "./constants.js";
export { isKnownRole, ROLES } from "./constants.js";

export type { Appearance, MeasuredColor, Palette, SlotName } from "./palette/palette.js";
export { toPalette } from "./palette/palette.js";
export type { AnsiRepairReport, AnsiSlotName } from "./palette/ansi.js";
export { ANSI_SLOT_NAMES, repairAnsiSlots } from "./palette/ansi.js";
export type { ContrastReport, RepairedRoleColor, ResolvedPalette } from "./palette/repair.js";
export { repairFailingRoles } from "./palette/repair.js";
export type { RoleAssignment, RoleColor } from "./palette/roles.js";
export { assignRolesByContrast } from "./palette/roles.js";
export type { Scheme } from "./palette/scheme.js";
export { parseScheme, SchemeSchema } from "./palette/scheme.js";
export type {
  PackAttribution,
  StatuslineMeterHexes,
  ThemePack,
  ThemePackManifest,
  ThemePackPayloads,
  UserPackManifest,
} from "./palette/theme-pack.js";
export {
  buildThemePack,
  parseThemePack,
  parseUserPackManifest,
  ThemePackSchema,
  UserPackManifestSchema,
} from "./palette/theme-pack.js";
export type { LoadedThemePack, ThemePackOrigin } from "./palette/theme-pack-library.js";
export { loadCuratedThemePacks, mergeThemePacksBySlug } from "./palette/theme-pack-library.js";

export type { WindowsTerminalAdapter, WindowsTerminalSettings } from "./adapters/windows-terminal.js";
export { createWindowsTerminalAdapter, removeDeadWindowsTerminalSchemeForks, undoWindowsTerminal } from "./adapters/windows-terminal.js";

export type {
  Layout,
  LayoutBlock,
  LayoutBlockName,
  LayoutSegment,
  OhMyPoshAdapter,
  OhMyPoshConfig,
  OhMyPoshOwnedConfigStatus,
  OhMyPoshSeedState,
  SegmentType,
} from "./adapters/oh-my-posh.js";
export {
  addSegment,
  buildLayoutSegment,
  createDefaultOhMyPoshAdapter,
  createOhMyPoshAdapter,
  isSegmentType,
  layoutBlocksOnSide,
  moveSegmentBetweenBlocks,
  readOhMyPoshLayout,
  readOhMyPoshSeedState,
  removeSegment,
  reorderSegment,
  reseedOhMyPoshOwnedConfig,
  SEGMENT_TYPES,
  undoOhMyPosh,
  writeOhMyPoshLayout,
} from "./adapters/oh-my-posh.js";

export type { HerdrAdapter, HerdrConfig } from "./adapters/herdr.js";
export { createHerdrAdapter, undoHerdr } from "./adapters/herdr.js";

export type { ClaudeCodeAdapter, ClaudeCodeSettings } from "./adapters/claude-code.js";
export {
  createClaudeCodeAdapter,
  describeStatusLine,
  disableClaudeCodeStatusLine,
  enableClaudeCodeStatusLine,
  isClaudeCodeStatusLineEnabled,
  undoClaudeCode,
} from "./adapters/claude-code.js";

export type { OriginalSnapshot } from "./adapters/original-snapshot.js";
export { defaultOriginalSnapshotPath, readOriginalSnapshot } from "./adapters/original-snapshot.js";

export { currentGitBranch } from "./adapters/git.js";

export type { UserThemePackLoadResult } from "./adapters/user-theme-packs.js";
export { defaultUserThemePackDir, loadUserThemePacks } from "./adapters/user-theme-packs.js";

export type { AcquireLockResult, LockInfo } from "./adapters/lock.js";
export { acquireLock, currentLockHolder, defaultLockPath } from "./adapters/lock.js";

/**
 * The full set of packs `ch` can offer right now: every bundled pack plus
 * whatever the user has dropped into their own theme directory, merged so a
 * user pack overrides a bundled one of the same slug — see
 * mergeThemePacksBySlug. `userThemeDir` is only ever overridden by tests;
 * `ch` itself always reads the real one, via loadUserThemePacks's own
 * default.
 */
export function loadAllThemePacks(userThemeDir?: string): {
  packs: LoadedThemePack[];
  warnings: readonly string[];
} {
  const bundledPacks = loadCuratedThemePacks();
  const { packs: userPacks, warnings } = loadUserThemePacks(userThemeDir);
  return { packs: mergeThemePacksBySlug(bundledPacks, userPacks), warnings };
}

/**
 * One target's `ch doctor` row: whether it is installed, and the one-line
 * command to fix it when it is not. `isApplicable` is false only for
 * Windows Terminal on a non-Windows platform, where the app itself cannot
 * exist — see CHM-25's "must not tell a Linux user that Windows Terminal is
 * missing as though that were a problem to fix." `isInstalled` is always
 * false and `installCommand` always undefined when a target is not
 * applicable, but the two questions are kept distinct so the CLI can report
 * "not available here" rather than "not found".
 */
export interface DoctorTargetCheck {
  readonly target: Target;
  readonly isApplicable: boolean;
  readonly isInstalled: boolean;
  readonly installCommand: string | undefined;
}

/** `ch doctor`'s own Claude Code statusline row — see DoctorReport's own `claudeCodeStatusLine` doc comment. */
export interface DoctorClaudeCodeStatusLineCheck {
  readonly inUseDescription: string;
  readonly isChameleonEnabled: boolean;
}

/** `ch doctor`'s Nerd Font row — installed and selected are different questions, see CLAUDE.md. */
export interface DoctorNerdFontCheck {
  readonly isInstalled: boolean;
  readonly isSelected: boolean;
  readonly selectedFontFace: string | undefined;
  readonly installCommand: string | undefined;
}

export interface DoctorReport {
  readonly targets: readonly DoctorTargetCheck[];
  readonly nerdFont: DoctorNerdFontCheck;
  /** Undefined when nothing has ever been applied — there is nothing recorded to compare live configs against. See CurrentPackReport.driftedTargets. */
  readonly drift: CurrentPackReport | undefined;
  /** Claude Code's own live "theme" value — undefined when it is not installed, or its settings.json cannot be read. See CHM-49's "reports which theme is set." */
  readonly claudeCodeTheme: string | undefined;
  /** Which statusLine Claude Code is actually configured with right now, and whether Chameleon's own lifecycle choice to manage it is enabled or disabled — undefined when Claude Code is not installed, or its settings.json cannot be read. See CHM-86's "names which statusline is in use and whether Chameleon's is enabled or disabled." */
  readonly claudeCodeStatusLine: DoctorClaudeCodeStatusLineCheck | undefined;
  /** Which config Chameleon owns for Oh My Posh, and which config it was seeded from — undefined before the very first seed. See CHM-74. */
  readonly ohMyPoshOwnedConfig: OhMyPoshOwnedConfigStatus | undefined;
  /** CHM-79's own gate, run against this machine's real config files rather than a bundled pack — see doctor.ts's checkLiveContrastInventory. */
  readonly contrast: DoctorContrastReport;
}

/**
 * `ch doctor` never hard-fails on a missing target: a detector that throws —
 * an unset LOCALAPPDATA, a settings.json it cannot parse — is reported as
 * not installed rather than raised, so one broken target never stops the
 * rest of the report from printing.
 */
function detectSafely(detect: () => boolean): boolean {
  try {
    return detect();
  } catch {
    return false;
  }
}

/** The one-line `winget` command `ch doctor` offers for a missing target — see CLAUDE.md, "Delegating installs to winget ... rather than reimplementing an installer." */
function wingetInstallCommand(packageId: string): string {
  return `winget install --id ${packageId} -e`;
}

/**
 * `wingetPackageId` is only ever offered as an install command on Windows —
 * winget itself is a Windows-only package manager, so suggesting it on
 * Linux or macOS would be a command that cannot work, for a target that may
 * well be legitimately missing there for reasons winget can't fix. A target
 * that is not applicable at all (Windows Terminal on a non-Windows
 * platform) is never reported installed and never offered a command either.
 */
function checkTarget(target: Target, isApplicable: boolean, isInstalled: boolean, wingetPackageId: string | undefined): DoctorTargetCheck {
  const canOfferWingetInstall = isApplicable && !isInstalled && wingetPackageId !== undefined && isWindows();
  return {
    target,
    isApplicable,
    isInstalled: isApplicable && isInstalled,
    installCommand: canOfferWingetInstall ? wingetInstallCommand(wingetPackageId) : undefined,
  };
}

/**
 * The font Windows Terminal has actually selected, or undefined when
 * Windows Terminal is not installed or its settings.json cannot be read —
 * either way, "not selected" rather than a thrown error.
 */
function currentlySelectedFontFace(): string | undefined {
  try {
    const windowsTerminalAdapter = createWindowsTerminalAdapter();
    return windowsTerminalAdapter.detect() ? selectedFontFace(windowsTerminalAdapter.read()) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code's own live "theme" value, or undefined when it is not
 * installed or its settings.json cannot be read — the same "report the fact,
 * never throw" contract as currentlySelectedFontFace. See CHM-49's "chm
 * doctor gains a Claude Code row, and reports which theme is set."
 */
function currentClaudeCodeTheme(): string | undefined {
  try {
    const claudeCodeAdapter = createClaudeCodeAdapter();
    return claudeCodeAdapter.detect() ? claudeCodeAdapter.read().theme : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code's own live statusLine, described plainly, alongside whether
 * Chameleon's own lifecycle choice to manage it is enabled or disabled —
 * undefined when Claude Code is not installed or its settings.json cannot be
 * read, the same "report the fact, never throw" contract currentClaudeCodeTheme
 * already follows. CHM-86: these are two different facts a user can disagree
 * about independently — Chameleon's management can be disabled while some
 * other statusLine (its own last write, or one hand-edited back in) is what
 * is actually running — so `chm doctor` names both rather than just one.
 */
function currentClaudeCodeStatusLine(): DoctorClaudeCodeStatusLineCheck | undefined {
  try {
    const claudeCodeAdapter = createClaudeCodeAdapter();
    if (!claudeCodeAdapter.detect()) return undefined;
    return {
      inUseDescription: describeStatusLine(claudeCodeAdapter.read().statusLine),
      isChameleonEnabled: isClaudeCodeStatusLineEnabled(),
    };
  } catch {
    return undefined;
  }
}

function checkNerdFont(): DoctorNerdFontCheck {
  const isInstalled = detectSafely(detectNerdFontInstalled);
  const selectedFace = currentlySelectedFontFace();

  return {
    isInstalled,
    // "Selected" means the font Windows Terminal is actually rendering with
    // is itself a Nerd Font — not merely that some font is configured. A
    // plain font selected while a Nerd Font sits installed but unused is
    // exactly the distinct case CLAUDE.md calls out.
    isSelected: selectedFace !== undefined && isNerdFontFamilyName(selectedFace),
    selectedFontFace: selectedFace,
    installCommand: isInstalled ? undefined : nerdFontInstallCommand(),
  };
}

/**
 * Runs every check `ch doctor` reports: whether each themeable target is
 * installed, whether a Nerd Font is installed and actually selected in
 * Windows Terminal, whether any detected target has drifted from the
 * pack `ch` last recorded as active (CHM-27) — see currentPack's own
 * driftedTargets — and which config Chameleon owns for Oh My Posh, and which
 * config it was seeded from (CHM-74). Herdr is detect-only and never offered
 * an install command — see CLAUDE.md, "Herdr stays detect-only, never
 * installed." `userThemeDir` and `statePath` are only ever overridden by
 * tests.
 */
export function runDoctorChecks(userThemeDir?: string, statePath?: string, previewStatePath?: string): DoctorReport {
  return {
    targets: [
      checkTarget(
        "windows-terminal",
        isWindows(),
        detectSafely(() => createWindowsTerminalAdapter().detect()),
        WINDOWS_TERMINAL_WINGET_PACKAGE_ID,
      ),
      checkTarget("oh-my-posh", true, detectSafely(() => createDefaultOhMyPoshAdapter().detect()), OH_MY_POSH_WINGET_PACKAGE_ID),
      checkTarget("herdr", true, detectSafely(() => createHerdrAdapter().detect()), undefined),
      checkTarget("claude-code", true, detectSafely(() => createClaudeCodeAdapter().detect()), undefined),
    ],
    nerdFont: checkNerdFont(),
    drift: currentPack(userThemeDir, statePath, previewStatePath),
    claudeCodeTheme: currentClaudeCodeTheme(),
    claudeCodeStatusLine: currentClaudeCodeStatusLine(),
    ohMyPoshOwnedConfig: ohMyPoshOwnedConfigStatus(),
    contrast: checkLiveContrastInventory(),
  };
}

// --- Applying, undoing and switching between packs -------------------------
//
// CHM-19: the commands `ch` exists for. Every adapter here is reused exactly
// as CHM-9/10/11 built it — this is orchestration only: fan a pack's scheme
// out across whichever targets are actually detected, and track which pack
// that was so `ch current`, `ch next` and `ch dark`/`ch light` have
// something to read.

/** One target's outcome from applying or undoing a pack. A target that is not installed is "skipped", never "failed" — see CLAUDE.md's "a target that is absent is skipped, never a failure." */
export type PackActionStatus = "applied" | "restored" | "skipped" | "failed";

export interface PackActionResult {
  readonly target: Target;
  readonly status: PackActionStatus;
  readonly detail?: string | undefined;
}

/** The slice of a target's adapter this file needs to check before applying or undoing: enough to detect it, never the target-specific `read`/`reload`. */
interface DetectableTargetAdapter {
  detect(): boolean;
}

function adapterForTarget(target: Target): DetectableTargetAdapter {
  if (target === "windows-terminal") return createWindowsTerminalAdapter();
  if (target === "oh-my-posh") return createDefaultOhMyPoshAdapter();
  if (target === "claude-code") return createClaudeCodeAdapter();
  return createHerdrAdapter();
}

/**
 * Combines two possibly-present details into one, for the one target whose
 * `apply` and `reload` can both have something to say at once — see
 * applyToTarget's own claude-code branch. Neither present stays undefined,
 * matching the plain `??` every other target still uses for its own "these
 * never coincide" case.
 */
function combinedDetail(first: string | undefined, second: string | undefined): string | undefined {
  if (first !== undefined && second !== undefined) return `${first} — ${second}`;
  return first ?? second;
}

/**
 * Applies `scheme` to `target` and then reloads it, so the running program
 * actually shows what was just written — see CHM-45: before this, `apply`
 * wrote the config and nothing ever called the adapter's own `reload`,
 * which is why Herdr's sidebar never changed until something unrelated
 * (a restart, a manual `reload-config`) happened to re-read the file for
 * it. Windows Terminal and Oh My Posh's own `reload` are no-ops — the
 * former watches settings.json itself, the latter repaints on its own next
 * render — Oh My Posh's own prompt command re-reads the fixed config path
 * `apply` already wrote (CHM-59) — so calling them here costs nothing and
 * keeps the same write-then-reload
 * shape for every target. Herdr's own `apply` also takes the pack's `slug`
 * — unlike the raw scheme, Herdr needs pack identity to pick a real
 * built-in theme name, see adapters/herdr.ts's herdrThemeNameFor — so this,
 * not a shared single-argument interface, is what lets that adapter's apply
 * differ in shape from windows-terminal's and oh-my-posh's.
 *
 * Both `apply` and `reload` can return a detail worth telling the user
 * without failing anything — Oh My Posh's own profile-creation notice
 * (CHM-39), Herdr's own "nothing running to reload" notice (CHM-45), and
 * Claude Code's own "restart Claude Code to see it" notice (CHM-49, since it
 * has no live reload of its own to trigger) — and for oh-my-posh and herdr
 * the two never fire alongside each other, so returning whichever one is
 * defined never silently drops a message. Claude Code is the one exception:
 * its own `reload` always has something to say, and its own `apply` can too
 * — CHM-68's own one-time "statusLine is already set" notice — so the two
 * really can coincide, and combinedDetail is what keeps that apply from
 * losing either message. Claude Code's own `apply` takes the pack's
 * appearance rather than the raw scheme — it renders from the terminal's own
 * ANSI slots, already written by this same apply for windows-terminal, so
 * there is no colour of its own to derive.
 */
function applyToTarget(target: Target, scheme: Scheme, slug: string): string | undefined {
  if (target === "oh-my-posh") {
    const adapter = createDefaultOhMyPoshAdapter();
    const applyDetail = adapter.apply(scheme);
    const reloadDetail = adapter.reload();
    return applyDetail ?? reloadDetail;
  }
  if (target === "windows-terminal") {
    const adapter = createWindowsTerminalAdapter();
    adapter.apply(scheme);
    return adapter.reload();
  }
  if (target === "claude-code") {
    const adapter = createClaudeCodeAdapter();
    const applyDetail = adapter.apply(toPalette(scheme).appearance);
    const reloadDetail = adapter.reload();
    return combinedDetail(applyDetail, reloadDetail);
  }
  const adapter = createHerdrAdapter();
  adapter.apply(scheme, slug);
  return adapter.reload();
}

/**
 * `target`'s own `undo*` function — undoWindowsTerminal, undoOhMyPosh,
 * undoHerdr or undoClaudeCode — restoring it from the backup its adapter's
 * most recent `apply` wrote, then reloading it the same way applyToTarget
 * does: a restored config that nothing ever re-reads leaves the exact CHM-45
 * gap `ch undo` would otherwise share with `ch <theme>`.
 */
function undoTarget(target: Target): string | undefined {
  if (target === "windows-terminal") {
    undoWindowsTerminal();
    return createWindowsTerminalAdapter().reload();
  }
  if (target === "oh-my-posh") {
    undoOhMyPosh();
    return createDefaultOhMyPoshAdapter().reload();
  }
  if (target === "claude-code") {
    undoClaudeCode();
    return createClaudeCodeAdapter().reload();
  }
  undoHerdr();
  return createHerdrAdapter().reload();
}

/**
 * Runs `action` against `target`, reporting `succeededStatus` when it
 * completes and skipping the target outright — never a failure — when it is
 * not installed. Anything `action` throws is caught and reported by message,
 * so one target's problem never stops the targets after it from being tried.
 * `action`'s own return value, when it gives one back, is carried as the
 * result's `detail` even on success — see applyToTarget's Oh My Posh
 * profile-creation notice (CHM-39) and Herdr's "nothing running to reload"
 * notice (CHM-45).
 */
function runOnInstalledTarget(target: Target, succeededStatus: PackActionStatus, action: () => string | undefined): PackActionResult {
  if (!detectSafely(() => adapterForTarget(target).detect())) {
    return { target, status: "skipped", detail: "not installed" };
  }
  try {
    const detail = action();
    return { target, status: succeededStatus, detail };
  } catch (error) {
    return { target, status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface ApplyPackReport {
  readonly slug: string;
  readonly results: readonly PackActionResult[];
  /**
   * False when at least one detected target failed to apply — see CHM-27. A
   * partial apply is never recorded as the active pack (see applyThemePack)
   * and `ch` must say so plainly rather than reporting success.
   */
  readonly isFullyApplied: boolean;
}

/** Whether any of `results` failed — the one fact that gates recording a pack as active (applyThemePack) and turns a per-target report into a non-zero exit (cli.ts's runApply/runUndo). */
export function didAnyTargetFail(results: readonly PackActionResult[]): boolean {
  return results.some((result) => result.status === "failed");
}

/** The loaded pack named `slug`, or a message naming `chm themes` as the way to see what is actually available. */
function findLoadedPack(slug: string, userThemeDir: string | undefined): LoadedThemePack {
  const { packs } = loadAllThemePacks(userThemeDir);
  const loaded = packs.find((candidate) => candidate.pack.manifest.slug === slug);
  if (!loaded) {
    throw new Error(`no pack named "${slug}" — run \`chm themes\` to see what's available`);
  }
  return loaded;
}

/**
 * Applies the pack named `slug` to every detected target. Every adapter's
 * own `apply` takes the pack's raw scheme and derives what it needs from it
 * itself — see theme-pack.ts's ThemePackPayloads doc comment — so the same
 * scheme is handed to all three; Herdr's `apply` also takes `slug` itself,
 * since picking a real Herdr built-in needs pack identity the scheme's raw
 * colours cannot supply — see applyToTarget.
 *
 * The pack is recorded as the active one only once every detected target
 * actually took it (CHM-27): a target that failed leaves that promise
 * broken, so a partial apply's succeeding targets are left exactly as they
 * are — never rolled back, since the whole point was that they *did* change
 * — and the state file is left untouched, keeping whatever pack (if any) was
 * previously recorded. That is what lets currentPack's own drift check
 * notice the targets that did change, rather than the pointer silently
 * claiming a pack that was never fully applied. `statePath`, like
 * `userThemeDir`, is only ever overridden by tests; `ch` itself always reads
 * and writes the real one.
 *
 * Every call also clears CHM-55's own preview-in-flight marker (see
 * beginThemePreview), whether or not this apply itself fully succeeds — a
 * real, explicit apply is the authoritative word on what every target should
 * show, and it supersedes whatever a preview left behind. Cleared first, so
 * a throw partway through this function never leaves the marker set.
 *
 * CHM-71: also captures the one-time original snapshot first, before any
 * target below is touched — a no-op every apply after the very first, since
 * captureOriginalSnapshotIfMissing guards on the snapshot already existing.
 * This is what lets applyToTarget's own claude-code branch set statusLine
 * unconditionally on every apply from here on: whatever the user had is
 * already safely recorded by the time that write happens, and `chm original`
 * (restoreOriginal) is what gives it back. `originalSnapshotPath`, like
 * `statePath` and `previewStatePath`, is only ever overridden by tests.
 */
export function applyThemePack(
  slug: string,
  userThemeDir?: string,
  statePath?: string,
  previewStatePath?: string,
  originalSnapshotPath?: string,
): ApplyPackReport {
  clearPreviewState(previewStatePath);
  captureOriginalSnapshotIfMissing(originalSnapshotPath);

  const loaded = findLoadedPack(slug, userThemeDir);
  const scheme = loaded.pack.payloads["windows-terminal"];

  const results = TARGETS.map((target) => runOnInstalledTarget(target, "applied", () => applyToTarget(target, scheme, slug)));
  const isFullyApplied = !didAnyTargetFail(results);

  if (isFullyApplied && results.some((result) => result.status === "applied")) {
    writeActivePackState(slug, statePath);
  }

  return { slug, results, isFullyApplied };
}

/**
 * Applies `slug` to every detected target, Windows Terminal included — CHM-55:
 * settings.json is watched by Windows Terminal itself and repaints every pane
 * of it, which is what lets a debounced write here reach panes the picker's
 * own OSC 4/10-12 preview (buildTerminalPreviewSequence) never could. Never
 * recorded as the active pack (contrast applyThemePack's own
 * writeActivePackState) — the picker calls this, debounced, while the
 * highlight moves, and a preview is not a command the user issued. Errors are
 * swallowed target by target the same way the picker's previous, synchronous
 * preview always did — a broken preview write is reported properly once
 * Enter's own commit (applyThemePack, via runApply) hits it for real.
 * `userThemeDir` is only ever overridden by tests.
 */
export function previewThemePackToFileTargets(slug: string, userThemeDir?: string): readonly PackActionResult[] {
  const loaded = findLoadedPack(slug, userThemeDir);
  const scheme = loaded.pack.payloads["windows-terminal"];
  return TARGETS.map((target) => runOnInstalledTarget(target, "applied", () => applyToTarget(target, scheme, slug)));
}

/**
 * Restores every detected target from the backup its own adapter's most
 * recent `apply` wrote — the counterpart to applyThemePack. Also clears
 * CHM-55's own preview-in-flight marker, for the same reason applyThemePack
 * does: a real `chm undo` is an authoritative word on target state too.
 */
export function undoAppliedPack(previewStatePath?: string): readonly PackActionResult[] {
  clearPreviewState(previewStatePath);
  return TARGETS.map((target) => runOnInstalledTarget(target, "restored", () => undoTarget(target)));
}

/**
 * `target`'s own reload, run after restoreOriginal has written that target's
 * raw file(s) back — the same "a restored config nothing re-reads is a gap"
 * reasoning undoTarget already follows, applied to CHM-71's own restore path
 * instead of the per-apply backup one.
 */
function reloadAfterOriginalRestore(target: Target): string | undefined {
  if (target === "windows-terminal") return createWindowsTerminalAdapter().reload();
  if (target === "oh-my-posh") return createDefaultOhMyPoshAdapter().reload();
  if (target === "claude-code") return createClaudeCodeAdapter().reload();
  return createHerdrAdapter().reload();
}

/**
 * Restores `target` from `snapshot` — see restoreWindowsTerminalFromSnapshot
 * and its three siblings in adapters/original-snapshot.ts — and reloads it
 * the same way every other apply/undo path does. "skipped" (never "failed")
 * when the snapshot itself has nothing recorded for `target`: a target
 * installed after Chameleon's first apply was never Chameleon's to restore,
 * the same "absent is skipped, never a failure" rule every other target
 * check in this file already follows.
 */
function restoreOneTargetFromSnapshot(target: Target, snapshot: OriginalSnapshot): boolean {
  if (target === "windows-terminal") return restoreWindowsTerminalFromSnapshot(snapshot);
  if (target === "oh-my-posh") return restoreOhMyPoshFromSnapshot(snapshot);
  if (target === "claude-code") return restoreClaudeCodeFromSnapshot(snapshot);
  return restoreHerdrFromSnapshot(snapshot);
}

function restoreTargetFromSnapshot(target: Target, snapshot: OriginalSnapshot): PackActionResult {
  try {
    const wasRestored = restoreOneTargetFromSnapshot(target, snapshot);
    if (!wasRestored) {
      return { target, status: "skipped", detail: "nothing was recorded — not configured before Chameleon's first apply" };
    }
    return { target, status: "restored", detail: reloadAfterOriginalRestore(target) };
  } catch (error) {
    return { target, status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `chm original` — restores every surface to exactly what it was before
 * Chameleon's first apply ever touched it (see
 * adapters/original-snapshot.ts), the safety property CHM-71 exists to add:
 * "any time, the user can go back to the snapshot." Throws when no snapshot
 * has ever been captured — nothing has been applied yet, so there is nothing
 * to go back to — rather than silently doing nothing. Also clears CHM-55's
 * own preview-in-flight marker, for the same reason applyThemePack and
 * undoAppliedPack both do: this is as authoritative a word on target state as
 * either of them. `previewStatePath` and `snapshotPath` are only ever
 * overridden by tests.
 */
export function restoreOriginal(previewStatePath?: string, snapshotPath?: string): readonly PackActionResult[] {
  clearPreviewState(previewStatePath);

  const snapshot = readOriginalSnapshot(snapshotPath);
  if (!snapshot) {
    throw new Error("no original snapshot recorded yet — it is captured on Chameleon's first apply, so apply a theme first");
  }

  return TARGETS.map((target) => restoreTargetFromSnapshot(target, snapshot));
}

// --- CHM-55: a preview marker, so an interrupted preview is never mistaken
// for drift ------------------------------------------------------------------
//
// previewThemePackToFileTargets now writes Windows Terminal's own
// settings.json too, so a preview reaches every pane of a multiplexer the
// same way a real apply does. That closes the "two panes, two themes" gap,
// but opens a new one: nothing before this recorded that a preview — as
// opposed to a command the user actually issued — was what last touched
// those targets. A picker killed outright (a closed terminal, `kill -9`, a
// crash) never runs its own cancel handler, and would otherwise leave every
// target on a previewed theme with nothing on record to say so.

/**
 * Records that a theme preview has started, naming `originalSlug` — the pack
 * active before the picker opened, or undefined when nothing had ever been
 * applied — so a preview that never gets a clean exit can still be resynced
 * (resyncInterruptedPreview) to what was there before it. Called once, when
 * the picker opens; cleared by whichever real command ends the session
 * (applyThemePack on Enter, applyThemePack or undoAppliedPack on Esc/Ctrl-C —
 * see cli.ts's runInteractivePicker). `previewStatePath` is only ever
 * overridden by tests.
 */
export function beginThemePreview(originalSlug: string | undefined, previewStatePath?: string): void {
  writePreviewState(originalSlug, previewStatePath);
}

/**
 * Whether a theme preview is currently recorded as in flight — either a
 * picker genuinely running in another pane, or one that never cleaned up
 * after itself. `previewStatePath` is only ever overridden by tests.
 */
export function isPreviewInFlight(previewStatePath?: string): boolean {
  return readPreviewState(previewStatePath) !== undefined;
}

export type PreviewResyncOutcome =
  | { readonly status: "not-in-flight" }
  | { readonly status: "resynced-to-pack"; readonly report: ApplyPackReport }
  | { readonly status: "resynced-to-undo"; readonly results: readonly PackActionResult[] };

/**
 * `chm undo`'s own resync path (CHM-55): when a preview is recorded as in
 * flight, restoring from each adapter's own backup is not safe — a preview
 * session can settle more than once before it ends (arrowing through several
 * rows, each settle backed up over the last), so the backup Chameleon holds
 * by the time this runs may itself be an intermediate preview, not the pack
 * the user actually had before the picker opened. This instead re-derives
 * the right answer from ground truth: the pack `chm` last recorded as active
 * (readActivePackState), reapplied fresh to every target — or, when nothing
 * had ever been applied, the same backup-restoring `undoAppliedPack` a plain
 * `chm undo` already uses, since there is no applied pack for a fresh
 * reapply to target. Either branch clears the marker itself, as part of the
 * same authoritative apply/undo every other exit from a preview already goes
 * through. Returns `{ status: "not-in-flight" }` when there is nothing to
 * resync, so a caller can fall through to a plain `chm undo`. `userThemeDir`,
 * `statePath` and `previewStatePath` are only ever overridden by tests.
 */
export function resyncInterruptedPreview(userThemeDir?: string, statePath?: string, previewStatePath?: string): PreviewResyncOutcome {
  if (!isPreviewInFlight(previewStatePath)) return { status: "not-in-flight" };

  const state = readActivePackState(statePath);
  if (!state) {
    return { status: "resynced-to-undo", results: undoAppliedPack(previewStatePath) };
  }
  return { status: "resynced-to-pack", report: applyThemePack(state.slug, userThemeDir, statePath, previewStatePath) };
}

/**
 * Whether `target`'s own live config already matches `payloads` — the exact
 * values each adapter's own apply writes, so a mismatch means this target
 * has drifted from the pack it is being compared against (CHM-27). Only
 * ever called on a target already confirmed detected; see detectPackDrift.
 * `appearance` is the manifest's own, not a per-target payload — Claude Code
 * has no colour of its own to compare, only which of the six shipped themes
 * (see adapters/claude-code.ts) the pack's appearance maps to.
 *
 * oh-my-posh and herdr are checked against `payloads["windows-terminal"]` —
 * the pack's own scheme, the exact argument applyToTarget hands their own
 * `apply` — rather than against `payloads["oh-my-posh"]`/`payloads.herdr`
 * themselves (CHM-88). Both of those adapters repair colours out of that
 * scheme fresh on every apply, live, and a pack's own precomputed payload is
 * only as correct as the last time its build step ran; comparing against it
 * directly reported permanent, false drift the moment a repair shipped
 * without every bundled pack being regenerated. windows-terminal needs no
 * equivalent change: its own apply writes `payloads["windows-terminal"]`
 * verbatim, so there is nothing for it to repair live that this comparison
 * could fall behind.
 */
function targetMatchesPack(target: Target, payloads: ThemePackPayloads, appearance: Appearance): boolean {
  if (target === "windows-terminal") {
    return windowsTerminalMatchesScheme(createWindowsTerminalAdapter().read(), payloads["windows-terminal"]);
  }
  if (target === "oh-my-posh") {
    return ohMyPoshMatchesScheme(createDefaultOhMyPoshAdapter().read(), payloads["windows-terminal"]);
  }
  if (target === "claude-code") {
    return claudeCodeMatchesAppearance(createClaudeCodeAdapter().read(), appearance);
  }
  return herdrMatchesScheme(createHerdrAdapter().read(), payloads["windows-terminal"]);
}

/**
 * Every detected target whose live config disagrees with `slug`'s own pack —
 * what `ch current` and `ch doctor` both surface as drift (CHM-27). A target
 * that is not installed is never drift, same as everywhere else in this
 * file: absent is not failed, and there is nothing live to compare. A target
 * whose config cannot even be read — POSH_CONFIG and POSH_THEME both unset
 * after Oh My Posh was detected, say — counts as drifted rather than being
 * silently skipped, since "cannot confirm it matches" is itself the fact
 * worth surfacing.
 * `userThemeDir` is only ever overridden by tests.
 */
export function detectPackDrift(slug: string, userThemeDir?: string): readonly Target[] {
  const loaded = findLoadedPack(slug, userThemeDir);
  return TARGETS.filter((target) => {
    if (!detectSafely(() => adapterForTarget(target).detect())) return false;
    try {
      return !targetMatchesPack(target, loaded.pack.payloads, loaded.pack.manifest.appearance);
    } catch {
      return true;
    }
  });
}

export interface CurrentPackReport {
  readonly slug: string;
  readonly name: string | undefined;
  /**
   * Every detected target whose live config no longer matches this pack —
   * see detectPackDrift. Empty when the recorded pack is no longer loadable
   * at all, since there is nothing left to compare against — `name` being
   * undefined already carries that case.
   */
  readonly driftedTargets: readonly Target[];
  /**
   * True when CHM-55's preview marker is on disk — a picker genuinely
   * running in another pane, or one that never got a clean exit. `chm
   * current`/`chm doctor` must report this as a preview, never as drift: a
   * target that disagrees with the recorded pack because a preview is
   * showing it is a different fact from a target something else changed
   * behind Chameleon's back, even though driftedTargets looks the same
   * either way. See isPreviewInFlight.
   */
  readonly previewInFlight: boolean;
}

/**
 * The recorded active pack's own slug, alongside the loaded pack it
 * currently resolves to — undefined when nothing has ever been applied.
 * `loaded` itself comes back undefined when the recorded slug no longer
 * resolves to anything loadable (a dropped-in pack the user later removed,
 * say), which is the one "cannot check" case currentPack's own `name` and
 * activePackRoleHexes both need to agree on. Shared so the two can never
 * disagree about which pack is active.
 */
function loadedActivePack(userThemeDir: string | undefined, statePath: string | undefined): { slug: string; loaded: LoadedThemePack | undefined } | undefined {
  const state = readActivePackState(statePath);
  if (!state) return undefined;

  const { packs } = loadAllThemePacks(userThemeDir);
  return { slug: state.slug, loaded: packs.find((candidate) => candidate.pack.manifest.slug === state.slug) };
}

/**
 * The pack `ch` most recently applied, or undefined when nothing has been
 * applied yet. `name` comes back undefined when the recorded slug no longer
 * resolves to a loadable pack — a dropped-in pack the user later removed,
 * say — but the slug itself is still reported rather than treated as absent.
 * `statePath`, like `userThemeDir`, is only ever overridden by tests.
 */
export function currentPack(userThemeDir?: string, statePath?: string, previewStatePath?: string): CurrentPackReport | undefined {
  const active = loadedActivePack(userThemeDir, statePath);
  if (!active) return undefined;

  return {
    slug: active.slug,
    name: active.loaded?.pack.manifest.name,
    driftedTargets: active.loaded ? detectPackDrift(active.slug, userThemeDir) : [],
    previewInFlight: isPreviewInFlight(previewStatePath),
  };
}

/**
 * The active pack's own six role colours — ground, body, accent, muted,
 * success, error — or undefined when nothing has ever been applied, or the
 * recorded pack no longer resolves to a loadable one (the same "cannot
 * check" case currentPack's own `name` goes undefined for). This is `chm
 * statusline`'s only source of colour (CHM-68): reading the pack Chameleon
 * itself recorded as active, never a copy of its own, is what keeps the
 * status line from ever disagreeing with the terminal it is printed inside
 * of. `userThemeDir` and `statePath` are only ever overridden by tests.
 */
export function activePackRoleHexes(userThemeDir?: string, statePath?: string): Readonly<Record<Role, string>> | undefined {
  return loadedActivePack(userThemeDir, statePath)?.loaded?.pack.payloads["oh-my-posh"];
}

/**
 * The active pack's own three statusline meter colours — context, 5-hour and
 * 7-day (CHM-89) — or undefined under the same two conditions
 * activePackRoleHexes is undefined for. Reads the same recorded-active pack
 * activePackRoleHexes does, so the two can never disagree about which
 * pack's colours a rendered statusline is showing. `userThemeDir` and
 * `statePath` are only ever overridden by tests.
 */
export function activePackStatuslineMeterHexes(userThemeDir?: string, statePath?: string): Readonly<StatuslineMeterHexes> | undefined {
  return loadedActivePack(userThemeDir, statePath)?.loaded?.pack.payloads.statusline;
}

/**
 * The library `ch next`/`ch prev` both cycle over, plus where the active
 * pack sits in it — -1 when nothing is active or the active slug is no
 * longer in the list. Shared by nextPackSlug and prevPackSlug, which differ
 * only in which direction they step from `activeIndex` and where a -1
 * (nothing to step from) lands them.
 */
function loadPacksWithActiveIndex(
  userThemeDir: string | undefined,
  statePath: string | undefined,
): { packs: LoadedThemePack[]; activeIndex: number } {
  const { packs } = loadAllThemePacks(userThemeDir);
  if (packs.length === 0) {
    throw new Error("no packs available — nothing to cycle to");
  }

  const state = readActivePackState(statePath);
  const activeIndex = state ? packs.findIndex((candidate) => candidate.pack.manifest.slug === state.slug) : -1;
  return { packs, activeIndex };
}

/**
 * The slug that follows the active pack in `ch list` order (mergeThemePacksBySlug's
 * own slug order), wrapping past the end back to the start. With nothing yet
 * applied, or the active slug no longer in the list, this is the first pack
 * in that order — the same place wrapping already lands on. `statePath`,
 * like `userThemeDir`, is only ever overridden by tests.
 */
export function nextPackSlug(userThemeDir?: string, statePath?: string): string {
  const { packs, activeIndex } = loadPacksWithActiveIndex(userThemeDir, statePath);
  const nextIndex = (activeIndex + 1) % packs.length;
  return packs[nextIndex]!.pack.manifest.slug;
}

/**
 * The mirror of nextPackSlug, for `ch prev`: the slug that precedes the
 * active pack in `ch list` order, wrapping past the start back to the end.
 * With nothing yet applied, or the active slug no longer in the list, this
 * lands on the *last* pack in that order — the mirror image of
 * nextPackSlug's "first pack" default, so `ch next` then `ch prev` (or the
 * reverse) from a cold start land on each other's starting points.
 * `statePath`, like `userThemeDir`, is only ever overridden by tests.
 */
export function prevPackSlug(userThemeDir?: string, statePath?: string): string {
  const { packs, activeIndex } = loadPacksWithActiveIndex(userThemeDir, statePath);
  const currentIndex = activeIndex === -1 ? packs.length : activeIndex;
  const prevIndex = (currentIndex - 1 + packs.length) % packs.length;
  return packs[prevIndex]!.pack.manifest.slug;
}

/**
 * The slug at `ch list`'s `oneBasedRow` — the same order loadAllThemePacks
 * produces, so `ch <n>` can never point at a different pack than the nth
 * line of `ch list` does. Undefined when the row is out of range, which is
 * itself information: `ch <n>` reports it by name rather than falling
 * through to "no pack named …". `userThemeDir` is only ever overridden by
 * tests.
 */
export function packSlugAtRow(oneBasedRow: number, userThemeDir?: string): string | undefined {
  const { packs } = loadAllThemePacks(userThemeDir);
  return packs[oneBasedRow - 1]?.pack.manifest.slug;
}

export interface FamilySiblingResult {
  readonly family: string;
  readonly siblingSlug: string | undefined;
  readonly nearestAlternativeSlug: string | undefined;
}

/**
 * The active pack's own sibling in `appearance` — the pack sharing its
 * family with the other mode — or, when that family has none, the nearest
 * alternative: the first pack anywhere in `ch list` order already in
 * `appearance`. Naming an alternative is what keeps `ch dark`/`ch light`
 * from failing silently on a family with only one mode — see CLAUDE.md's
 * "say so and name the nearest alternative." `statePath`, like
 * `userThemeDir`, is only ever overridden by tests.
 */
export function findFamilySibling(appearance: Appearance, userThemeDir?: string, statePath?: string): FamilySiblingResult {
  const state = readActivePackState(statePath);
  if (!state) {
    throw new Error("no pack has been applied yet — nothing to switch");
  }

  const { packs } = loadAllThemePacks(userThemeDir);
  const active = packs.find((candidate) => candidate.pack.manifest.slug === state.slug);
  if (!active) {
    throw new Error(`the active pack "${state.slug}" is no longer available — run \`chm themes\` and pick one`);
  }

  const family = active.pack.manifest.family;
  const sibling = packs.find(
    (candidate) => candidate.pack.manifest.family === family && candidate.pack.manifest.appearance === appearance,
  );
  const nearestAlternative = sibling ? undefined : packs.find((candidate) => candidate.pack.manifest.appearance === appearance);

  return {
    family,
    siblingSlug: sibling?.pack.manifest.slug,
    nearestAlternativeSlug: nearestAlternative?.pack.manifest.slug,
  };
}

