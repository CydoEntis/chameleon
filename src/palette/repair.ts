import { MUTED_MIN_RATIO, ROLES, TEXT_MIN_RATIO, WCAG_CONTRAST_OFFSET, type Role } from "../constants.js";
import { contrastRatio, fromHsl, relativeLuminance, toHsl } from "./color.js";
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
  /** Repaired roles that still could not clear their floor without a collision, and fell back to a computed grey. */
  readonly fallbackRoles: readonly Role[];
}

/** Ratio a repair targets past its floor, so integer-RGB rounding on the repaired hex never lands it back under the floor. */
const RATIO_CLEARANCE_MARGIN = 1.05;

/** Fraction of body's ratio a repaired muted targets, so it reads as clearly secondary rather than barely so — proportional, not a fixed gap, so it still holds when body's ratio is large. */
const MUTED_BELOW_BODY_FRACTION = 0.9;

/** How much further from ground a repair pushes a colour that already clears its floor but collides with an earlier role. */
const COLLISION_NUDGE_MULTIPLIER = 1.15;

/** Bisections used to find the HSL lightness that hits a target relative luminance; 40 gives far more precision than an 8-bit channel can express. */
const LIGHTNESS_SEARCH_ITERATIONS = 40;

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
  const groundLuminance = relativeLuminance(groundHex);
  const rawTargetLuminance = isLighterThanGround
    ? targetRatio * (groundLuminance + WCAG_CONTRAST_OFFSET) - WCAG_CONTRAST_OFFSET
    : (groundLuminance + WCAG_CONTRAST_OFFSET) / targetRatio - WCAG_CONTRAST_OFFSET;
  const targetLuminance = Math.min(1, Math.max(0, rawTargetLuminance));
  const lightness = lightnessForLuminance(hue, saturation, targetLuminance);

  return fromHsl({ hue, saturation, lightness });
}

function finalize(candidate: RoleColor, wasRepaired: boolean, isFallback: boolean): RepairedRoleColor {
  return Object.freeze({ ...candidate, wasRepaired, isFallback });
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
  const { hue, saturation } = toHsl(candidate.hex);
  const repairedHex = retarget(hue, saturation, groundHex, targetRatio, isLighterThanGround);
  const repaired = { hex: repairedHex, slot: candidate.slot, contrastRatio: contrastRatio(repairedHex, groundHex) };

  if (!isTaken(repairedHex, takenHexes)) return finalize(repaired, true, false);

  // Repairing by hue still collides — fall back to a computed, hue-free
  // grey at the same target, which cannot collide with a saturated role.
  const fallbackHex = retarget(0, 0, groundHex, targetRatio, isLighterThanGround);
  return finalize(
    { hex: fallbackHex, slot: candidate.slot, contrastRatio: contrastRatio(fallbackHex, groundHex) },
    true,
    true,
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
  const repairedHex = retarget(hue, saturation, groundHex, targetRatio, isLighterThanGround);

  return finalize(
    { hex: repairedHex, slot: candidate.slot, contrastRatio: contrastRatio(repairedHex, groundHex) },
    true,
    false,
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
