import {
  MIN_REPAIRED_CHROMA,
  MUTED_MIN_RATIO,
  ROLES,
  TEXT_MIN_RATIO,
  WCAG_CONTRAST_OFFSET,
  type Role,
} from "../constants.js";
import { chromaOf, contrastRatio, fromHsl, relativeLuminance, toHsl } from "./color.js";
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
   * Repaired roles that still could not clear their floor — without a
   * collision, or without collapsing below MIN_REPAIRED_CHROMA even after
   * trading hue and saturation — and fell back to a computed grey.
   */
  readonly fallbackRoles: readonly Role[];
}

/** Ratio a repair targets past its floor, so integer-RGB rounding on the repaired hex never lands it back under the floor. */
const RATIO_CLEARANCE_MARGIN = 1.05;

/** Same purpose as RATIO_CLEARANCE_MARGIN, for MIN_REPAIRED_CHROMA: the chroma trade aims past its floor so rounding a bisected lightness to an 8-bit channel never lands it back under. */
const CHROMA_CLEARANCE_MARGIN = 1.1;

/** Fraction of body's ratio a repaired muted targets, so it reads as clearly secondary rather than barely so — proportional, not a fixed gap, so it still holds when body's ratio is large. */
const MUTED_BELOW_BODY_FRACTION = 0.9;

/** How much further from ground a repair pushes a colour that already clears its floor but collides with an earlier role. */
const COLLISION_NUDGE_MULTIPLIER = 1.15;

/** Bisections used to find the HSL lightness that hits a target relative luminance; 40 gives far more precision than an 8-bit channel can express. */
const LIGHTNESS_SEARCH_ITERATIONS = 40;

/** HSL saturation's ceiling — the chroma trade always spends all of it before it spends any hue, since saturation is free to raise and hue is not. */
const MAX_SATURATION = 100;

/**
 * Degrees a repair may shift a colour's hue while hunting for one that
 * clears its floor without collapsing below MIN_REPAIRED_CHROMA. Bounded so
 * a role can drift toward a more forgiving hue without drifting far enough
 * to be misread as a different one — a "success" role nudged much past
 * this would start reading as an error's red.
 */
const HUE_TRADE_MAX_DEGREES = 30;

/** Step size for the bounded hue search — fine enough to find the least drift that clears MIN_REPAIRED_CHROMA, coarse enough to stay cheap. */
const HUE_TRADE_STEP_DEGREES = 5;

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

/** The HSL lightness, for a fixed hue and saturation, whose relative luminance is closest to the target. Luminance rises monotonically with lightness, so this is a plain bisection. */
function lightnessForLuminance(hue: number, saturation: number, targetLuminance: number): number {
  let low = 0;
  let high = 100;
  for (let iteration = 0; iteration < LIGHTNESS_SEARCH_ITERATIONS; iteration += 1) {
    const midLightness = (low + high) / 2;
    const midLuminance = relativeLuminance(fromHsl({ hue, saturation, lightness: midLightness }));
    if (midLuminance < targetLuminance) {
      low = midLightness;
    } else {
      high = midLightness;
    }
  }
  return (low + high) / 2;
}

/**
 * Shifts a colour's lightness — hue and saturation held fixed — until it
 * measures `targetRatio` against ground, staying on the side of ground
 * (lighter or darker) it already occupies. Raising the target pushes it
 * toward the pole opposite ground (more contrast); lowering the target
 * pulls it back toward ground's own lightness (less contrast) without
 * crossing to the other side.
 */
function retarget(
  hue: number,
  saturation: number,
  groundHex: string,
  targetRatio: number,
  isLighterThanGround: boolean,
): string {
  const targetLuminance = targetLuminanceFor(groundHex, targetRatio, isLighterThanGround);
  const lightness = lightnessForLuminance(hue, saturation, targetLuminance);

  return fromHsl({ hue, saturation, lightness });
}

/** The relative luminance `retarget` aims for: `targetRatio` against ground, clamped to the [0, 1] a luminance can actually take. */
function targetLuminanceFor(groundHex: string, targetRatio: number, isLighterThanGround: boolean): number {
  const groundLuminance = relativeLuminance(groundHex);
  const rawTargetLuminance = isLighterThanGround
    ? targetRatio * (groundLuminance + WCAG_CONTRAST_OFFSET) - WCAG_CONTRAST_OFFSET
    : (groundLuminance + WCAG_CONTRAST_OFFSET) / targetRatio - WCAG_CONTRAST_OFFSET;
  return Math.min(1, Math.max(0, rawTargetLuminance));
}

/**
 * The relative luminance at which a colour of this hue, at MAX_SATURATION,
 * has exactly MIN_REPAIRED_CHROMA — the last lightness a chroma-preserving
 * trade may reach before it is pushed further toward the pole than the
 * chroma floor allows. Luminance rises monotonically with lightness (see
 * lightnessForLuminance), so capping a target at this luminance is the same
 * as capping lightness at the chroma floor's edge.
 */
function chromaFloorLuminance(hue: number, isLighterThanGround: boolean): number {
  const targetChroma = MIN_REPAIRED_CHROMA * CHROMA_CLEARANCE_MARGIN;
  const boundLightness = isLighterThanGround ? 100 * (1 - targetChroma / 2) : 100 * (targetChroma / 2);
  return relativeLuminance(fromHsl({ hue, saturation: MAX_SATURATION, lightness: boundLightness }));
}

/** Wraps a hue shift back into HSL's [0, 360) range. */
function normalizeHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

/**
 * Shifts by up to HUE_TRADE_MAX_DEGREES on either side of `hue`, nearest
 * first: 0, +step, -step, +2*step, -2*step, and so on. The caller tries
 * each in turn and stops at the first that works, so this is the order a
 * repair prefers a trade in — least drift from the original hue before
 * more.
 */
function candidateHueShifts(): number[] {
  const shifts = [0];
  for (let degrees = HUE_TRADE_STEP_DEGREES; degrees <= HUE_TRADE_MAX_DEGREES; degrees += HUE_TRADE_STEP_DEGREES) {
    shifts.push(degrees, -degrees);
  }
  return shifts;
}

/**
 * Retargets a colour the way `retarget` does, but when holding hue and
 * saturation fixed would land it below MIN_REPAIRED_CHROMA — the fate of a
 * colour with no lightness headroom left in the needed direction, driven
 * instead toward white or black — this spends saturation first, then a
 * bounded amount of hue, hunting for a nearby colour that clears both the
 * chroma floor and `minAcceptableRatio`.
 *
 * Each candidate's target luminance is capped at chromaFloorLuminance
 * rather than handed to `retarget` as-is: an uncapped target that already
 * demands more contrast than any hue can deliver would simply bottom out
 * at literal white or black again, on every hue tried, and the trade would
 * never find anything. Capping means a candidate that cannot reach the
 * ideal ratio still lands as far as it safely can, and is judged on the
 * ratio that got it — never on lightness alone.
 *
 * Returns null if nothing in that bounded search clears both; the caller
 * falls back to a computed grey.
 */
function retargetPreservingChroma(
  hue: number,
  saturation: number,
  groundHex: string,
  targetRatio: number,
  isLighterThanGround: boolean,
  minAcceptableRatio: number,
): string | null {
  const plainHex = retarget(hue, saturation, groundHex, targetRatio, isLighterThanGround);
  if (chromaOf(plainHex) >= MIN_REPAIRED_CHROMA) return plainHex;

  const idealTargetLuminance = targetLuminanceFor(groundHex, targetRatio, isLighterThanGround);

  for (const hueShift of candidateHueShifts()) {
    const candidateHue = normalizeHue(hue + hueShift);
    const chromaFloorTargetLuminance = chromaFloorLuminance(candidateHue, isLighterThanGround);
    const cappedTargetLuminance = isLighterThanGround
      ? Math.min(idealTargetLuminance, chromaFloorTargetLuminance)
      : Math.max(idealTargetLuminance, chromaFloorTargetLuminance);
    const lightness = lightnessForLuminance(candidateHue, MAX_SATURATION, cappedTargetLuminance);
    const candidateHex = fromHsl({ hue: candidateHue, saturation: MAX_SATURATION, lightness });

    if (contrastRatio(candidateHex, groundHex) >= minAcceptableRatio) return candidateHex;
  }

  return null;
}

function finalize(candidate: RoleColor, wasRepaired: boolean, isFallback: boolean): RepairedRoleColor {
  return Object.freeze({ ...candidate, wasRepaired, isFallback });
}

/**
 * Shared last step of both repairTowardFloor and repairMuted: try the
 * chroma-preserving trade, and use it if it landed somewhere not already
 * taken; otherwise fall back to a computed, hue-free grey at the same
 * target, which cannot collide with a saturated role and is reported
 * rather than shipped washed out.
 */
function resolveRepair(
  slot: RoleColor["slot"],
  groundHex: string,
  hue: number,
  saturation: number,
  targetRatio: number,
  isLighterThanGround: boolean,
  minAcceptableRatio: number,
  takenHexes: ReadonlySet<string>,
): RepairedRoleColor {
  const tradedHex = retargetPreservingChroma(
    hue,
    saturation,
    groundHex,
    targetRatio,
    isLighterThanGround,
    minAcceptableRatio,
  );
  if (tradedHex && !isTaken(tradedHex, takenHexes)) {
    return finalize({ hex: tradedHex, slot, contrastRatio: contrastRatio(tradedHex, groundHex) }, true, false);
  }

  const fallbackHex = retarget(0, 0, groundHex, targetRatio, isLighterThanGround);
  return finalize({ hex: fallbackHex, slot, contrastRatio: contrastRatio(fallbackHex, groundHex) }, true, true);
}

/**
 * Repairs one role against a single floor. Also repairs a role that
 * already clears its floor but landed on a colour an earlier role already
 * claimed — a role that reads identically to another is still broken, even
 * if both individually pass.
 */
function repairTowardFloor(
  candidate: RoleColor,
  groundHex: string,
  minRatio: number,
  takenHexes: ReadonlySet<string>,
): RepairedRoleColor {
  const isBelowFloor = candidate.contrastRatio < minRatio;
  const isCollision = isTaken(candidate.hex, takenHexes);
  if (!isBelowFloor && !isCollision) return finalize(candidate, false, false);

  const targetRatio = isBelowFloor
    ? minRatio * RATIO_CLEARANCE_MARGIN
    : candidate.contrastRatio * COLLISION_NUDGE_MULTIPLIER;
  // Below the floor, aim at whichever pole has more contrast headroom. A
  // collision-only nudge instead stays on the candidate's own side — it
  // already clears its floor, it just needs to stop matching another role.
  const isLighterThanGround = isBelowFloor
    ? poleWithMoreHeadroom(groundHex)
    : relativeLuminance(candidate.hex) >= relativeLuminance(groundHex);
  // A below-floor repair must still clear minRatio once it lands; a
  // collision-only nudge only has to stay at least as separated from
  // ground as the candidate already was.
  const minAcceptableRatio = isBelowFloor ? minRatio : candidate.contrastRatio;
  const { hue, saturation } = toHsl(candidate.hex);

  return resolveRepair(
    candidate.slot,
    groundHex,
    hue,
    saturation,
    targetRatio,
    isLighterThanGround,
    minAcceptableRatio,
    takenHexes,
  );
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
  const { hue, saturation } = toHsl(candidate.hex);
  const targetRatio = isTooFaint
    ? MUTED_MIN_RATIO * RATIO_CLEARANCE_MARGIN
    : Math.max(MUTED_MIN_RATIO * RATIO_CLEARANCE_MARGIN, body.contrastRatio * MUTED_BELOW_BODY_FRACTION);

  return resolveRepair(
    candidate.slot,
    groundHex,
    hue,
    saturation,
    targetRatio,
    isLighterThanGround,
    MUTED_MIN_RATIO,
    takenHexes,
  );
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
