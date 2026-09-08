/**
 * Resolves Herdr's selected-row background against its own sidebar, and the
 * text tokens rendered on top of it — the fix CHM-50 asks for after CHM-48
 * traded one broken state for another, refined again by CHM-75 after CHM-50
 * traded a third. CHM-48 measured the sidebar's selected row (subtext0 on
 * active_row_bg) failing MUTED_MIN_RATIO in 22 of 26 bundled packs, and
 * fixed it by pulling active_row_bg toward sidebar_bg — but that made
 * row-vs-sidebar itself collapse below 1.15 in 17 of the 26, dracula-dark
 * measuring 1.00, the same colour: the row was readable and no longer
 * visibly selected at all. CHM-50 fixed that by holding row visibility as a
 * hard floor and repairing subtext0 to clear MUTED_MIN_RATIO against
 * whatever the row settled on — but MUTED_MIN_RATIO is the floor for text a
 * reader is meant to skim past, and on the selected row subtext0 carries the
 * agent's own title and provider, the thing being read. monokai-dark cleared
 * exactly that floor at 3.33 (see herdr.test.ts's own CHM-50 fixture) —
 * legal, and the least readable text on screen.
 *
 * CHM-75 raises subtext0's own floor on active_row_bg specifically to
 * TEXT_MIN_RATIO, without raising it everywhere: subtext0 still only owes
 * MUTED_MIN_RATIO to sidebar_bg and every other surface Herdr paints it on,
 * or it stops reading as de-emphasised there to survive a background it
 * rarely sits on. The preferred move is active_row_bg's own fraction between
 * ground and body — pulled back toward ground until subtext0's own
 * (unmodified) value reads against it, never below
 * ACTIVE_ROW_MIN_VISIBLE_RATIO's own hard floor — rather than subtext0 being
 * pushed further from ground to chase a background that is rare across the
 * whole UI (see resolveActiveRowBackground). That move alone is not enough
 * for most bundled packs: subtext0's own resolved luminance sits far closer
 * to body's than the row's own visibility floor lets the row reach, so
 * subtext0 also repairs a second time against the settled row specifically
 * (see repairMutedForActiveRow) — reaching for TEXT_MIN_RATIO, capped short
 * of reading as prominent as body, and (rarely, on the lightest-contrast
 * packs) settling for less than TEXT_MIN_RATIO when body itself leaves no
 * room for both, the same "maximise, never demand" shape CHM-30 already
 * uses for the selection highlight.
 *
 * CHM-80 found that CHM-75's own fix was still satisfying
 * ACTIVE_ROW_MIN_VISIBLE_RATIO the expensive way: resolveActiveRowBackground
 * held the row as close to `idealFraction` (and therefore as visible) as
 * subtext0's own readability would tolerate, on the assumption that a more
 * visible row was always the better outcome short of that hard limit. It is
 * not. monokai-dark's row settled at 2.12 against ground, a mid grey
 * (#585a52), and subtext0 then had to be dragged to 4.63 to read against it
 * at all — legal, and the least readable text on screen, because a mid grey
 * and a colour dragged toward body both sit in the light half of the scale
 * with almost no separation left between them. The row is a band spanning
 * the full sidebar width; a reader tells it apart by its edges, not by its
 * own luminance against ground, so it needs far less separation than that
 * reasoning assumed (see ACTIVE_ROW_MIN_VISIBLE_RATIO's own doc comment).
 * CHM-80 both lowers that floor and inverts the search: the row now takes
 * the smallest fraction that clears it, never the largest subtext0 happens
 * to permit — which turns out to also be the fraction friendliest to
 * subtext0's own readability, so the two were never actually in tension
 * (see resolveActiveRowBackground's own doc comment).
 *
 * Order follows from that: subtext0 is repaired against sidebar_bg and
 * every other surface the caller enumerates (e.g. Herdr's panel_bg and
 * selection_bg) via repairForegroundAgainstBackgrounds (CHM-40) *before*
 * active_row_bg is chosen, since active_row_bg's own fraction search needs
 * to know what subtext0 will actually be. Text is repaired last, against
 * every surface including the now-settled active_row_bg, the same
 * CHM-40 machinery. Only when text cannot clear TEXT_MIN_RATIO across every
 * surface, or subtext0 cannot clear even MUTED_MIN_RATIO against the
 * settled row, does the row retreat to the plain, unrepaired ideal blend
 * instead — and that trade is reported back, never made silently.
 */
import type { Scheme } from "./scheme.js";
/**
 * How far between ground and body the selected row sits before any repair —
 * a row is meant to read as a slightly raised surface, the same tone as
 * Herdr's own surface0 (see adapters/herdr.ts's surface scale), not a
 * colour of its own. Shared rather than redefined per caller: theme-pack.ts
 * (build time) and herdr.ts (live apply) must never disagree about what
 * this fraction is, the same "one source of truth" contract
 * resolveSelectionAndBody already holds for the selection highlight.
 */
export declare const ACTIVE_ROW_IDEAL_FRACTION: number;
export interface ResolvedSurfaceBackground {
    readonly hex: string;
    readonly wasRepaired: boolean;
}
/**
 * Resolves the selected row's own background against two floors:
 * ACTIVE_ROW_MIN_VISIBLE_RATIO against ground (CHM-50, a hard floor, never
 * traded away) and TEXT_MIN_RATIO for `mutedHex` — subtext0, already
 * repaired against every other surface by the caller — once it renders on
 * top of the row (CHM-75).
 *
 * CHM-80 changes which of those two drives the search when they conflict.
 * Before this fix, a pack whose ideal blend already cleared visibility but
 * left muted unreadable retreated toward ground only as far as muted's own
 * readability demanded, holding the row as close to `idealFraction` — and
 * so as visible — as it could: row visibility was being maximised, text
 * legibility only the constraint. That is backwards (see
 * ACTIVE_ROW_MIN_VISIBLE_RATIO's own doc comment for why a band read by its
 * edges needs far less separation from ground than a small glyph does), so
 * the row now takes the smallest fraction that clears
 * ACTIVE_ROW_MIN_VISIBLE_RATIO and nothing more. This never trades muted's
 * readability away to get there — quite the opposite. Muted's own resolved
 * luminance sits close to body's (CHM-75's own finding), so contrast
 * between muted and the row falls monotonically as the row's own fraction
 * rises from ground toward body (the mirror image of
 * fractionClearingVisibilityFloor's own row-vs-ground monotonicity). The
 * smallest fraction clearing visibility is therefore also the fraction
 * that leaves muted the most contrast any fraction in range could give it:
 * there is no second, competing search to run here any more, only the one.
 *
 * `mix(groundHex, bodyHex, idealFraction)` ships unchanged when it already
 * clears both floors with margin — no conflict to resolve, so the row keeps
 * reading as the same raised tone as Herdr's own surface0 (see
 * ACTIVE_ROW_IDEAL_FRACTION). Otherwise the row moves to the smallest
 * fraction that clears ACTIVE_ROW_MIN_VISIBLE_RATIO: searched upward from
 * `idealFraction` when the ideal blend itself falls short of the floor
 * (nothing below `idealFraction` would fare any better — see
 * fractionClearingVisibilityFloor's own doc comment), or searched upward
 * from ground itself when the ideal blend is already visible enough but
 * muted cannot be read against it.
 *
 * The result is always a blend of this theme's own ground and body, so it
 * reads as the theme's own colours either way, never a synthesised grey
 * (CHM-38's own guarantee, held here too).
 */
export declare function resolveActiveRowBackground(groundHex: string, bodyHex: string, mutedHex: string, idealFraction: number): ResolvedSurfaceBackground;
/**
 * How far between ground and body Herdr's panel_bg sits before any repair —
 * CHM-85: panes.rs:470 paints panel_bg as an ordinary pane surface, reaching
 * tabs, overlays and the status bar, so it is on screen constantly rather
 * than only while something is selected, and stays the same modest lift as
 * surface_dim (see adapters/herdr.ts's surfaceScale) rather than
 * active_row_bg's own deeper one.
 */
export declare const PANEL_IDEAL_FRACTION: number;
/**
 * The furthest from ground panel_bg may move while searching for
 * PANEL_MIN_VISIBLE_RATIO — half the way to body, and no further. Past that
 * point panel_bg sits closer to body's own tone than to ground's, and a dark
 * pack's panel surface would itself start reading as a light one (or a light
 * pack's as dark) rather than the theme's own ground tone lifted slightly —
 * exactly the "reads as a highlight, not a surface" failure this ticket's
 * acceptance criteria name (panes.rs:470 paints panel_bg as tabs, overlays
 * and the status bar too, none of which should ever look like a selection
 * highlight). No bundled pack's own ground/body pair actually needs to
 * search this far (see resolvePanelBackground's own doc comment) — it exists
 * as the ceiling a pack this library does not ship could still hit, the same
 * role `high` plays for resolveActiveRowBackground's own search, capped here
 * instead of left open to body.
 */
export declare const PANEL_MAX_FRACTION = 0.5;
/**
 * Resolves Herdr's panel_bg — CHM-85's own fix. panes.rs:470 paints it as an
 * ordinary pane surface, but Herdr's own selection_palette_background
 * (src/ui/panes.rs, v0.8.2) also paints it as the automatic selection
 * highlight's fallback whenever Herdr cannot read the host terminal's
 * background over OSC 11 — Windows Terminal does not reliably answer that
 * query (see terminal_theme.rs's own Windows-specific cfg guards beside it),
 * so this fallback is the common case there, not an edge case. Chameleon
 * used to write panel_bg identical to ground (see structuralTokenValues):
 * Monokai Classic's own ground and panel_bg, both #272822, measured 1.00
 * against each other — selecting text painted no highlight at all, not
 * merely a dull one.
 *
 * Moves panel_bg the smallest distance from ground that clears
 * PANEL_MIN_VISIBLE_RATIO, reusing resolveActiveRowBackground's own
 * "smallest fraction that clears a visibility floor" bisection
 * (fractionClearingVisibilityFloor, CHM-80) — but capped at
 * PANEL_MAX_FRACTION rather than searched all the way to body, since a pane
 * surface must keep reading as ground's own tone lifted slightly, never
 * drifting toward body's (see PANEL_MAX_FRACTION's own doc comment). The
 * ideal blend ships unchanged when it already clears the floor with margin —
 * no bundled pack needs the search at all (see this ticket's own fixture in
 * herdr.test.ts).
 */
export declare function resolvePanelBackground(groundHex: string, bodyHex: string): ResolvedSurfaceBackground;
/**
 * Repairs overlay0 — the one token of Herdr's evenly-spaced surface scale
 * (see adapters/herdr.ts's surfaceScale) that actually carries text.
 * Established by probe, not by reading Herdr's own docs, which describe
 * every ramp token with the same generic "override the token" line (CHM-78's
 * ticket body): setting surface_dim, surface0, surface1, overlay0 and
 * overlay1 to five distinct loud colours and reloading showed overlay0
 * painting both the sidebar's own section headers and every agent row's
 * subtitle line — read text, not a ramp step — while surface_dim painted
 * only the separator rule and the other three appeared nowhere in the
 * sidebar at all.
 *
 * `candidateHex` is overlay0's own plain ramp value (ground/body mixed at
 * OVERLAY_0_FRACTION); `activeRowBackgroundHex` is `resolveActiveRowAndText`'s
 * own settled row, since a subtitle line renders on both an ordinary sidebar
 * row (`groundHex`) and a selected one. `panelBackgroundHex` is
 * `resolvePanelBackground`'s own settled panel_bg (CHM-85) — one more
 * surface HERDR_TEXT_BEARING_SURFACES already declares overlay0 renders
 * against, so it has to clear this one too, not just ground and the active
 * row. Hue and chroma held fixed, the same repairForegroundAgainstBackgrounds
 * machinery `resolveActiveRowAndText` itself already uses for text and
 * subtext0 — unrepaired when the plain ramp value already clears
 * TEXT_MIN_RATIO against all three.
 */
export declare function repairOverlay0(candidateHex: string, groundHex: string, activeRowBackgroundHex: string, panelBackgroundHex: string): string;
/**
 * Raises surface0 — Herdr's own inactive tab chip — until it is at least as
 * light as the active chip beside it.
 *
 * Herdr draws one fixed dark tab number on both chips, and that colour is
 * Herdr's own, not a token Chameleon writes: probing sidebar_bg,
 * active_row_bg, panel_bg and surface_dim each left the number unchanged
 * while the chip under it moved. So there is no (foreground, background)
 * pair to hold surface0 to the way herdrContrastPairs holds every other
 * token — the chip is floored by lightness instead, against the accent
 * family Herdr paints the active chip with, which already carries that
 * number legibly.
 *
 * CHM-78's own probe concluded surface0 "appeared nowhere" and exempted it
 * from every floor on that basis; it only ever looked at the sidebar.
 * surface0 paints the tab strip, where jellybeans shipped it at 1.70:1
 * against panel_bg with a tab number on it no one could read.
 *
 * Mixed further along the same ground/body ramp surfaceScale already uses,
 * so the chip stays a neutral tone of the theme rather than becoming a
 * colour of its own.
 *
 * That reasoning was half right, and the half it got wrong is why this now
 * caps as well as raises. surface0 does not only paint the tab chip: Herdr
 * also fills the button and input surfaces in its dialogs with it, and draws
 * their labels in `text`. So there was a (foreground, background) pair all
 * along — the probe simply never opened a dialog, which is the same way
 * CHM-78 reached the opposite wrong answer by only ever looking at the
 * sidebar. Clamping at body made surface0 *equal* to text on four bundled
 * packs and left 27 of 63 under 1.5:1, which renders every button, input and
 * selected row in those dialogs as a blank slab.
 *
 * So the chip is raised toward the accent as before, but never past the
 * lightest point on the ramp where text still clears TEXT_MIN_RATIO on it.
 * A point satisfying that always exists: at fraction 0 surface0 is ground
 * itself, and body-on-ground clearing TEXT_MIN_RATIO is one of the
 * invariants every pack is already built to hold. Where the two demands
 * compete, readable text wins and the chip keeps whatever lightness is left
 * — a chip that is harder to pick out is a worse tab strip, while a button
 * nobody can read the label of is a broken dialog.
 */
export declare function repairSurface0(candidateHex: string, groundHex: string, bodyHex: string, accentHex: string): string;
export interface ResolvedRowAndText {
    readonly activeRowBackgroundHex: string;
    readonly textHex: string;
    readonly subtextHex: string;
    /**
     * True only when text could not clear TEXT_MIN_RATIO across every
     * surface, or subtext0 could not clear even MUTED_MIN_RATIO — never mind
     * TEXT_MIN_RATIO — against whatever fraction active_row_bg was pushed to,
     * and active_row_bg had to retreat to the plain, unrepaired ideal blend
     * instead of holding either search's own result. No bundled pack ever
     * reaches this: every one of the 29 clears both hard floors (see
     * herdr.test.ts's own "active row vs sidebar, text and subtext0" suite).
     * TEXT_MIN_RATIO on subtext0-on-row is a separate, softer target this
     * flag does not cover — see repairMutedForActiveRow's own doc comment for
     * the handful of bundled packs that fall short of it without regressing
     * MUTED_MIN_RATIO.
     */
    readonly wasVisibilityTraded: boolean;
}
/**
 * Resolves the selected row's own background and the text/subtext0 tokens
 * rendered on top of it, together — see this module's own doc comment for
 * why order and shared-value repair both matter here.
 *
 * `otherSurfaceHexes` carries every other text-bearing surface the caller's
 * own token list enumerates — Herdr's panel_bg and selection_bg, at the
 * time of writing (see adapters/herdr.ts) — so a background token added
 * there later is checked automatically rather than by someone remembering
 * to extend this call by hand.
 *
 * Muted is repaired first, against ground and `otherSurfaceHexes` only —
 * never active_row_bg, which does not exist yet — at its ordinary
 * MUTED_MIN_RATIO floor (CHM-40's repairForegroundAgainstBackgrounds).
 * active_row_bg's own fraction is then chosen against that settled value
 * (see resolveActiveRowBackground), preferring to meet its own
 * TEXT_MIN_RATIO floor by moving the row rather than muted. For most
 * bundled packs that is not, by itself, enough — muted's own resolved
 * luminance sits far closer to body's than the row's own visibility floor
 * allows the row to reach, so the fraction that keeps the row visible and
 * the fraction that keeps muted readable on it do not overlap. Only when
 * that happens does muted repair a second time, now against every surface
 * including the settled row, at TEXT_MIN_RATIO rather than MUTED_MIN_RATIO
 * — a uniformly *higher* bar than the first pass already cleared for ground
 * and the rest, so it never undoes it. This is the same two-lever shape
 * CHM-30 already uses for the selection highlight (resolveSelectionAndBody):
 * hold a hard floor, maximise the other objective through the cheap lever
 * first, and only reach for the second, more disruptive one when the first
 * cannot get there alone. Text is repaired last, against every surface
 * including the now-settled row, unchanged from CHM-50.
 *
 * The retreat, when needed, falls all the way back to `idealFraction`'s own
 * unrepaired candidate rather than searching for a minimal nudge: that
 * candidate is exactly what every bundled pack already ships today (see
 * this module's doc comment), so it is a known-safe floor to land on, and a
 * bisected minimal retreat would be speculative complexity with no real
 * fixture able to verify it against.
 */
export declare function resolveActiveRowAndText(groundHex: string, bodyHex: string, mutedHex: string, otherSurfaceHexes: readonly string[], idealFraction: number): ResolvedRowAndText;
/**
 * Herdr's overlay0 ramp step — 4/6 of the way from ground to body (see
 * adapters/herdr.ts's surfaceScale). Lives here, not in herdr.ts, for the
 * same reason ACTIVE_ROW_IDEAL_FRACTION does: theme-pack.ts's build-time gate
 * and herdr.ts's live apply must derive overlay0's own pre-repair candidate
 * from the exact same fraction, or the gate could pass a value the live
 * adapter never actually ships.
 */
export declare const OVERLAY_0_FRACTION: number;
/**
 * Herdr's four supplementary badge/label swatches beyond Chameleon's own
 * accent/success/error roles — established by probe, not by reading Herdr's
 * docs (CHM-79's ticket body): blue, teal (cyan), mauve (purple) and yellow
 * are the scheme's own ANSI slots, already repaired against ANSI_MIN_RATIO by
 * repairAnsiSlots (see ansi.ts) by the time they reach here; peach is their
 * own midpoint, since no ANSI slot is orange. Moved here from
 * adapters/herdr.ts so theme-pack.ts's build-time gate and herdr.ts's live
 * apply can never disagree about what these are — the same "one source of
 * truth" ACTIVE_ROW_IDEAL_FRACTION already holds for the selected row.
 * `scheme` is expected to carry already-repaired ANSI slots (see
 * repairAnsiSlots) — this only re-labels them under Herdr's own token names
 * and computes peach, it never repairs anything itself.
 */
export interface HerdrBadgeTokens {
    readonly blue: string;
    readonly teal: string;
    readonly mauve: string;
    readonly yellow: string;
    readonly peach: string;
}
export declare function resolveHerdrBadgeTokens(scheme: Scheme): HerdrBadgeTokens;
/**
 * Herdr's own accent, green and red, and its four badge swatches, repaired a
 * second time against panel_bg (CHM-85) — accent/green/red at TEXT_MIN_RATIO,
 * the four badges at ANSI_MIN_RATIO (see HERDR_BADGE_TOKENS's own doc comment
 * in this module's "declared contrast inventory" section for why those four
 * are held to a lower floor).
 *
 * Needed because panel_bg moving away from ground at all (CHM-85's own fix)
 * drops at least one of these below its floor for the majority of bundled
 * packs: repairTowardFloor aims at the floor itself, not past it, whenever a
 * role's own hue/chroma cannot reach further without losing recognisable
 * colour (see repair.ts) — Dracula's own red measures 4.53 against ground,
 * barely past the bare TEXT_MIN_RATIO of 4.5 — so any background shift
 * toward it, however small, crosses back under the floor. Only Herdr paints
 * these against panel_bg at all; Windows Terminal's ANSI slots and
 * oh-my-posh's role table never render against it, so only Herdr's own
 * copies need this second pass — the same "one target's own extra
 * background, one target's own extra repair" shape body and muted already
 * established (CHM-30's selection nudge, CHM-50's active-row repair).
 *
 * `repairForegroundAgainstBackgrounds` is checked against both `groundHex`
 * and `panelBackgroundHex` together, not `panelBackgroundHex` alone, so a
 * candidate already clearing ground with room to spare is left untouched
 * rather than nudged for no reason, and the ground pairing can never regress
 * either.
 */
export interface HerdrAccentFamily {
    readonly accent: string;
    readonly green: string;
    readonly red: string;
    readonly blue: string;
    readonly teal: string;
    readonly mauve: string;
    readonly peach: string;
    readonly yellow: string;
}
export declare function repairHerdrAccentFamily(roleHexes: Readonly<{
    accent: string;
    success: string;
    error: string;
}>, badgeTokens: HerdrBadgeTokens, groundHex: string, panelBackgroundHex: string): HerdrAccentFamily;
/**
 * Whether a declared pair carries text a reader must be able to read
 * (TEXT_MIN_RATIO's own territory, or MUTED_MIN_RATIO for the tokens
 * deliberately de-emphasised) or exists only to be told apart from whatever
 * surrounds it — an ANSI slot, a badge swatch, a cursor, a selection
 * highlight. Acceptance criterion: "text pairs are held to TEXT_MIN_RATIO,
 * and any pair exempted from it carries a stated reason" — `kind` plus each
 * builder's own doc comment is that stated reason.
 */
export type ContrastPairKind = "text" | "visibility";
/**
 * One (foreground, background) pair a target actually renders, and the floor
 * it owes that specific background — CHM-79's own inventory unit. `label`
 * names both colours by their real token name, not their role, so a failure
 * reads as "herdr overlay0 on active_row_bg measures 3.10", not "muted
 * measures 3.10" — the exact ambiguity CHM-75 mistook a different token for.
 */
export interface ContrastPair {
    readonly label: string;
    readonly foregroundHex: string;
    readonly backgroundHex: string;
    readonly minRatio: number;
    readonly kind: ContrastPairKind;
}
export interface ContrastFailure {
    readonly pair: ContrastPair;
    readonly ratio: number;
}
/**
 * Measures every declared pair and reports the ones under their own floor.
 * Generic over what built the inventory: a build-time pack's resolved
 * colours, or a live config `chm doctor` just read back off disk, measure
 * exactly the same way.
 */
export declare function checkContrastPairs(pairs: readonly ContrastPair[]): readonly ContrastFailure[];
/**
 * Every (foreground, background) pair Windows Terminal actually renders, for
 * `scheme` — CHM-79's own declared inventory for this target: the 16 ANSI
 * slots and the cursor on background, foreground on background, and
 * foreground on the selection highlight.
 *
 * The 16 ANSI slots and cursorColor are visibility pairs, not text: an
 * application picks one ANSI colour at a time and must be able to tell it
 * from the background it sits on, never held to body text's own legibility
 * guarantee (ANSI_MIN_RATIO — see ansi.ts's own doc comment, which this
 * reuses for the cursor too, the same "distinguishable, not legible" pair).
 * `scheme` is expected to be the fully resolved payload — ANSI slots and the
 * cursor already repaired (see ansi.ts), foreground already the resolved
 * body, selectionBackground already the resolved selection — the same object
 * theme-pack.ts ships and windows-terminal.ts applies; this only measures,
 * it never repairs.
 */
export declare function windowsTerminalContrastPairs(scheme: Scheme): ContrastPair[];
/**
 * Every token Herdr's own [theme.custom] table carries, keyed by its real
 * Herdr name — established by reading Herdr's published config reference and
 * probing the live UI with distinct colours per token (CHM-79's own ticket
 * body). The four ramp steps that carry no text at all (surface_dim,
 * surface0, surface1, overlay1 — see HERDR_TOKENS_CARRYING_NO_TEXT) are
 * optional here: theme-pack.ts's build-time gate never computes them, since
 * no pair below ever reads them.
 */
export interface HerdrTokenSet {
    readonly sidebar_bg: string;
    readonly panel_bg: string;
    readonly active_row_bg: string;
    readonly selection_bg: string;
    readonly text: string;
    readonly subtext0: string;
    readonly overlay0: string;
    readonly accent: string;
    readonly green: string;
    readonly red: string;
    readonly yellow: string;
    readonly blue: string;
    readonly teal: string;
    readonly mauve: string;
    readonly peach: string;
    readonly surface_dim?: string;
    readonly surface0?: string;
    readonly surface1?: string;
    readonly overlay1?: string;
}
/**
 * Every (foreground, background) pair Herdr actually renders, for one
 * resolved token set — CHM-79's own declared inventory for this target,
 * established by reading Herdr's published config reference and probing the
 * live UI with distinct colours per token (see this ticket's own body):
 *
 * - text, subtext0 and overlay0 each on sidebar_bg, panel_bg and
 *   active_row_bg — subtext0 to MUTED_MIN_RATIO (CHM-50's own de-emphasised
 *   floor), text and overlay0 to TEXT_MIN_RATIO (CHM-78: overlay0 paints
 *   section headers and every agent row's own subtitle line, read text, not
 *   a ramp step).
 * - accent, green, red, yellow, blue, teal, mauve and peach on sidebar_bg
 *   and panel_bg — the three Chameleon roles at TEXT_MIN_RATIO, the four
 *   supplementary badge swatches exempted to ANSI_MIN_RATIO (see
 *   HERDR_BADGE_TOKENS's own doc comment).
 * - text on selection_bg, at TEXT_MIN_RATIO.
 * - selection_bg itself against sidebar_bg, a highlight-visibility pair at
 *   SELECTION_MIN_VISIBLE_RATIO — so a selection can never render as the
 *   same tone as the sidebar it sits on.
 * - panel_bg itself against sidebar_bg, a highlight-visibility pair at
 *   PANEL_MIN_VISIBLE_RATIO (CHM-85) — Herdr's own selection_palette_background
 *   paints panel_bg as the automatic selection highlight's fallback whenever
 *   it cannot read the host terminal's background over OSC 11, so this pair
 *   is the same "never the same tone as the sidebar it sits on" guarantee as
 *   selection_bg's own, for the case Herdr actually renders in practice on a
 *   host — Windows Terminal — that does not answer that query.
 *
 * surface_dim, surface0, surface1 and overlay1 carry no pair at all — see
 * HERDR_TOKENS_CARRYING_NO_TEXT.
 */
export declare function herdrContrastPairs(tokens: HerdrTokenSet): ContrastPair[];
