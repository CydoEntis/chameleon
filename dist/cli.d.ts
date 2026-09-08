#!/usr/bin/env node
import { z } from "zod";
import { type Appearance, type DoctorReport, type LoadedThemePack, type LockInfo, type PackActionResult, type Role, type Scheme, type StatuslineMeterHexes } from "./index.js";
/**
 * One line of `chm themes` output: two colour swatches, then the name a
 * person actually reads — never the slug (CHM-42's "show the name, drop the
 * slug from the display"). Only a user pack carries a marker; the bundled
 * default gets none, since a tag on every row means nothing — see CLAUDE.md,
 * "Drop (bundled) entirely — it is the default and it is on every row."
 */
export declare function formatThemeLine(loaded: LoadedThemePack): string;
/**
 * `chm doctor`'s Claude Code row grows one more line naming the restart it
 * needs — undefined, so the row prints nothing extra, when Claude Code is not
 * installed. An apply already says this (see reloadClaudeCode), but doctor is
 * what someone runs when a theme looks wrong, and a running session holding a
 * stale theme is the single most common reason for that (CHM-65). Whether a
 * session is actually running is never checked — the note is unconditional,
 * same as an apply's own — see CHM-65's "Out of scope."
 */
export declare function formatClaudeCodeRestartNote(isInstalled: boolean): string | undefined;
/**
 * `chm doctor`'s own Claude Code statusline row (CHM-86): which statusLine is
 * actually configured right now, and whether Chameleon's own choice to
 * manage it is enabled or disabled — two different facts, since a user can
 * disable Chameleon's management while some other statusLine (its own last
 * write, or one hand-edited back in) is still what is running. Undefined
 * when Claude Code is not installed, or its settings.json cannot be read.
 */
export declare function formatClaudeCodeStatusLineLine(statusLine: DoctorReport["claudeCodeStatusLine"]): string | undefined;
/**
 * `chm doctor`'s own line naming which config Chameleon owns for Oh My Posh
 * and which config it was seeded from — CHM-74's own "reports which config
 * Chameleon owns and which config it was seeded from." Undefined before the
 * very first seed, when there is nothing to report yet. A config seeded
 * before this was tracked (or migrated from CHM-63's own deleted bundled
 * prompt layout) reads as "unknown," never a guess.
 */
export declare function formatOhMyPoshOwnedConfigLine(owned: DoctorReport["ohMyPoshOwnedConfig"]): string | undefined;
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
export declare function formatDriftLine(drift: DoctorReport["drift"]): string;
/**
 * Whether `chm doctor`'s drift row should turn into a non-zero exit: either a
 * target no longer matches the recorded pack, or the recorded pack could not
 * be loaded at all, so the comparison never ran (CHM-34) — the exit code
 * must not read as success in a case that was never checked.
 */
export declare function hasDrift(drift: DoctorReport["drift"]): boolean;
/**
 * `chm doctor`'s own contrast lines (CHM-79): every pair this machine's real
 * config files fail, one line each, naming the pair and what it measured —
 * "herdr overlay0 on active_row_bg measures 3.10, below its floor of 4.5",
 * never a bare pass/fail. A target with nothing to report (not installed, no
 * config found, or nothing themed yet) prints nothing at all — this is only
 * ever a list of problems, not a status board.
 */
export declare function formatContrastFailureLines(contrast: DoctorReport["contrast"]): string[];
/**
 * The slice of Claude Code's own statusline payload this command reads —
 * see CLAUDE.md's "confirm the payload's real shape... do not assume field
 * names": every field below is exactly as documented at
 * https://docs.claude.com/en/docs/claude-code/statusline (confirmed against
 * that page for CHM-83, including the two `rate_limits` fields), and
 * everything else Claude Code sends is passed through unvalidated, never
 * inspected. Every field is optional — this command must still print a
 * usable line when the payload is missing pieces, not just when it is
 * missing outright (see buildStatuslineText). `rate_limits` itself, and each
 * window inside it, is independently absent on a plan with no rate limits
 * and before the first API response of a session — see
 * statuslineRateLimitPercent.
 */
declare const StatuslinePayloadSchema: z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodObject<{
        display_name: z.ZodOptional<z.ZodString>;
    }, z.core.$catchall<z.ZodUnknown>>>;
    workspace: z.ZodOptional<z.ZodObject<{
        current_dir: z.ZodOptional<z.ZodString>;
    }, z.core.$catchall<z.ZodUnknown>>>;
    context_window: z.ZodOptional<z.ZodObject<{
        used_percentage: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    }, z.core.$catchall<z.ZodUnknown>>>;
    rate_limits: z.ZodOptional<z.ZodObject<{
        five_hour: z.ZodOptional<z.ZodObject<{
            used_percentage: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        }, z.core.$catchall<z.ZodUnknown>>>;
        seven_day: z.ZodOptional<z.ZodObject<{
            used_percentage: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        }, z.core.$catchall<z.ZodUnknown>>>;
    }, z.core.$catchall<z.ZodUnknown>>>;
}, z.core.$catchall<z.ZodUnknown>>;
export type StatuslinePayload = z.infer<typeof StatuslinePayloadSchema>;
/**
 * Parses Claude Code's own stdin payload, or undefined for anything that is
 * not the JSON object this command expects — malformed JSON, or valid JSON
 * that is not even an object. Never throws: an unreadable payload is exactly
 * the case CLAUDE.md's "fail to a plain, uncoloured line ... and exit 0"
 * exists for, not a reason to crash.
 */
export declare function parseStatuslinePayload(rawStdin: string): StatuslinePayload | undefined;
/**
 * `chm statusline`'s own one-line output: the model name, the working
 * directory's own name, the git branch (when `cwd` is inside a repository),
 * and a meter each for context-window, 5-hour and 7-day usage (CHM-83) —
 * every one of them omitted, never rendered at a false 0%, when the payload
 * does not carry it (see statuslineContextPercent/statuslineRateLimitPercent).
 * Coloured from the active pack's own accent/body/success/error roles
 * (`roleHexes`) and its three dedicated statusline meter colours
 * (`meterHexes` — CHM-89's StatuslineMeterHexes) so the line can never show a
 * colour the terminal itself is not also showing (CHM-68) — plain text, no
 * escape codes at all, when both are undefined: no pack has ever been
 * applied, or the recorded one could not be loaded. Before CHM-89 all three
 * meters shared `roleHexes.muted`, which read as one undifferentiated colour
 * across the bulk of the line — `meterHexes` gives each its own, distinct
 * colour instead, drawn from the pack the same way `roleHexes` is (see
 * palette/theme-pack.ts's resolveStatuslineMeterHexes). `gitBranch` is the
 * caller's own best-effort read (see adapters/git.ts's currentGitBranch),
 * passed in rather than read here so this stays a pure formatter, testable
 * without a real git repository.
 */
export declare function buildStatuslineText(payload: StatuslinePayload | undefined, roleHexes: Readonly<Record<Role, string>> | undefined, meterHexes: Readonly<StatuslineMeterHexes> | undefined, gitBranch: string | undefined): string;
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
export declare function formatNoteworthyResultLines(results: readonly PackActionResult[]): {
    readonly stdoutLines: readonly string[];
    readonly stderrLines: readonly string[];
};
/** `chm`'s own "someone else is writing" message — names the pid and the command holding the lock, rather than silently racing it or queueing behind it. `holder` is only ever undefined when the lock file exists but could not be read — still held by someone, just not nameable. */
export declare function formatLockHeldMessage(holder: LockInfo | undefined): string;
/** `chm current`'s own message when Chameleon's write lock is held live (CHM-56) — a target's live config can legitimately disagree with the recorded pack for as long as a debounced preview write is in flight, and that is not the drift `chm current`/`chm doctor` exist to catch. */
export declare function formatPreviewInProgressLine(holder: LockInfo): string;
/** One picker row: enough to paint its four chromatic-role dots (CHM-69), filter it by slug or name, apply it, and preview it live. Ground and body are no longer carried here — CHM-69 dropped the row's full-background paint they were for, in favour of the four dots below, which is where bundled packs actually differ. */
export interface PickerEntry {
    readonly slug: string;
    readonly name: string;
    readonly origin: string;
    readonly accentHex: string;
    readonly successHex: string;
    readonly errorHex: string;
    readonly mutedHex: string;
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
    /**
     * Which group this entry sits under. Measured from the scheme by the
     * contrast engine rather than declared by whoever packaged it — see
     * palette/palette.ts — so the grouping is the same judgement `chm dark`
     * and `chm light` already act on, not a second label that could disagree
     * with it.
     */
    readonly appearance: Appearance;
}
export declare function toPickerEntry(loaded: LoadedThemePack): PickerEntry;
/**
 * Entries with all the dark packs before all the light ones, each group
 * otherwise in the order it already arrived in — so a family's own packs
 * stay where their curated order put them, and only the split is new.
 * Sorting rather than filtering keeps every pack one arrow key away, which a
 * mode toggle would not: 63 packs is past the point where a flat list scans,
 * but it is not a reason to hide half of them behind a keystroke nobody
 * discovers.
 */
export declare function groupedByAppearance(entries: readonly PickerEntry[]): PickerEntry[];
/** The header drawn above the first row of each group — "Dark (41)", counted across the whole list rather than the visible window. */
export declare function appearanceGroupHeading(appearance: Appearance, entries: readonly PickerEntry[]): string;
/**
 * Repaints the terminal's own colours instantly: OSC 4 sets the 16 ANSI
 * slots an application paints text with, OSC 10/11/12 set the foreground,
 * background and cursor outside any one of those slots. No config file is
 * touched and nothing here is written that `chm undo` would ever need to
 * know about — see CLAUDE.md's "Preview the terminal with escape sequences,
 * not file writes."
 */
export declare function buildTerminalPreviewSequence(scheme: Scheme): string;
/**
 * The reverse of buildTerminalPreviewSequence, for Esc when no pack was
 * active before the picker opened: resets every ANSI slot and the
 * foreground/background/cursor to the terminal's own configured colours
 * (OSC 104 and 110/111/112) rather than previewing a scheme that was never
 * actually applied. See runInteractivePicker's restoreTerminalPreview.
 */
export declare function buildTerminalResetSequence(): string;
/**
 * Schedules `applyToFileTargets` to run once movement settles, superseding
 * rather than queuing: calling `schedule` again before the pending one has
 * fired cancels it outright, so holding an arrow key through the whole list
 * costs one file apply, never one per row (CHM-52). `cancel` is what Enter
 * and Esc both call before they take over the final write themselves — a
 * settle firing after the picker has already closed would race whatever
 * commit or restore just ran.
 */
export declare function createSettledFileTargetPreview(applyToFileTargets: (slug: string) => void, debounceMs?: number): {
    schedule(slug: string): void;
    cancel(): void;
};
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
 * CHM-66's "every row the same width", so the four dots and the name column
 * both line up cleanly down the whole list. Computed once per frame by
 * computePickerRowLayout, never per row, so two rows can never disagree
 * about where the name column starts.
 */
interface PickerRowLayout {
    readonly gutterDigits: number;
    readonly contentWidth: number;
}
/**
 * One picker row: a plain, unpainted one-character marker, the row's number,
 * four dots painted in that pack's own accent/success/error/muted (CHM-69 —
 * "the four dots are the only colour in a row"), then the name in the
 * terminal's own foreground, like any other list. CHM-64/66's full-row
 * background is gone: with most bundled packs' grounds within a shade of
 * each other, painting the row in its own ground made nearly every row look
 * the same — the chromatic roles are where packs actually differ. Padded to
 * `layout.contentWidth` off the plain (uncoloured) rendering, so a coloured
 * dot's escape codes are never counted as display width; the highlighted row
 * adds bold (SGR_BOLD) rather than CHM-64's reverse video, which would have
 * swapped each dot's own foreground into its background instead of just
 * standing the row out. The slug stays typeable for the filter, but is
 * never shown.
 */
export declare function renderPickerRow(entry: PickerEntry, position: PickerRowPosition, layout: PickerRowLayout): string;
/**
 * Every line of one picker frame: the fixed navigation header, the filter
 * line once someone has typed anything, one row per visible entry — scrolled
 * to keep the highlight in view rather than every matching entry regardless
 * of list length (CHM-66) — and a footer naming how many more entries sit
 * below the window. `appliedSlug` is the pack actually applied (see
 * runInteractivePicker's own `originalSlug`), never the one merely
 * previewed by the highlight, so the `*` marker does not chase the cursor
 * around the list.
 *
 * `entries` must already be grouped by appearance — groupedByAppearance is
 * what does it, once, where the list is built. This cannot sort them itself:
 * `highlightedIndex` indexes the caller's own array, so reordering here would
 * point the highlight at a different entry than the one the caller thinks is
 * selected. Passing an ungrouped list is not a crash, just a heading above
 * every row where the appearance changes.
 */
export declare function renderPickerFrame(entries: readonly PickerEntry[], highlightedIndex: number, filterText: string, appliedSlug: string | undefined): string[];
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
export declare function shouldRestoreOriginalSelectionOnExit(originalSlug: string | undefined, currentActiveSlug: string | undefined): boolean;
/**
 * Whether `chm themes` should print the plain list rather than open the
 * picker: an explicit `--list`, or either stream not being a real TTY — a
 * pipe on stdout, or no keyboard behind stdin. See CHM-44's "chm themes
 * --list, and the same output automatically when stdout is not a TTY, so
 * piping still works."
 */
export declare function wantsPlainThemeList(args: readonly string[], isStdinTTY: boolean, isStdoutTTY: boolean): boolean;
/**
 * Strips everything but letters and digits, and lowercases what is left —
 * so "Catppuccin Mocha", "catppuccin-mocha" and "catppuccin_mocha" all
 * collapse to the same comparison key regardless of the separator or case a
 * person typed (CHM-42's "matched case- and separator-insensitively").
 */
export declare function normalizeThemeQuery(value: string): string;
export type ThemeQueryResult = {
    readonly status: "resolved";
    readonly loaded: LoadedThemePack;
} | {
    readonly status: "ambiguous";
    readonly candidates: readonly LoadedThemePack[];
} | {
    readonly status: "unknown";
    readonly closest: LoadedThemePack | undefined;
};
/**
 * Resolves what a person typed after `chm` — a slug, a quoted display name,
 * or several bare words meant to be read as one name ("chm catppuccin
 * mocha") — against the loaded pack list. Matching is case- and
 * separator-insensitive (normalizeThemeQuery): an exact match is tried
 * first, then a prefix match, so "chm catppuccin" reports every Catppuccin
 * variant as ambiguous rather than silently guessing one — see CHM-42's "an
 * ambiguous prefix lists the candidates rather than guessing."
 */
export declare function resolveThemeQuery(packs: readonly LoadedThemePack[], rawTokens: readonly string[]): ThemeQueryResult;
export declare const USAGE = "usage: chm <command> [args]\n\nchm themes             browse and pick a theme interactively, with live preview\nchm themes --list      list every theme, with swatches, instead of picking\nchm pick               alias for `chm themes`\nchm <theme>            apply a theme, by slug or by name\nchm dark / chm light   flip mode, same family\nchm next / chm prev    cycle either way\nchm current            print the active theme\nchm undo               put back the most recently applied theme\nchm original           put back everything, exactly as it was before Chameleon's first apply\nchm doctor             what is installed\nchm edit ...           edit the Oh My Posh prompt layout\nchm reseed <path>      seed (or re-seed) the Oh My Posh config Chameleon owns from <path>\nchm clean              remove dead Windows Terminal scheme forks an earlier version left behind\nchm statusline         print one themed line for Claude Code's own status bar\nchm statusline on      have Chameleon manage Claude Code's statusLine, replacing whatever is there now\nchm statusline off     leave Claude Code's statusLine alone on every apply from now on\n\nrun `chm themes` to browse what you can apply\n";
export {};
