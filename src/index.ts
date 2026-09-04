/**
 * Public surface of the library half of Chameleon. The CLI in `cli.ts` is a
 * thin shell over these exports so the conversion and repair logic can be
 * tested without spawning a process.
 */

import { detectNerdFontInstalled, isNerdFontFamilyName, nerdFontInstallCommand } from "./adapters/fonts.js";
import { createHerdrAdapter, undoHerdr } from "./adapters/herdr.js";
import { createOhMyPoshAdapter, OH_MY_POSH_WINGET_PACKAGE_ID, undoOhMyPosh } from "./adapters/oh-my-posh.js";
import { readActivePackState, writeActivePackState } from "./adapters/state.js";
import { loadUserThemePacks } from "./adapters/user-theme-packs.js";
import {
  createWindowsTerminalAdapter,
  selectedFontFace,
  undoWindowsTerminal,
  WINDOWS_TERMINAL_WINGET_PACKAGE_ID,
} from "./adapters/windows-terminal.js";
import type { Appearance } from "./palette/palette.js";
import type { Scheme } from "./palette/scheme.js";
import { loadCuratedThemePacks, mergeThemePacksBySlug, type LoadedThemePack } from "./palette/theme-pack-library.js";

export const VERSION = "0.0.0";

/** Every target Chameleon can theme. An adapter exists per entry. */
export const TARGETS = ["windows-terminal", "oh-my-posh", "herdr"] as const;

export type Target = (typeof TARGETS)[number];

export type { Role } from "./constants.js";
export { isKnownRole, ROLES } from "./constants.js";

export type { Appearance, MeasuredColor, Palette, SlotName } from "./palette/palette.js";
export { toPalette } from "./palette/palette.js";
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

/** One target's `ch doctor` row: whether it is installed, and the one-line command to fix it when it is not. */
export interface DoctorTargetCheck {
  readonly target: Target;
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

function checkTarget(target: Target, isInstalled: boolean, wingetPackageId: string | undefined): DoctorTargetCheck {
  return {
    target,
    isInstalled,
    installCommand: isInstalled || !wingetPackageId ? undefined : wingetInstallCommand(wingetPackageId),
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
 * installed, and whether a Nerd Font is installed and actually selected in
 * Windows Terminal. Herdr is detect-only and never offered an install
 * command — see CLAUDE.md, "Herdr stays detect-only, never installed."
 */
export function runDoctorChecks(): DoctorReport {
  return {
    targets: [
      checkTarget("windows-terminal", detectSafely(() => createWindowsTerminalAdapter().detect()), WINDOWS_TERMINAL_WINGET_PACKAGE_ID),
      checkTarget("oh-my-posh", detectSafely(() => createOhMyPoshAdapter().detect()), OH_MY_POSH_WINGET_PACKAGE_ID),
      checkTarget("herdr", detectSafely(() => createHerdrAdapter().detect()), undefined),
    ],
    nerdFont: checkNerdFont(),
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

/** The slice of a target's adapter this file needs: enough to detect it and hand it a scheme, never the target-specific `read`/`reload`. */
interface ApplicableTargetAdapter {
  detect(): boolean;
  apply(scheme: Scheme): void;
}

function adapterForTarget(target: Target): ApplicableTargetAdapter {
  if (target === "windows-terminal") return createWindowsTerminalAdapter();
  if (target === "oh-my-posh") return createOhMyPoshAdapter();
  return createHerdrAdapter();
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
 * scheme is handed to all three. The pack is recorded as the active one as
 * soon as at least one target actually changed, which is what lets
 * `ch current`/`ch next`/`ch dark`/`ch light` work on a machine where only
 * some targets are installed. `statePath`, like `userThemeDir`, is only ever
 * overridden by tests; `ch` itself always reads and writes the real one.
 */
export function applyThemePack(slug: string, userThemeDir?: string, statePath?: string): ApplyPackReport {
  const loaded = findLoadedPack(slug, userThemeDir);
  const scheme = loaded.pack.payloads["windows-terminal"];

  const results = TARGETS.map((target) => runOnInstalledTarget(target, "applied", () => adapterForTarget(target).apply(scheme)));

  if (results.some((result) => result.status === "applied")) {
    writeActivePackState(slug, statePath);
  }

  return { slug, results };
}

/** Restores every detected target from the backup its own adapter's most recent `apply` wrote — the counterpart to applyThemePack. */
export function undoAppliedPack(): readonly PackActionResult[] {
  return TARGETS.map((target) => runOnInstalledTarget(target, "restored", () => undoTarget(target)));
}

export interface CurrentPackReport {
  readonly slug: string;
  readonly name: string | undefined;
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
  return { slug: state.slug, name: loaded?.pack.manifest.name };
}

/**
 * The slug that follows the active pack in `ch list` order (mergeThemePacksBySlug's
 * own slug order), wrapping past the end back to the start. With nothing yet
 * applied, or the active slug no longer in the list, this is the first pack
 * in that order — the same place wrapping already lands on. `statePath`,
 * like `userThemeDir`, is only ever overridden by tests.
 */
export function nextPackSlug(userThemeDir?: string, statePath?: string): string {
  const { packs } = loadAllThemePacks(userThemeDir);
  if (packs.length === 0) {
    throw new Error("no packs available — nothing to cycle to");
  }

  const state = readActivePackState(statePath);
  const currentIndex = state ? packs.findIndex((candidate) => candidate.pack.manifest.slug === state.slug) : -1;
  const nextIndex = (currentIndex + 1) % packs.length;
  return packs[nextIndex]!.pack.manifest.slug;
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
