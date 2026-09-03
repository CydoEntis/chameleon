/**
 * Public surface of the library half of Chameleon. The CLI in `cli.ts` is a
 * thin shell over these exports so the conversion and repair logic can be
 * tested without spawning a process.
 */

import { detectNerdFontInstalled, isNerdFontFamilyName, nerdFontInstallCommand } from "./adapters/fonts.js";
import { createHerdrAdapter } from "./adapters/herdr.js";
import { createOhMyPoshAdapter, OH_MY_POSH_WINGET_PACKAGE_ID } from "./adapters/oh-my-posh.js";
import { loadUserThemePacks } from "./adapters/user-theme-packs.js";
import {
  createWindowsTerminalAdapter,
  selectedFontFace,
  WINDOWS_TERMINAL_WINGET_PACKAGE_ID,
} from "./adapters/windows-terminal.js";
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

export type { Layout, LayoutBlockName, LayoutSegment, OhMyPoshAdapter, OhMyPoshConfig, SegmentType } from "./adapters/oh-my-posh.js";
export {
  addSegment,
  buildLayoutSegment,
  createOhMyPoshAdapter,
  isSegmentType,
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
