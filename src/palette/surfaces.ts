/**
 * Resolves Herdr's selected-row background against its own sidebar, and the
 * text tokens rendered on top of it — the fix CHM-50 asks for after CHM-48
 * traded one broken state for another. CHM-48 measured the sidebar's
 * selected row (subtext0 on active_row_bg) failing MUTED_MIN_RATIO in 22 of
 * 26 bundled packs, and fixed it by pulling active_row_bg toward
 * sidebar_bg — but that made row-vs-sidebar itself collapse below 1.15 in
 * 17 of the 26, dracula-dark measuring 1.00, the same colour: the row was
 * readable and no longer visibly selected at all. Both states are broken,
 * and CHM-30 already settled the shape this kind of trade-off takes here:
 * name a hard floor and maximise the other objective subject to it, rather
 * than demanding both survive independent, unrelated repairs.
 *
 * Order matters, and it is the reverse of CHM-48's own: active_row_bg is
 * chosen for visibility against sidebar_bg first (see
 * resolveActiveRowBackground) and is a hard floor throughout. Text and
 * subtext0 are then repaired against every text-bearing surface at once —
 * sidebar_bg, active_row_bg and whatever else the caller enumerates from
 * its own token list (e.g. Herdr's panel_bg and selection_bg) — via
 * repairForegroundAgainstBackgrounds (CHM-40), since Herdr paints from one
 * shared `text` and one shared `subtext0` value, not one copy per surface.
 * Only when no single text colour can clear both floors across every
 * surface at that visibility does the row retreat toward ground instead,
 * and that trade is reported back, never made silently.
 */

import { ACTIVE_ROW_MIN_VISIBLE_RATIO, MUTED_MIN_RATIO, RATIO_CLEARANCE_MARGIN, TEXT_MIN_RATIO } from "../constants.js";
import { contrastRatio, mix } from "./color.js";
import { repairForegroundAgainstBackgrounds } from "./repair.js";

/**
 * How far between ground and body the selected row sits before any repair —
 * a row is meant to read as a slightly raised surface, the same tone as
 * Herdr's own surface0 (see adapters/herdr.ts's surface scale), not a
 * colour of its own. Shared rather than redefined per caller: theme-pack.ts
 * (build time) and herdr.ts (live apply) must never disagree about what
 * this fraction is, the same "one source of truth" contract
 * resolveSelectionAndBody already holds for the selection highlight.
 */
export const ACTIVE_ROW_IDEAL_FRACTION = 2 / 6;

/** Bisections used to find the fraction that clears the visibility floor; matches repair.ts's own SEARCH_ITERATIONS — 40 gives far more precision than an 8-bit channel can express. */
const SEARCH_ITERATIONS = 40;

export interface ResolvedActiveRowBackground {
  readonly hex: string;
  readonly wasRepaired: boolean;
}

/**
 * The smallest fraction, at or above `idealFraction`, whose ground/body mix
 * clears `minRatio` against ground. Contrast rises monotonically with
 * fraction here: `mix` moves each channel linearly from ground's own byte
 * value toward body's (see mix in color.ts), and relative luminance is a
 * monotonic function of every channel, so contrast-vs-ground only grows as
 * fraction moves from 0 (ground itself, ratio 1) toward 1 (body itself,
 * already guaranteed to clear TEXT_MIN_RATIO — see repairFailingRoles). A
 * floor at or below that is always reachable, so this bisection never runs
 * out of room the way a role's own hue-preserving repair occasionally does.
 */
function fractionClearingVisibilityFloor(groundHex: string, bodyHex: string, idealFraction: number, minRatio: number): number {
  let low = idealFraction;
  let high = 1;
  for (let iteration = 0; iteration < SEARCH_ITERATIONS; iteration += 1) {
    const midFraction = (low + high) / 2;
    if (contrastRatio(mix(groundHex, bodyHex, midFraction), groundHex) < minRatio) {
      low = midFraction;
    } else {
      high = midFraction;
    }
  }
  return high;
}

/**
 * Resolves the selected row's own background: `mix(groundHex, bodyHex,
 * idealFraction)` unchanged when it already clears
 * ACTIVE_ROW_MIN_VISIBLE_RATIO against ground, or the nearest fraction above
 * it that does (see fractionClearingVisibilityFloor) when it does not — the
 * least extreme move that restores visibility, the same "nearest colour
 * that still gets there" shape resolveSelectionAndBody already uses for the
 * selection highlight. The result is always a blend of this theme's own
 * ground and body, so it reads as the theme's own colours either way,
 * never a synthesised grey (CHM-38's own guarantee, held here too).
 */
export function resolveActiveRowBackground(groundHex: string, bodyHex: string, idealFraction: number): ResolvedActiveRowBackground {
  const idealHex = mix(groundHex, bodyHex, idealFraction);
  const minAcceptableRatio = ACTIVE_ROW_MIN_VISIBLE_RATIO * RATIO_CLEARANCE_MARGIN;
  if (contrastRatio(idealHex, groundHex) >= minAcceptableRatio) {
    return { hex: idealHex, wasRepaired: false };
  }

  const fraction = fractionClearingVisibilityFloor(groundHex, bodyHex, idealFraction, minAcceptableRatio);
  return { hex: mix(groundHex, bodyHex, fraction), wasRepaired: true };
}

export interface ResolvedRowAndText {
  readonly activeRowBackgroundHex: string;
  readonly textHex: string;
  readonly subtextHex: string;
  /**
   * True only when no single text colour could clear both TEXT_MIN_RATIO
   * and MUTED_MIN_RATIO across every surface at the row's own visibility
   * target, and active_row_bg had to retreat toward ground instead of
   * holding it. No bundled pack ever reaches this: every one of the 26
   * clears both floors at ACTIVE_ROW_MIN_VISIBLE_RATIO (see
   * herdr.test.ts's own "active row vs sidebar, text and subtext0" suite).
   */
  readonly wasVisibilityTraded: boolean;
}

/** Whether `hex` clears `minRatio` against every one of `backgroundHexes` — not just the worst one, since resolveRoleHexes' own repair can already have moved a colour, and this is what confirms the move actually worked everywhere it needs to, not just against whichever background the search happened to anchor on. */
function clearsFloorEverywhere(hex: string, backgroundHexes: readonly string[], minRatio: number): boolean {
  return backgroundHexes.every((backgroundHex) => contrastRatio(hex, backgroundHex) >= minRatio);
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
 * The retreat, when needed, falls all the way back to `idealFraction`'s own
 * unrepaired candidate rather than searching for a minimal nudge: that
 * candidate is exactly what every bundled pack already ships today (see
 * this module's doc comment), so it is a known-safe floor to land on, and a
 * bisected minimal retreat would be speculative complexity with no real
 * fixture able to verify it against.
 */
export function resolveActiveRowAndText(
  groundHex: string,
  bodyHex: string,
  mutedHex: string,
  otherSurfaceHexes: readonly string[],
  idealFraction: number,
): ResolvedRowAndText {
  const activeRow = resolveActiveRowBackground(groundHex, bodyHex, idealFraction);
  const surfaces = [groundHex, activeRow.hex, ...otherSurfaceHexes];

  const textHex = repairForegroundAgainstBackgrounds(bodyHex, surfaces, TEXT_MIN_RATIO) ?? bodyHex;
  const subtextHex = repairForegroundAgainstBackgrounds(mutedHex, surfaces, MUTED_MIN_RATIO) ?? mutedHex;

  const isFullySatisfied = clearsFloorEverywhere(textHex, surfaces, TEXT_MIN_RATIO) && clearsFloorEverywhere(subtextHex, surfaces, MUTED_MIN_RATIO);
  if (isFullySatisfied) {
    return { activeRowBackgroundHex: activeRow.hex, textHex, subtextHex, wasVisibilityTraded: false };
  }

  const retreatedRowHex = mix(groundHex, bodyHex, idealFraction);
  const retreatedSurfaces = [groundHex, retreatedRowHex, ...otherSurfaceHexes];
  const retreatedTextHex = repairForegroundAgainstBackgrounds(bodyHex, retreatedSurfaces, TEXT_MIN_RATIO) ?? bodyHex;
  const retreatedSubtextHex = repairForegroundAgainstBackgrounds(mutedHex, retreatedSurfaces, MUTED_MIN_RATIO) ?? mutedHex;
  return { activeRowBackgroundHex: retreatedRowHex, textHex: retreatedTextHex, subtextHex: retreatedSubtextHex, wasVisibilityTraded: true };
}
