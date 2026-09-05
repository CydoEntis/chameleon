import {
  MIN_REPAIRED_CHROMA,
  MUTED_MIN_RATIO,
  RATIO_CLEARANCE_MARGIN,
  ROLES,
  TEXT_MIN_RATIO,
  WCAG_CONTRAST_OFFSET,
  type Role,
} from "../constants.js";
import { chromaOf, contrastRatio, fromHueChromaMatch, relativeLuminance, toHsl } from "./color.js";
import { toPalette } from "./palette.js";
import { assignRolesByContrast, type RoleAssignment, type RoleColor } from "./roles.js";
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

/** Fraction of body's ratio a repaired muted targets, so it reads as clearly secondary rather than barely so — proportional, not a fixed gap, so it still holds when body's ratio is large. */
const MUTED_BELOW_BODY_FRACTION = 0.9;

/** How much further from ground a repair aims when a candidate already clears its floor but collides with an earlier role — the ideal it reaches for before settling for merely clearing the floor at a hue-true colour instead (see repairAtHue). */
const COLLISION_NUDGE_MULTIPLIER = 1.15;

/** Bisections used to find the matchValue or chroma that hits a target; 40 gives far more precision than an 8-bit channel can express. */
const SEARCH_ITERATIONS = 40;

function isTaken(hex: string, takenHexes: ReadonlySet<string>): boolean {
  return takenHexes.has(hex.toLowerCase());
}

/**
 * Which side of ground — lighter or darker — can reach a higher contrast
 * ratio before running out of room (white or black respectively). A role
 * that is below its floor needs the pole with more headroom, regardless of
 * which side it happened to start on: a muted candidate that starts darker
 * than a mid-toned ground can still be unable to reach its floor by going
 * further dark, if going light would clear it with room to spare.
 */
function poleWithMoreHeadroom(groundHex: string): boolean {
  const groundLuminance = relativeLuminance(groundHex);
  const maxRatioGoingLighter = (1 + WCAG_CONTRAST_OFFSET) / (groundLuminance + WCAG_CONTRAST_OFFSET);
  const maxRatioGoingDarker = (groundLuminance + WCAG_CONTRAST_OFFSET) / WCAG_CONTRAST_OFFSET;
  return maxRatioGoingLighter >= maxRatioGoingDarker;
}

/** The relative luminance `targetRatio` against ground demands, clamped to the [0, 1] a luminance can actually take. */
function targetLuminanceFor(groundHex: string, targetRatio: number, isLighterThanGround: boolean): number {
  const groundLuminance = relativeLuminance(groundHex);
  const rawTargetLuminance = isLighterThanGround
    ? targetRatio * (groundLuminance + WCAG_CONTRAST_OFFSET) - WCAG_CONTRAST_OFFSET
    : (groundLuminance + WCAG_CONTRAST_OFFSET) / targetRatio - WCAG_CONTRAST_OFFSET;
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
export function matchValueForLuminance(hue: number, chroma: number, targetLuminance: number): number {
  let low = 0;
  let high = 1 - chroma;
  for (let iteration = 0; iteration < SEARCH_ITERATIONS; iteration += 1) {
    const midMatchValue = (low + high) / 2;
    const midLuminance = relativeLuminance(fromHueChromaMatch({ hue, chroma, matchValue: midMatchValue }));
    if (midLuminance < targetLuminance) {
      low = midMatchValue;
    } else {
      high = midMatchValue;
    }
  }
  return (low + high) / 2;
}

interface ChromaRepair {
  readonly hex: string;
  readonly chroma: number;
}

/** The hex, at a fixed hue and chroma, that measures closest to `targetRatio` against ground. */
function colourAtRatio(
  hue: number,
  chroma: number,
  groundHex: string,
  targetRatio: number,
  isLighterThanGround: boolean,
): ChromaRepair {
  const targetLuminance = targetLuminanceFor(groundHex, targetRatio, isLighterThanGround);
  const matchValue = matchValueForLuminance(hue, chroma, targetLuminance);
  return { hex: fromHueChromaMatch({ hue, chroma, matchValue }), chroma };
}

/** The lowest and highest contrast ratio a colour at this hue and chroma can reach against ground on the given pole — matchValue swept over its full domain, [0, 1 - chroma]. A target ratio outside this interval cannot be hit without giving up some chroma; one inside it can be hit exactly (see colourAtRatio). */
interface ReachableRatioRange {
  readonly min: number;
  readonly max: number;
}

function reachableRatioRange(
  hue: number,
  chroma: number,
  groundHex: string,
  isLighterThanGround: boolean,
): ReachableRatioRange {
  const towardGroundMatchValue = isLighterThanGround ? 0 : 1 - chroma;
  const awayFromGroundMatchValue = isLighterThanGround ? 1 - chroma : 0;
  return {
    min: contrastRatio(fromHueChromaMatch({ hue, chroma, matchValue: towardGroundMatchValue }), groundHex),
    max: contrastRatio(fromHueChromaMatch({ hue, chroma, matchValue: awayFromGroundMatchValue }), groundHex),
  };
}

function isRatioReachable(targetRatio: number, range: ReachableRatioRange): boolean {
  return targetRatio >= range.min && targetRatio <= range.max;
}

/**
 * The largest chroma, at or below `ceilingChroma`, whose reachable range
 * (see {@link reachableRatioRange}) still contains `targetRatio`. Less
 * chroma always widens that range toward both of its ends — at chroma 0 it
 * spans everything from true black to true white — so this trades away no
 * more of it than `targetRatio` actually demands.
 */
function chromaAllowingRatio(
  hue: number,
  groundHex: string,
  isLighterThanGround: boolean,
  targetRatio: number,
  ceilingChroma: number,
): number {
  let low = 0;
  let high = ceilingChroma;
  for (let iteration = 0; iteration < SEARCH_ITERATIONS; iteration += 1) {
    const midChroma = (low + high) / 2;
    if (isRatioReachable(targetRatio, reachableRatioRange(hue, midChroma, groundHex, isLighterThanGround))) {
      low = midChroma;
    } else {
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
function repairAtHue(
  hue: number,
  ceilingChroma: number,
  groundHex: string,
  idealTargetRatio: number,
  minAcceptableRatio: number,
  isLighterThanGround: boolean,
): ChromaRepair {
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

function finalize(candidate: RoleColor, wasRepaired: boolean, isFallback: boolean): RepairedRoleColor {
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
function resolveRepair(
  slot: RoleColor["slot"],
  groundHex: string,
  repaired: ChromaRepair,
  ceilingChroma: number,
  minAcceptableRatio: number,
  isLighterThanGround: boolean,
  takenHexes: ReadonlySet<string>,
): RepairedRoleColor {
  const wasChromaTradedAway = repaired.chroma < ceilingChroma;
  const didLoseRecognisableChroma = repaired.chroma < MIN_REPAIRED_CHROMA && wasChromaTradedAway;
  const isStillTaken = !didLoseRecognisableChroma && isTaken(repaired.hex, takenHexes);

  if (!didLoseRecognisableChroma && !isStillTaken) {
    return finalize(
      { hex: repaired.hex, slot, contrastRatio: contrastRatio(repaired.hex, groundHex) },
      true,
      false,
    );
  }

  const fallback = colourAtRatio(0, 0, groundHex, minAcceptableRatio, isLighterThanGround);
  return finalize({ hex: fallback.hex, slot, contrastRatio: contrastRatio(fallback.hex, groundHex) }, true, true);
}

/**
 * Shared last step of both repairTowardFloor and repairMuted: search at the
 * candidate's own hue and chroma, then resolve that search into a finished
 * role colour.
 */
function repairCandidate(
  candidate: RoleColor,
  groundHex: string,
  idealTargetRatio: number,
  minAcceptableRatio: number,
  isLighterThanGround: boolean,
  takenHexes: ReadonlySet<string>,
): RepairedRoleColor {
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
export function repairTowardFloor(
  candidate: RoleColor,
  groundHex: string,
  minRatio: number,
  takenHexes: ReadonlySet<string>,
): RepairedRoleColor {
  const isBelowFloor = candidate.contrastRatio < minRatio;
  const isCollision = isTaken(candidate.hex, takenHexes);
  if (!isBelowFloor && !isCollision) return finalize(candidate, false, false);

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
function repairMuted(
  candidate: RoleColor,
  groundHex: string,
  body: RepairedRoleColor,
  takenHexes: ReadonlySet<string>,
): RepairedRoleColor {
  const isTooFaint = candidate.contrastRatio < MUTED_MIN_RATIO;
  const doesOutrankBody = candidate.contrastRatio >= body.contrastRatio;
  const isCollision = isTaken(candidate.hex, takenHexes);
  if (!isTooFaint && !doesOutrankBody && !isCollision) return finalize(candidate, false, false);

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
export function repairFailingRoles(assignment: RoleAssignment): ContrastReport {
  const groundHex = assignment.ground.hex;
  const takenHexes = new Set<string>([groundHex.toLowerCase()]);

  const repairTextRole = (role: Exclude<Role, "ground" | "muted">): RepairedRoleColor => {
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

  const resolvedPalette: ResolvedPalette = Object.freeze({ ground, body, accent, muted, success, error });
  const repairedRoles = ROLES.filter((role) => resolvedPalette[role].wasRepaired);
  const fallbackRoles = ROLES.filter((role) => resolvedPalette[role].isFallback);

  return {
    palette: resolvedPalette,
    repairedRoles: Object.freeze(repairedRoles),
    fallbackRoles: Object.freeze(fallbackRoles),
  };
}

/**
 * Runs the full pipeline — parse, assign, repair — and reduces it to the
 * flat role-to-hex table every colour-consuming adapter needs. Oh My
 * Posh's palette block and Herdr's [theme.custom] block both key off
 * exactly this shape, so it is computed once here rather than twice.
 */
export function resolveRoleHexes(scheme: Scheme): Record<Role, string> {
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
