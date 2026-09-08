import { type Role } from "../constants.js";
import { type RoleAssignment, type RoleColor } from "./roles.js";
import type { Scheme } from "./scheme.js";
export interface RepairedRoleColor extends RoleColor {
    readonly wasRepaired: boolean;
    readonly isFallback: boolean;
}
export type ResolvedPalette = Readonly<Record<Role, RepairedRoleColor>>;
export interface ContrastReport {
    readonly palette: ResolvedPalette;
    /** Roles whose colour changed because they either failed their floor or collided with an earlier role. */
    readonly repairedRoles: readonly Role[];
    /**
     * Repaired roles that still could not clear their floor without a
     * collision, or without giving up MIN_REPAIRED_CHROMA of colour, and fell
     * back to a computed grey.
     */
    readonly fallbackRoles: readonly Role[];
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
export declare function poleWithMoreHeadroom(groundHex: string): boolean;
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
export declare function targetLuminanceFor(referenceHex: string, targetRatio: number, isLighterThanGround: boolean): number;
/**
 * The matchValue, for a fixed hue and chroma, whose relative luminance is
 * closest to target. Luminance rises monotonically with matchValue over its
 * full valid domain [0, 1 - chroma] regardless of which pole is being aimed
 * at — see {@link HueChromaMatch} — so this is a plain bisection. Exported
 * for palette/selection.ts, which needs the same hue/chroma-preserving
 * luminance search to resolve the selection highlight and its rare body
 * nudge — see resolveSelectionAndBody.
 */
export declare function matchValueForLuminance(hue: number, chroma: number, targetLuminance: number): number;
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
export declare function repairTowardFloor(candidate: RoleColor, groundHex: string, minRatio: number, takenHexes: ReadonlySet<string>): RepairedRoleColor;
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
export declare function repairFailingRoles(assignment: RoleAssignment): ContrastReport;
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
export declare function repairForegroundAgainstBackgrounds(foregroundHex: string, backgroundHexes: readonly string[], minRatio: number): string | undefined;
/**
 * Runs the full pipeline — parse, assign, repair — and reduces it to the
 * flat role-to-hex table every colour-consuming adapter needs. Oh My
 * Posh's palette block and Herdr's [theme.custom] block both key off
 * exactly this shape, so it is computed once here rather than twice.
 */
export declare function resolveRoleHexes(scheme: Scheme): Record<Role, string>;
