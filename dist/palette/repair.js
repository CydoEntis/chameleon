import { MIN_REPAIRED_CHROMA, MUTED_MIN_RATIO, RATIO_CLEARANCE_MARGIN, ROLES, TEXT_MIN_RATIO, WCAG_CONTRAST_OFFSET, } from "../constants.js";
import { chromaOf, contrastRatio, fromHueChromaMatch, relativeLuminance, toHsl } from "./color.js";
import { toPalette } from "./palette.js";
import { assignRolesByContrast } from "./roles.js";
/** Fraction of body's ratio a repaired muted targets, so it reads as clearly secondary rather than barely so — proportional, not a fixed gap, so it still holds when body's ratio is large. */
const MUTED_BELOW_BODY_FRACTION = 0.9;
/** How much further from ground a repair aims when a candidate already clears its floor but collides with an earlier role — the ideal it reaches for before settling for merely clearing the floor at a hue-true colour instead (see repairAtHue). */
const COLLISION_NUDGE_MULTIPLIER = 1.15;
/** Bisections used to find the matchValue or chroma that hits a target; 40 gives far more precision than an 8-bit channel can express. */
const SEARCH_ITERATIONS = 40;
function isTaken(hex, takenHexes) {
    return takenHexes.has(hex.toLowerCase());
}
/**
 * Which side of ground — lighter or darker — can reach a higher contrast
 * ratio before running out of room (white or black respectively). A role
 * that is below its floor needs the pole with more headroom, regardless of
 * which side it happened to start on: a muted candidate that starts darker
 * than a mid-toned ground can still be unable to reach its floor by going
 * further dark, if going light would clear it with room to spare.
 *
 * Exported for palette/role-mapping.ts, which needs the same "which extreme
 * is farthest from ground" question to pick the far pole a foreign palette
 * key's luminance is retinted toward — see recoloredHexFor.
 */
export function poleWithMoreHeadroom(groundHex) {
    const groundLuminance = relativeLuminance(groundHex);
    const maxRatioGoingLighter = (1 + WCAG_CONTRAST_OFFSET) / (groundLuminance + WCAG_CONTRAST_OFFSET);
    const maxRatioGoingDarker = (groundLuminance + WCAG_CONTRAST_OFFSET) / WCAG_CONTRAST_OFFSET;
    return maxRatioGoingLighter >= maxRatioGoingDarker;
}
/**
 * The relative luminance `targetRatio` against `referenceHex` demands,
 * clamped to the [0, 1] a luminance can actually take. Despite the
 * parameter's name, nothing here is specific to a role's own ground — it is
 * just whichever fixed colour the caller is measuring against.
 *
 * Exported for palette/surfaces.ts, which needs the same "what luminance
 * hits this ratio" question against active_row_bg (not ground) when muted
 * repairs a second time to clear TEXT_MIN_RATIO on the selected row
 * (CHM-75), and again against ground itself to find the ceiling that keeps
 * that second repair short of body's own ratio.
 */
export function targetLuminanceFor(referenceHex, targetRatio, isLighterThanGround) {
    const referenceLuminance = relativeLuminance(referenceHex);
    const rawTargetLuminance = isLighterThanGround
        ? targetRatio * (referenceLuminance + WCAG_CONTRAST_OFFSET) - WCAG_CONTRAST_OFFSET
        : (referenceLuminance + WCAG_CONTRAST_OFFSET) / targetRatio - WCAG_CONTRAST_OFFSET;
    return Math.min(1, Math.max(0, rawTargetLuminance));
}
/**
 * The matchValue, for a fixed hue and chroma, whose relative luminance is
 * closest to target. Luminance rises monotonically with matchValue over its
 * full valid domain [0, 1 - chroma] regardless of which pole is being aimed
 * at — see {@link HueChromaMatch} — so this is a plain bisection. Exported
 * for palette/selection.ts, which needs the same hue/chroma-preserving
 * luminance search to resolve the selection highlight and its rare body
 * nudge — see resolveSelectionAndBody.
 */
export function matchValueForLuminance(hue, chroma, targetLuminance) {
    let low = 0;
    let high = 1 - chroma;
    for (let iteration = 0; iteration < SEARCH_ITERATIONS; iteration += 1) {
        const midMatchValue = (low + high) / 2;
        const midLuminance = relativeLuminance(fromHueChromaMatch({ hue, chroma, matchValue: midMatchValue }));
        if (midLuminance < targetLuminance) {
            low = midMatchValue;
        }
        else {
            high = midMatchValue;
        }
    }
    return (low + high) / 2;
}
/** The hex, at a fixed hue and chroma, that measures closest to `targetRatio` against ground. */
function colourAtRatio(hue, chroma, groundHex, targetRatio, isLighterThanGround) {
    const targetLuminance = targetLuminanceFor(groundHex, targetRatio, isLighterThanGround);
    const matchValue = matchValueForLuminance(hue, chroma, targetLuminance);
    return { hex: fromHueChromaMatch({ hue, chroma, matchValue }), chroma };
}
function reachableRatioRange(hue, chroma, groundHex, isLighterThanGround) {
    const towardGroundMatchValue = isLighterThanGround ? 0 : 1 - chroma;
    const awayFromGroundMatchValue = isLighterThanGround ? 1 - chroma : 0;
    return {
        min: contrastRatio(fromHueChromaMatch({ hue, chroma, matchValue: towardGroundMatchValue }), groundHex),
        max: contrastRatio(fromHueChromaMatch({ hue, chroma, matchValue: awayFromGroundMatchValue }), groundHex),
    };
}
function isRatioReachable(targetRatio, range) {
    return targetRatio >= range.min && targetRatio <= range.max;
}
/**
 * The largest chroma, at or below `ceilingChroma`, whose reachable range
 * (see {@link reachableRatioRange}) still contains `targetRatio`. Less
 * chroma always widens that range toward both of its ends — at chroma 0 it
 * spans everything from true black to true white — so this trades away no
 * more of it than `targetRatio` actually demands.
 */
function chromaAllowingRatio(hue, groundHex, isLighterThanGround, targetRatio, ceilingChroma) {
    let low = 0;
    let high = ceilingChroma;
    for (let iteration = 0; iteration < SEARCH_ITERATIONS; iteration += 1) {
        const midChroma = (low + high) / 2;
        if (isRatioReachable(targetRatio, reachableRatioRange(hue, midChroma, groundHex, isLighterThanGround))) {
            low = midChroma;
        }
        else {
            high = midChroma;
        }
    }
    return low;
}
/**
 * Finds the nearest colour, at a fixed hue, that clears `minAcceptableRatio`
 * while holding as much of `ceilingChroma` — the candidate's own chroma —
 * as it can. Reaches for `idealTargetRatio` first; if the full ceiling
 * cannot reach it — too little contrast headroom left, or (a muted pulling
 * back below body) too much — aims at the floor itself instead of at
 * whichever end of the ceiling's own range is nearest (which could just
 * reproduce the candidate's already-taken point, or overshoot back past
 * body from the other side); only when the floor itself is out of reach at
 * full chroma does it give any chroma up, and then only as much as the
 * floor actually demands. This is the fix for a repair that used to walk a
 * fixed-saturation lightness line to the first colour that cleared: that
 * line runs straight through white or black, because HSL saturation stays
 * put while chroma collapses as lightness nears either pole.
 */
function repairAtHue(hue, ceilingChroma, groundHex, idealTargetRatio, minAcceptableRatio, isLighterThanGround) {
    const ceilingRange = reachableRatioRange(hue, ceilingChroma, groundHex, isLighterThanGround);
    if (isRatioReachable(idealTargetRatio, ceilingRange)) {
        return colourAtRatio(hue, ceilingChroma, groundHex, idealTargetRatio, isLighterThanGround);
    }
    if (isRatioReachable(minAcceptableRatio, ceilingRange)) {
        return colourAtRatio(hue, ceilingChroma, groundHex, minAcceptableRatio, isLighterThanGround);
    }
    const chroma = chromaAllowingRatio(hue, groundHex, isLighterThanGround, minAcceptableRatio, ceilingChroma);
    return colourAtRatio(hue, chroma, groundHex, minAcceptableRatio, isLighterThanGround);
}
function finalize(candidate, wasRepaired, isFallback) {
    return Object.freeze({ ...candidate, wasRepaired, isFallback });
}
/**
 * Turns a {@link ChromaRepair} into a finished role colour: a computed,
 * hue-free grey if the search traded any chroma away and still landed
 * below MIN_REPAIRED_CHROMA, or if it still collides with an earlier role
 * despite holding hue — both cases reported as a fallback, never shipped
 * silently. A candidate that started below MIN_REPAIRED_CHROMA and needed
 * no trade at all keeps its own (already low) chroma rather than being
 * flagged for a loss that never happened.
 */
function resolveRepair(slot, groundHex, repaired, ceilingChroma, minAcceptableRatio, isLighterThanGround, takenHexes) {
    const wasChromaTradedAway = repaired.chroma < ceilingChroma;
    const didLoseRecognisableChroma = repaired.chroma < MIN_REPAIRED_CHROMA && wasChromaTradedAway;
    const isStillTaken = !didLoseRecognisableChroma && isTaken(repaired.hex, takenHexes);
    if (!didLoseRecognisableChroma && !isStillTaken) {
        return finalize({ hex: repaired.hex, slot, contrastRatio: contrastRatio(repaired.hex, groundHex) }, true, false);
    }
    const fallback = colourAtRatio(0, 0, groundHex, minAcceptableRatio, isLighterThanGround);
    return finalize({ hex: fallback.hex, slot, contrastRatio: contrastRatio(fallback.hex, groundHex) }, true, true);
}
/**
 * Shared last step of both repairTowardFloor and repairMuted: search at the
 * candidate's own hue and chroma, then resolve that search into a finished
 * role colour.
 */
function repairCandidate(candidate, groundHex, idealTargetRatio, minAcceptableRatio, isLighterThanGround, takenHexes) {
    const { hue } = toHsl(candidate.hex);
    const ceilingChroma = chromaOf(candidate.hex);
    const repaired = repairAtHue(hue, ceilingChroma, groundHex, idealTargetRatio, minAcceptableRatio, isLighterThanGround);
    return resolveRepair(candidate.slot, groundHex, repaired, ceilingChroma, minAcceptableRatio, isLighterThanGround, takenHexes);
}
/**
 * Repairs one role against a single floor. Also repairs a role that
 * already clears its floor but landed on a colour an earlier role already
 * claimed — a role that reads identically to another is still broken, even
 * if both individually pass.
 *
 * Exported for palette/ansi.ts, which reuses this exact floor-and-collision
 * check for the 16 ANSI slots — passing an empty takenHexes, since nothing
 * there plays the part of two of Chameleon's own roles reading as
 * identical (see repairAnsiSlots).
 */
export function repairTowardFloor(candidate, groundHex, minRatio, takenHexes) {
    const isBelowFloor = candidate.contrastRatio < minRatio;
    const isCollision = isTaken(candidate.hex, takenHexes);
    if (!isBelowFloor && !isCollision)
        return finalize(candidate, false, false);
    const minAcceptableRatio = minRatio * RATIO_CLEARANCE_MARGIN;
    const idealTargetRatio = isBelowFloor ? minAcceptableRatio : candidate.contrastRatio * COLLISION_NUDGE_MULTIPLIER;
    // Below the floor, aim at whichever pole has more contrast headroom. A
    // collision-only nudge instead stays on the candidate's own side — it
    // already clears its floor, it just needs to stop matching another role.
    const isLighterThanGround = isBelowFloor
        ? poleWithMoreHeadroom(groundHex)
        : relativeLuminance(candidate.hex) >= relativeLuminance(groundHex);
    return repairCandidate(candidate, groundHex, idealTargetRatio, minAcceptableRatio, isLighterThanGround, takenHexes);
}
/**
 * Repairs muted against both of its rules: at least MUTED_MIN_RATIO, and
 * strictly below body's (already-repaired) ratio — Solarized Light's muted
 * measures 13.92 against a body of 4.13, which inverts the two roles'
 * relative prominence and must come back down, not up.
 */
function repairMuted(candidate, groundHex, body, takenHexes) {
    const isTooFaint = candidate.contrastRatio < MUTED_MIN_RATIO;
    const doesOutrankBody = candidate.contrastRatio >= body.contrastRatio;
    const isCollision = isTaken(candidate.hex, takenHexes);
    if (!isTooFaint && !doesOutrankBody && !isCollision)
        return finalize(candidate, false, false);
    // Too faint needs the pole with more headroom, same as any other
    // below-floor repair. Outranking body (or a bare collision) instead
    // pulls back toward ground on muted's own side, never crossing it.
    const isLighterThanGround = isTooFaint
        ? poleWithMoreHeadroom(groundHex)
        : relativeLuminance(candidate.hex) >= relativeLuminance(groundHex);
    const minAcceptableRatio = MUTED_MIN_RATIO * RATIO_CLEARANCE_MARGIN;
    const idealTargetRatio = isTooFaint
        ? minAcceptableRatio
        : Math.max(minAcceptableRatio, body.contrastRatio * MUTED_BELOW_BODY_FRACTION);
    return repairCandidate(candidate, groundHex, idealTargetRatio, minAcceptableRatio, isLighterThanGround, takenHexes);
}
/**
 * Repairs every assigned role that fails its floor, and every role that
 * collides with one resolved before it. This is the second half of the
 * contrast engine: assignRolesByContrast picks candidates, this makes them
 * safe to ship.
 *
 * Roles resolve in a fixed order — ground, body, accent, success, error,
 * muted — because later roles must avoid colliding with earlier ones, and
 * muted's own floor depends on body's final ratio.
 */
export function repairFailingRoles(assignment) {
    const groundHex = assignment.ground.hex;
    const takenHexes = new Set([groundHex.toLowerCase()]);
    const repairTextRole = (role) => {
        const repaired = repairTowardFloor(assignment[role], groundHex, TEXT_MIN_RATIO, takenHexes);
        takenHexes.add(repaired.hex.toLowerCase());
        return repaired;
    };
    const ground = finalize(assignment.ground, false, false);
    const body = repairTextRole("body");
    const accent = repairTextRole("accent");
    const success = repairTextRole("success");
    const error = repairTextRole("error");
    const muted = repairMuted(assignment.muted, groundHex, body, takenHexes);
    const resolvedPalette = Object.freeze({ ground, body, accent, muted, success, error });
    const repairedRoles = ROLES.filter((role) => resolvedPalette[role].wasRepaired);
    const fallbackRoles = ROLES.filter((role) => resolvedPalette[role].isFallback);
    return {
        palette: resolvedPalette,
        repairedRoles: Object.freeze(repairedRoles),
        fallbackRoles: Object.freeze(fallbackRoles),
    };
}
/** The lowest contrast `foregroundHex` measures against any of `backgroundHexes` — the pairing that actually decides whether text reads, since only one candidate background renders at a time but any of them could be the one showing. */
function worstContrastAgainst(foregroundHex, backgroundHexes) {
    return Math.min(...backgroundHexes.map((backgroundHex) => contrastRatio(foregroundHex, backgroundHex)));
}
/**
 * The repaired foreground a segment needs in place of `foregroundHex`, or
 * undefined when it already clears `minRatio` against every one of
 * `backgroundHexes` and needs no change. See CHM-40: a segment's background
 * is often templated — Oh My Posh swaps it at render time between several
 * candidates (one per battery level, one per git state, …) — so a fix has
 * to hold up against every candidate that could actually render behind this
 * text, not just whichever one a check happened to sample.
 *
 * `minRatio` is a parameter, not always TEXT_MIN_RATIO, since CHM-50 reuses
 * this same search for Herdr's subtext0 against MUTED_MIN_RATIO — a second
 * caller checking a second floor is exactly why this generalised rather than
 * staying hardcoded to the one CHM-40 needed.
 *
 * Searches both directions a fixed hue/chroma can move away from a fixed
 * point — see repairAtHue — anchored on whichever background is hardest
 * for that direction: the darkest background is what limits how much
 * contrast a *darker* foreground can still gain (the two are already close
 * in luminance there), and the lightest background limits a *lighter* one
 * the same way. A foreground that clears its hardest case in a direction
 * clears every easier one in that same direction for free, since contrast
 * against a fixed foreground only grows as a background moves further away
 * from it.
 *
 * When both directions clear every background, the one nearer the original
 * foreground's own luminance wins, so the repair reads as a nudge rather
 * than a swap. When neither does — the backgrounds this one foreground has
 * to share a segment with span too wide a luminance range for any single
 * colour to read against all of them — this ships whichever direction
 * leaves the least-bad worst case, rather than a direction picked at
 * random that is merely differently wrong.
 */
export function repairForegroundAgainstBackgrounds(foregroundHex, backgroundHexes, minRatio) {
    if (backgroundHexes.length === 0 || worstContrastAgainst(foregroundHex, backgroundHexes) >= minRatio) {
        return undefined;
    }
    const minAcceptableRatio = minRatio * RATIO_CLEARANCE_MARGIN;
    const { hue } = toHsl(foregroundHex);
    const chroma = chromaOf(foregroundHex);
    const darkestBackground = backgroundHexes.reduce((darkest, candidate) => relativeLuminance(candidate) < relativeLuminance(darkest) ? candidate : darkest);
    const lightestBackground = backgroundHexes.reduce((lightest, candidate) => relativeLuminance(candidate) > relativeLuminance(lightest) ? candidate : lightest);
    const darker = repairAtHue(hue, chroma, darkestBackground, minAcceptableRatio, minAcceptableRatio, false).hex;
    const lighter = repairAtHue(hue, chroma, lightestBackground, minAcceptableRatio, minAcceptableRatio, true).hex;
    const doesDarkerClearEverything = worstContrastAgainst(darker, backgroundHexes) >= minRatio;
    const doesLighterClearEverything = worstContrastAgainst(lighter, backgroundHexes) >= minRatio;
    if (doesDarkerClearEverything !== doesLighterClearEverything) {
        return doesDarkerClearEverything ? darker : lighter;
    }
    if (doesDarkerClearEverything && doesLighterClearEverything) {
        const originalLuminance = relativeLuminance(foregroundHex);
        return Math.abs(relativeLuminance(darker) - originalLuminance) <= Math.abs(relativeLuminance(lighter) - originalLuminance)
            ? darker
            : lighter;
    }
    return worstContrastAgainst(darker, backgroundHexes) >= worstContrastAgainst(lighter, backgroundHexes) ? darker : lighter;
}
/**
 * Runs the full pipeline — parse, assign, repair — and reduces it to the
 * flat role-to-hex table every colour-consuming adapter needs. Oh My
 * Posh's palette block and Herdr's [theme.custom] block both key off
 * exactly this shape, so it is computed once here rather than twice.
 */
export function resolveRoleHexes(scheme) {
    const { palette } = repairFailingRoles(assignRolesByContrast(toPalette(scheme)));
    return {
        ground: palette.ground.hex,
        body: palette.body.hex,
        accent: palette.accent.hex,
        muted: palette.muted.hex,
        success: palette.success.hex,
        error: palette.error.hex,
    };
}
//# sourceMappingURL=repair.js.map