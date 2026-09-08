/**
 * Public surface of the library half of Chameleon. The CLI in `cli.ts` is a
 * thin shell over these exports so the conversion and repair logic can be
 * tested without spawning a process.
 */
import type { Role } from "./constants.js";
import { type DoctorContrastReport } from "./doctor.js";
import { type OhMyPoshOwnedConfigStatus } from "./adapters/oh-my-posh.js";
import { type Appearance } from "./palette/palette.js";
import { type LoadedThemePack } from "./palette/theme-pack-library.js";
import type { StatuslineMeterHexes } from "./palette/theme-pack.js";
export declare const VERSION = "0.0.0";
/** Every target Chameleon can theme. An adapter exists per entry. */
export declare const TARGETS: readonly ["windows-terminal", "oh-my-posh", "herdr", "claude-code"];
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
export type { PackAttribution, StatuslineMeterHexes, ThemePack, ThemePackManifest, ThemePackPayloads, UserPackManifest, } from "./palette/theme-pack.js";
export { buildThemePack, parseThemePack, parseUserPackManifest, ThemePackSchema, UserPackManifestSchema, } from "./palette/theme-pack.js";
export type { LoadedThemePack, ThemePackOrigin } from "./palette/theme-pack-library.js";
export { loadCuratedThemePacks, mergeThemePacksBySlug } from "./palette/theme-pack-library.js";
export type { WindowsTerminalAdapter, WindowsTerminalSettings } from "./adapters/windows-terminal.js";
export { createWindowsTerminalAdapter, removeDeadWindowsTerminalSchemeForks, undoWindowsTerminal } from "./adapters/windows-terminal.js";
export type { Layout, LayoutBlock, LayoutBlockName, LayoutSegment, OhMyPoshAdapter, OhMyPoshConfig, OhMyPoshOwnedConfigStatus, OhMyPoshSeedState, SegmentType, } from "./adapters/oh-my-posh.js";
export { addSegment, buildLayoutSegment, createDefaultOhMyPoshAdapter, createOhMyPoshAdapter, isSegmentType, layoutBlocksOnSide, moveSegmentBetweenBlocks, readOhMyPoshLayout, readOhMyPoshSeedState, removeSegment, reorderSegment, reseedOhMyPoshOwnedConfig, SEGMENT_TYPES, undoOhMyPosh, writeOhMyPoshLayout, } from "./adapters/oh-my-posh.js";
export type { HerdrAdapter, HerdrConfig } from "./adapters/herdr.js";
export { createHerdrAdapter, undoHerdr } from "./adapters/herdr.js";
export type { ClaudeCodeAdapter, ClaudeCodeSettings } from "./adapters/claude-code.js";
export { createClaudeCodeAdapter, describeStatusLine, disableClaudeCodeStatusLine, enableClaudeCodeStatusLine, isClaudeCodeStatusLineEnabled, undoClaudeCode, } from "./adapters/claude-code.js";
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
export declare function loadAllThemePacks(userThemeDir?: string): {
    packs: LoadedThemePack[];
    warnings: readonly string[];
};
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
export declare function runDoctorChecks(userThemeDir?: string, statePath?: string, previewStatePath?: string): DoctorReport;
/** One target's outcome from applying or undoing a pack. A target that is not installed is "skipped", never "failed" — see CLAUDE.md's "a target that is absent is skipped, never a failure." */
export type PackActionStatus = "applied" | "restored" | "skipped" | "failed";
export interface PackActionResult {
    readonly target: Target;
    readonly status: PackActionStatus;
    readonly detail?: string | undefined;
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
export declare function didAnyTargetFail(results: readonly PackActionResult[]): boolean;
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
export declare function applyThemePack(slug: string, userThemeDir?: string, statePath?: string, previewStatePath?: string, originalSnapshotPath?: string): ApplyPackReport;
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
export declare function previewThemePackToFileTargets(slug: string, userThemeDir?: string): readonly PackActionResult[];
/**
 * Restores every detected target from the backup its own adapter's most
 * recent `apply` wrote — the counterpart to applyThemePack. Also clears
 * CHM-55's own preview-in-flight marker, for the same reason applyThemePack
 * does: a real `chm undo` is an authoritative word on target state too.
 */
export declare function undoAppliedPack(previewStatePath?: string): readonly PackActionResult[];
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
export declare function restoreOriginal(previewStatePath?: string, snapshotPath?: string): readonly PackActionResult[];
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
export declare function beginThemePreview(originalSlug: string | undefined, previewStatePath?: string): void;
/**
 * Whether a theme preview is currently recorded as in flight — either a
 * picker genuinely running in another pane, or one that never cleaned up
 * after itself. `previewStatePath` is only ever overridden by tests.
 */
export declare function isPreviewInFlight(previewStatePath?: string): boolean;
export type PreviewResyncOutcome = {
    readonly status: "not-in-flight";
} | {
    readonly status: "resynced-to-pack";
    readonly report: ApplyPackReport;
} | {
    readonly status: "resynced-to-undo";
    readonly results: readonly PackActionResult[];
};
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
export declare function resyncInterruptedPreview(userThemeDir?: string, statePath?: string, previewStatePath?: string): PreviewResyncOutcome;
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
export declare function detectPackDrift(slug: string, userThemeDir?: string): readonly Target[];
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
 * The pack `ch` most recently applied, or undefined when nothing has been
 * applied yet. `name` comes back undefined when the recorded slug no longer
 * resolves to a loadable pack — a dropped-in pack the user later removed,
 * say — but the slug itself is still reported rather than treated as absent.
 * `statePath`, like `userThemeDir`, is only ever overridden by tests.
 */
export declare function currentPack(userThemeDir?: string, statePath?: string, previewStatePath?: string): CurrentPackReport | undefined;
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
export declare function activePackRoleHexes(userThemeDir?: string, statePath?: string): Readonly<Record<Role, string>> | undefined;
/**
 * The active pack's own three statusline meter colours — context, 5-hour and
 * 7-day (CHM-89) — or undefined under the same two conditions
 * activePackRoleHexes is undefined for. Reads the same recorded-active pack
 * activePackRoleHexes does, so the two can never disagree about which
 * pack's colours a rendered statusline is showing. `userThemeDir` and
 * `statePath` are only ever overridden by tests.
 */
export declare function activePackStatuslineMeterHexes(userThemeDir?: string, statePath?: string): Readonly<StatuslineMeterHexes> | undefined;
/**
 * The slug that follows the active pack in `ch list` order (mergeThemePacksBySlug's
 * own slug order), wrapping past the end back to the start. With nothing yet
 * applied, or the active slug no longer in the list, this is the first pack
 * in that order — the same place wrapping already lands on. `statePath`,
 * like `userThemeDir`, is only ever overridden by tests.
 */
export declare function nextPackSlug(userThemeDir?: string, statePath?: string): string;
/**
 * The mirror of nextPackSlug, for `ch prev`: the slug that precedes the
 * active pack in `ch list` order, wrapping past the start back to the end.
 * With nothing yet applied, or the active slug no longer in the list, this
 * lands on the *last* pack in that order — the mirror image of
 * nextPackSlug's "first pack" default, so `ch next` then `ch prev` (or the
 * reverse) from a cold start land on each other's starting points.
 * `statePath`, like `userThemeDir`, is only ever overridden by tests.
 */
export declare function prevPackSlug(userThemeDir?: string, statePath?: string): string;
/**
 * The slug at `ch list`'s `oneBasedRow` — the same order loadAllThemePacks
 * produces, so `ch <n>` can never point at a different pack than the nth
 * line of `ch list` does. Undefined when the row is out of range, which is
 * itself information: `ch <n>` reports it by name rather than falling
 * through to "no pack named …". `userThemeDir` is only ever overridden by
 * tests.
 */
export declare function packSlugAtRow(oneBasedRow: number, userThemeDir?: string): string | undefined;
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
export declare function findFamilySibling(appearance: Appearance, userThemeDir?: string, statePath?: string): FamilySiblingResult;
