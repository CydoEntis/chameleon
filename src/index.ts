/**
 * Public surface of the library half of Chameleon. The CLI in `cli.ts` is a
 * thin shell over these exports so the conversion and repair logic can be
 * tested without spawning a process.
 */

import { detectNerdFontInstalled, isNerdFontFamilyName, nerdFontInstallCommand } from "./adapters/fonts.js";
import { createHerdrAdapter, herdrMatchesRoleHexes, undoHerdr } from "./adapters/herdr.js";
import {
  createDefaultOhMyPoshAdapter,
  createOhMyPoshAdapter,
  ohMyPoshMatchesRoleHexes,
  OH_MY_POSH_WINGET_PACKAGE_ID,
  undoOhMyPosh,
} from "./adapters/oh-my-posh.js";
import { isWindows } from "./adapters/platform.js";
import { readActivePackState, writeActivePackState } from "./adapters/state.js";
import { loadUserThemePacks } from "./adapters/user-theme-packs.js";
import {
  createWindowsTerminalAdapter,
  selectedFontFace,
  undoWindowsTerminal,
  windowsTerminalMatchesScheme,
  WINDOWS_TERMINAL_WINGET_PACKAGE_ID,
} from "./adapters/windows-terminal.js";
import type { Appearance } from "./palette/palette.js";
import type { Scheme } from "./palette/scheme.js";
import { loadCuratedThemePacks, mergeThemePacksBySlug, type LoadedThemePack } from "./palette/theme-pack-library.js";
import type { ThemePackPayloads } from "./palette/theme-pack.js";

export const VERSION = "0.0.0";

/** Every target Chameleon can theme. An adapter exists per entry. */
export const TARGETS = ["windows-terminal", "oh-my-posh", "herdr"] as const;

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
export { createWindowsTerminalAdapter, undoWindowsTerminal } from "./adapters/windows-terminal.js";

export type { Layout, LayoutBlock, LayoutBlockName, LayoutSegment, OhMyPoshAdapter, OhMyPoshConfig, SegmentType } from "./adapters/oh-my-posh.js";
export {
  addSegment,
  buildLayoutSegment,
  createDefaultOhMyPoshAdapter,
  createOhMyPoshAdapter,
  isSegmentType,
  layoutBlocksOnSide,
  moveSegmentBetweenBlocks,
  readOhMyPoshLayout,
  removeSegment,
  reorderSegment,
  SEGMENT_TYPES,
  undoOhMyPosh,
  writeOhMyPoshLayout,
} from "./adapters/oh-my-posh.js";

export type { HerdrAdapter, HerdrConfig } from "./adapters/herdr.js";
export { createHerdrAdapter, undoHerdr } from "./adapters/herdr.js";

export type { UserThemePackLoadResult } from "./adapters/user-theme-packs.js";
export { defaultUserThemePackDir, loadUserThemePacks } from "./adapters/user-theme-packs.js";

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
 * Windows Terminal, and whether any detected target has drifted from the
 * pack `ch` last recorded as active (CHM-27) — see currentPack's own
 * driftedTargets. Herdr is detect-only and never offered an install command
 * — see CLAUDE.md, "Herdr stays detect-only, never installed." `userThemeDir`
 * and `statePath` are only ever overridden by tests.
 */
export function runDoctorChecks(userThemeDir?: string, statePath?: string): DoctorReport {
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
    ],
    nerdFont: checkNerdFont(),
    drift: currentPack(userThemeDir, statePath),
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
  return createHerdrAdapter();
}

/**
 * Applies `scheme` to `target`. Herdr's own `apply` also takes the pack's
 * `slug` — unlike the raw scheme, Herdr needs pack identity to pick a real
 * built-in theme name, see adapters/herdr.ts's herdrThemeNameFor — so this,
 * not a shared single-argument interface, is what lets that adapter's apply
 * differ in shape from windows-terminal's and oh-my-posh's.
 */
function applyToTarget(target: Target, scheme: Scheme, slug: string): void {
  if (target === "windows-terminal") return createWindowsTerminalAdapter().apply(scheme);
  if (target === "oh-my-posh") return createDefaultOhMyPoshAdapter().apply(scheme);
  return createHerdrAdapter().apply(scheme, slug);
}

/** `target`'s own `undo*` function — undoWindowsTerminal, undoOhMyPosh or undoHerdr — restoring it from the backup its adapter's most recent `apply` wrote. */
function undoTarget(target: Target): void {
  if (target === "windows-terminal") return undoWindowsTerminal();
  if (target === "oh-my-posh") return undoOhMyPosh();
  return undoHerdr();
}

/**
 * Runs `action` against `target`, reporting `succeededStatus` when it
 * completes and skipping the target outright — never a failure — when it is
 * not installed. Anything `action` throws is caught and reported by message,
 * so one target's problem never stops the targets after it from being tried.
 */
function runOnInstalledTarget(target: Target, succeededStatus: PackActionStatus, action: () => void): PackActionResult {
  if (!detectSafely(() => adapterForTarget(target).detect())) {
    return { target, status: "skipped", detail: "not installed" };
  }
  try {
    action();
    return { target, status: succeededStatus };
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

/** The loaded pack named `slug`, or a message naming `ch list` as the way to see what is actually available. */
function findLoadedPack(slug: string, userThemeDir: string | undefined): LoadedThemePack {
  const { packs } = loadAllThemePacks(userThemeDir);
  const loaded = packs.find((candidate) => candidate.pack.manifest.slug === slug);
  if (!loaded) {
    throw new Error(`no pack named "${slug}" — run \`ch list\` to see what's available`);
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
 */
export function applyThemePack(slug: string, userThemeDir?: string, statePath?: string): ApplyPackReport {
  const loaded = findLoadedPack(slug, userThemeDir);
  const scheme = loaded.pack.payloads["windows-terminal"];

  const results = TARGETS.map((target) => runOnInstalledTarget(target, "applied", () => applyToTarget(target, scheme, slug)));
  const isFullyApplied = !didAnyTargetFail(results);

  if (isFullyApplied && results.some((result) => result.status === "applied")) {
    writeActivePackState(slug, statePath);
  }

  return { slug, results, isFullyApplied };
}

/** Restores every detected target from the backup its own adapter's most recent `apply` wrote — the counterpart to applyThemePack. */
export function undoAppliedPack(): readonly PackActionResult[] {
  return TARGETS.map((target) => runOnInstalledTarget(target, "restored", () => undoTarget(target)));
}

/**
 * Whether `target`'s own live config already matches `payloads` — the exact
 * fields each adapter's own apply writes, so a mismatch means this target
 * has drifted from the pack it is being compared against (CHM-27). Only
 * ever called on a target already confirmed detected; see detectPackDrift.
 */
function targetMatchesPack(target: Target, payloads: ThemePackPayloads): boolean {
  if (target === "windows-terminal") {
    return windowsTerminalMatchesScheme(createWindowsTerminalAdapter().read(), payloads["windows-terminal"]);
  }
  if (target === "oh-my-posh") {
    return ohMyPoshMatchesRoleHexes(createDefaultOhMyPoshAdapter().read(), payloads["oh-my-posh"]);
  }
  return herdrMatchesRoleHexes(createHerdrAdapter().read(), payloads.herdr);
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
      return !targetMatchesPack(target, loaded.pack.payloads);
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
}

/**
 * The pack `ch` most recently applied, or undefined when nothing has been
 * applied yet. `name` comes back undefined when the recorded slug no longer
 * resolves to a loadable pack — a dropped-in pack the user later removed,
 * say — but the slug itself is still reported rather than treated as absent.
 * `statePath`, like `userThemeDir`, is only ever overridden by tests.
 */
export function currentPack(userThemeDir?: string, statePath?: string): CurrentPackReport | undefined {
  const state = readActivePackState(statePath);
  if (!state) return undefined;

  const { packs } = loadAllThemePacks(userThemeDir);
  const loaded = packs.find((candidate) => candidate.pack.manifest.slug === state.slug);
  return {
    slug: state.slug,
    name: loaded?.pack.manifest.name,
    driftedTargets: loaded ? detectPackDrift(state.slug, userThemeDir) : [],
  };
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
    throw new Error(`the active pack "${state.slug}" is no longer available — run \`ch list\` and pick one`);
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
