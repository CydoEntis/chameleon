/**
 * Resolves the selection highlight: the one colour every target paints
 * behind selected text. Unlike Chameleon's six roles (roles.ts, repair.ts) a
 * selection has no hue identity to protect and no accompanying "role" — it
 * is a single fill checked against two other, already-resolved colours, so
 * it gets its own small pipeline rather than folding into ROLES.
 *
 * The rule (CHM-30, superseding CHM-26/CHM-29's "both floors together" rule
 * — that one is mathematically unreachable for 10 of the 26 bundled packs,
 * see this ticket's own worked proof): body-on-selection clearing
 * TEXT_MIN_RATIO is a hard floor, never traded away. Selection-vs-ground is
 * then maximised up to SELECTION_IDEAL_RATIO, subject to that floor. If the
 * ground/body pair leaves no selection reaching even
 * SELECTION_MIN_VISIBLE_RATIO — the highlight would be there but invisible —
 * body itself moves further from ground instead, just enough to open up
 * room for one, and that is reported back rather than done silently.
 *
 * CHM-38: a repaired selection used to search a hue-free grey for whichever
 * luminance hit the ratio above — legal, since WCAG contrast is a function
 * of luminance alone, but it meant 25 of the 26 bundled packs shipped a
 * selection with essentially zero chroma, and Solarized Dark's search
 * landed on pure black. That fix tinted ground's own hue instead, at a
 * chroma clamped to a narrow band (SELECTION_MIN_CHROMA/
 * SELECTION_MAX_CHROMA) — legible over grey, but ground's hue at that low a
 * chroma is still, by construction, only a slightly different shade of the
 * background: nord-dark's selection scored 1.98 for selection-vs-ground and
 * still read as "a lighter grey on a grey", not a distinct colour.
 *
 * CHM-70 changes which hue the tint uses and how much of it survives, not
 * the luminance search above — no floor moves. The tint now takes the
 * pack's own accent hue (see chooseSelectionHue) rather than ground's own,
 * falling back to whichever of success or error sits farthest from ground
 * when accent itself is too close to tell apart from it, and holds as much
 * chroma as the two floors actually leave room for (see
 * maxChromaClearingFloors) instead of a fixed low ceiling.
 *
 * CHM-70's tint only ran when a repair fired: resolveSelectionAgainstBody's
 * early return handed back an authored selectionBackground the moment it
 * cleared both contrast floors, without ever looking at what it looked
 * like. monokai-dark and gruvbox-dark both clear those floors while carrying
 * essentially no colour (chroma 0.035 and 0.071) — grey-on-grey, invisible
 * as a highlight despite passing every check built on luminance alone. CHM-76
 * adds a chroma floor (SELECTION_MIN_RESOLVED_CHROMA) to that same early
 * return, so a candidate this washed-out gets retinted toward accent's hue
 * exactly like a contrast repair, while a pack whose authored selection
 * already carries ample chroma (jellybeans' 0.290) keeps it untouched.
 */
export interface ResolvedSelection {
    readonly hex: string;
    /** contrastRatio(hex, ground) — the achieved pair this ticket asks to be inspectable rather than hidden; see resolveSelectionAndBody. */
    readonly selectionVsGroundRatio: number;
    readonly wasRepaired: boolean;
    /**
     * True only when a repair fired *and* accent's own hue was too close to
     * ground's (see chooseSelectionHue) to build the tint from. False both
     * when the candidate needed no repair at all and when it did but accent's
     * hue was distinct enough to use directly — CHM-70's "or the fallback
     * fired and is reported" made a checkable fact rather than a claim.
     */
    readonly usedFallbackHue: boolean;
}
export interface ResolvedBody {
    readonly hex: string;
    /** True only for the rare pack where ground and body leave no room for even a barely-visible selection — see widenedBodyLuminance. */
    readonly wasNudged: boolean;
}
export interface SelectionResolution {
    readonly selection: ResolvedSelection;
    readonly body: ResolvedBody;
}
/**
 * Resolves the selection highlight from the scheme's own authored
 * `selectionBackground`, and — only on the rare pack where ground and body
 * leave no colour able to reach even SELECTION_MIN_VISIBLE_RATIO while
 * clearing body-on-selection — nudges body itself further from ground
 * first, just enough to open up room for one.
 *
 * Body-on-selection (TEXT_MIN_RATIO) is a hard floor throughout: it is what
 * makes selected text readable, and CHM-30 never trades it away, unlike
 * CHM-26/CHM-29's rule which demanded selection-vs-ground clear
 * SELECTION_IDEAL_RATIO in the same breath — provably impossible for 10 of
 * the 26 bundled packs (tokyo-night-light's body clears ground by only
 * 4.52, for one). Selection-vs-ground is maximised up to
 * SELECTION_IDEAL_RATIO subject to that floor, and RATIO_CLEARANCE_MARGIN
 * is folded into both floors throughout so 8-bit rounding on the final hex
 * never lands either back under them. assertClearsBodyFloor guards every
 * return below, so this function itself cannot hand back a value that
 * misses its own one guarantee.
 *
 * `accentHex` and `otherChromaticHexes` (success, error) are only consulted
 * when a repair actually fires — see chooseSelectionHue — never when the
 * scheme's own authored `candidateSelectionHex` already clears both floors
 * on its own.
 */
export declare function resolveSelectionAndBody(candidateSelectionHex: string, groundHex: string, bodyHex: string, accentHex: string, otherChromaticHexes: readonly string[]): SelectionResolution;
