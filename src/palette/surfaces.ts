/**
 * Repairs a neutral surface a target mixes between ground and body — Herdr's
 * panel_bg, active_row_bg and its surface/overlay ramp are the current
 * callers (see adapters/herdr.ts) — so that the text actually rendered on
 * top of it stays legible.
 *
 * Every one of Chameleon's six roles is measured and repaired against
 * ground (see repair.ts). Nothing was ever measured against a surface
 * Chameleon mixes for itself, and that surface is mid-tone by construction —
 * exactly the hardest background either text or muted has to sit on. CHM-48:
 * the sidebar's selected row (text on active_row_bg) went unchecked in every
 * bundled pack, subtext0 measuring as low as 1.07 against its floor of 3.0
 * in 22 of 26.
 *
 * The surface is the free variable, never the text: body and muted are the
 * theme's own resolved colours, already measured and repaired against
 * ground elsewhere. A surface can always retreat toward ground instead,
 * because ground is exactly where body's and muted's own floors are already
 * guaranteed to hold (repairFailingRoles' own contract) — so this can never
 * run out of room the way a role's own repair occasionally does.
 */

import { MUTED_MIN_RATIO, TEXT_MIN_RATIO } from "../constants.js";
import { contrastRatio, mix } from "./color.js";

export interface RepairedSurface {
  readonly hex: string;
  readonly wasRepaired: boolean;
}

/** Bisections used to find the fraction that clears both floors; matches repair.ts's own SEARCH_ITERATIONS — 40 gives far more precision than an 8-bit channel can express. */
const SEARCH_ITERATIONS = 40;

/** Whether `candidateHex` is safe to render both `bodyHex` (text) and `mutedHex` (subtext0) on top of. */
function clearsBothFloors(bodyHex: string, mutedHex: string, candidateHex: string): boolean {
  return contrastRatio(bodyHex, candidateHex) >= TEXT_MIN_RATIO && contrastRatio(mutedHex, candidateHex) >= MUTED_MIN_RATIO;
}

/**
 * The largest fraction at or below `idealFraction` whose ground/body mix
 * clears both floors, by bisection. Fraction 0 (ground itself) always
 * clears both — see this module's own doc comment — so there is always a
 * point to converge toward, even on a pack where subtext0-vs-surface dips
 * below floor partway between ground and body and partially recovers again
 * closer to body (several bundled packs' overlay tokens do exactly this).
 * Bisection here trades finding the single furthest-out fraction that clears
 * both for never landing on one that does not: every fraction it considers
 * "low" was itself checked and passed.
 */
function fractionClearingBothFloors(groundHex: string, bodyHex: string, mutedHex: string, idealFraction: number): number {
  let low = 0;
  let high = idealFraction;
  for (let iteration = 0; iteration < SEARCH_ITERATIONS; iteration += 1) {
    const mid = (low + high) / 2;
    if (clearsBothFloors(bodyHex, mutedHex, mix(groundHex, bodyHex, mid))) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Resolves one surface mixed between `groundHex` and `bodyHex`:
 * `mix(groundHex, bodyHex, idealFraction)` unchanged when it already clears
 * TEXT_MIN_RATIO for text and MUTED_MIN_RATIO for subtext0, or the nearest
 * fraction below it that does (see fractionClearingBothFloors) when it does
 * not. The result is always some blend of ground and body, so it reads as
 * this theme's own colours either way, the same guarantee CHM-38 gives the
 * selection highlight — never a synthesised, hue-free grey.
 */
export function repairSurface(groundHex: string, bodyHex: string, mutedHex: string, idealFraction: number): RepairedSurface {
  const idealHex = mix(groundHex, bodyHex, idealFraction);
  if (clearsBothFloors(bodyHex, mutedHex, idealHex)) {
    return { hex: idealHex, wasRepaired: false };
  }

  const fraction = fractionClearingBothFloors(groundHex, bodyHex, mutedHex, idealFraction);
  return { hex: mix(groundHex, bodyHex, fraction), wasRepaired: true };
}
