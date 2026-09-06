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

import { ACTIVE_ROW_MIN_VISIBLE_RATIO, MUTED_MIN_RATIO, RATIO_CLEARANCE_MARGIN, TEXT_MIN_RATIO } from "../constants.js";
import { chromaOf, contrastRatio, fromHueChromaMatch, mix, relativeLuminance, toHsl } from "./color.js";
import { matchValueForLuminance, repairForegroundAgainstBackgrounds, targetLuminanceFor } from "./repair.js";

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

/** Bisections used to find the fraction that clears a floor; matches repair.ts's own SEARCH_ITERATIONS — 40 gives far more precision than an 8-bit channel can express. */
const SEARCH_ITERATIONS = 40;

export interface ResolvedActiveRowBackground {
  readonly hex: string;
  readonly wasRepaired: boolean;
}

/**
 * The smallest fraction, at or above `lowFraction`, whose ground/body mix
 * clears `minRatio` against ground. Contrast rises monotonically with
 * fraction here: `mix` moves each channel linearly from ground's own byte
 * value toward body's (see mix in color.ts), and relative luminance is a
 * monotonic function of every channel, so contrast-vs-ground only grows as
 * fraction moves from 0 (ground itself, ratio 1) toward 1 (body itself,
 * already guaranteed to clear TEXT_MIN_RATIO — see repairFailingRoles). A
 * floor at or below that is always reachable, so this bisection never runs
 * out of room the way a role's own hue-preserving repair occasionally does.
 *
 * `lowFraction` is `idealFraction` when called from the "push further from
 * ground" branch below, and 0 when called to find the absolute lowest
 * fraction visibility allows at all — see
 * fractionClearingMutedReadability's own bound.
 */
function fractionClearingVisibilityFloor(groundHex: string, bodyHex: string, lowFraction: number, minRatio: number): number {
  let low = lowFraction;
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
 * The largest fraction, within [`lowFraction`, `highFraction`], whose
 * ground/body mix still lets `mutedHex` clear `minRatio` against it — the
 * mirror image of fractionClearingVisibilityFloor's own search. Muted's own
 * resolved value sits far closer to body than any fraction this range
 * reaches (repairMuted, in repair.ts, aims it near body's own ratio), so as
 * the row's fraction rises from `lowFraction` toward `highFraction` it moves
 * *toward* muted's own luminance rather than away from it, and contrast
 * against it falls monotonically over exactly this range — the opposite
 * direction from the row-vs-ground search above. Callers only reach this
 * once they already know `highFraction` itself fails to clear `minRatio`
 * (CHM-75's whole reason to search at all) and `lowFraction` still does, so
 * the loop's invariant — `low` always clears the floor, `high` never does —
 * holds from the first iteration.
 */
function fractionClearingMutedReadability(groundHex: string, bodyHex: string, mutedHex: string, lowFraction: number, highFraction: number, minRatio: number): number {
  let low = lowFraction;
  let high = highFraction;
  for (let iteration = 0; iteration < SEARCH_ITERATIONS; iteration += 1) {
    const midFraction = (low + high) / 2;
    if (contrastRatio(mutedHex, mix(groundHex, bodyHex, midFraction)) < minRatio) {
      high = midFraction;
    } else {
      low = midFraction;
    }
  }
  return low;
}

/**
 * Resolves the selected row's own background against two floors at once:
 * ACTIVE_ROW_MIN_VISIBLE_RATIO against ground (CHM-50, a hard floor, never
 * traded away) and TEXT_MIN_RATIO for `mutedHex` — subtext0, already
 * repaired against every other surface by the caller — once it renders on
 * top of the row (CHM-75). `mix(groundHex, bodyHex, idealFraction)`
 * unchanged when it already clears both; otherwise the least extreme move
 * off `idealFraction` that clears whichever it does not, the same "nearest
 * colour that still gets there" shape resolveSelectionAndBody already uses
 * for the selection highlight:
 *
 * - Ideal fails row-vs-ground: push further from ground (see
 *   fractionClearingVisibilityFloor) — visibility is the hard floor, so this
 *   never looks back at muted's own readability once it fires.
 * - Ideal clears row-vs-ground but muted cannot be read against it: fall
 *   fraction back toward ground instead (see fractionClearingMutedReadability),
 *   bounded below by the same visibility floor computed from 0 rather than
 *   from `idealFraction`, so readability is never bought by giving up
 *   visibility either.
 *
 * The result is always a blend of this theme's own ground and body, so it
 * reads as the theme's own colours either way, never a synthesised grey
 * (CHM-38's own guarantee, held here too).
 */
export function resolveActiveRowBackground(groundHex: string, bodyHex: string, mutedHex: string, idealFraction: number): ResolvedActiveRowBackground {
  const idealHex = mix(groundHex, bodyHex, idealFraction);
  const minAcceptableVisibilityRatio = ACTIVE_ROW_MIN_VISIBLE_RATIO * RATIO_CLEARANCE_MARGIN;
  const minAcceptableReadabilityRatio = TEXT_MIN_RATIO * RATIO_CLEARANCE_MARGIN;
  const isIdealVisible = contrastRatio(idealHex, groundHex) >= minAcceptableVisibilityRatio;
  const isIdealReadable = contrastRatio(mutedHex, idealHex) >= minAcceptableReadabilityRatio;
  if (isIdealVisible && isIdealReadable) {
    return { hex: idealHex, wasRepaired: false };
  }

  if (!isIdealVisible) {
    const fraction = fractionClearingVisibilityFloor(groundHex, bodyHex, idealFraction, minAcceptableVisibilityRatio);
    return { hex: mix(groundHex, bodyHex, fraction), wasRepaired: true };
  }

  const lowestVisibleFraction = fractionClearingVisibilityFloor(groundHex, bodyHex, 0, minAcceptableVisibilityRatio);
  const fraction = fractionClearingMutedReadability(groundHex, bodyHex, mutedHex, lowestVisibleFraction, idealFraction, minAcceptableReadabilityRatio);
  return { hex: mix(groundHex, bodyHex, fraction), wasRepaired: true };
}

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
 * row (`groundHex`) and a selected one. Hue and chroma held fixed, the same
 * repairForegroundAgainstBackgrounds machinery `resolveActiveRowAndText`
 * itself already uses for text and subtext0 — unrepaired when the plain
 * ramp value already clears TEXT_MIN_RATIO against both.
 */
export function repairOverlay0(candidateHex: string, groundHex: string, activeRowBackgroundHex: string): string {
  return repairForegroundAgainstBackgrounds(candidateHex, [groundHex, activeRowBackgroundHex], TEXT_MIN_RATIO) ?? candidateHex;
}

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

/** Whether `hex` clears `minRatio` against every one of `backgroundHexes` — not just the worst one, since resolveRoleHexes' own repair can already have moved a colour, and this is what confirms the move actually worked everywhere it needs to, not just against whichever background the search happened to anchor on. */
function clearsFloorEverywhere(hex: string, backgroundHexes: readonly string[], minRatio: number): boolean {
  return backgroundHexes.every((backgroundHex) => contrastRatio(hex, backgroundHex) >= minRatio);
}

/**
 * The second lever `resolveActiveRowAndText` reaches for when moving
 * active_row_bg's own fraction (see resolveActiveRowBackground) still
 * leaves `mutedHex` unable to clear TEXT_MIN_RATIO against it: repairs
 * muted's own luminance again, hue and chroma held fixed, toward whatever
 * clears TEXT_MIN_RATIO against `activeRowHex` specifically — capped so it
 * never reaches body's own ratio against ground, so a muted this pushes
 * never reads as prominent as the text it sits beside. The cap holds the
 * same RATIO_CLEARANCE_MARGIN gap every floor in this codebase already
 * treats as "clearly, measurably clear of the line" — no wider, since a
 * generous gap here (repairMuted's own MUTED_BELOW_BODY_FRACTION, meant for
 * muted's everyday reading) would leave far less of body's own headroom for
 * this narrower, row-only ambition to spend.
 *
 * Even that narrow gap is not always reachable. For a pack whose body
 * itself has little headroom over its own TEXT_MIN_RATIO floor, or whose
 * active row sits far enough from ground that clearing TEXT_MIN_RATIO
 * against it demands more luminance than body's own ratio allows underneath
 * the cap, there is no value for muted that is *both* past TEXT_MIN_RATIO
 * on the row *and* clearly short of body. TEXT_MIN_RATIO on the row is
 * reached for here, the same "maximise, never demand" shape
 * SELECTION_IDEAL_RATIO already uses for the selection highlight (CHM-30
 * proved that one unreachable for 10 of the 26 bundled packs); the achieved
 * ratio is reported back, never silently claimed — see herdr.test.ts's own
 * per-pack fixture.
 *
 * The cap itself never wins against MUTED_MIN_RATIO on the row: that floor
 * is CHM-50's own regression guarantee, already the shipped behaviour for
 * every bundled pack, and this function exists to raise it toward
 * TEXT_MIN_RATIO, never to hand back something that clears it less than
 * CHM-50 already did. A small number of bundled packs need exactly this
 * escape hatch — body's own ratio leaves no luminance that is both under
 * the cap and back up to even MUTED_MIN_RATIO on the row — and there the
 * floor wins: muted lands measurably closer to body than the cap would
 * otherwise allow, on those packs, rather than shipping a subtext0 this
 * ticket would otherwise have made *less* readable on the row than it
 * already was.
 */
function repairMutedForActiveRow(mutedHex: string, groundHex: string, bodyHex: string, activeRowHex: string): string {
  const isLighterThanGround = relativeLuminance(mutedHex) >= relativeLuminance(groundHex);
  const idealRowRatio = TEXT_MIN_RATIO * RATIO_CLEARANCE_MARGIN;
  const minAcceptableRowRatio = MUTED_MIN_RATIO * RATIO_CLEARANCE_MARGIN;
  const ceilingRatio = contrastRatio(bodyHex, groundHex) / RATIO_CLEARANCE_MARGIN;

  const idealLuminance = targetLuminanceFor(activeRowHex, idealRowRatio, isLighterThanGround);
  const floorLuminance = targetLuminanceFor(activeRowHex, minAcceptableRowRatio, isLighterThanGround);
  const ceilingLuminance = targetLuminanceFor(groundHex, ceilingRatio, isLighterThanGround);
  const targetLuminance = isLighterThanGround
    ? Math.max(Math.min(idealLuminance, ceilingLuminance), floorLuminance)
    : Math.min(Math.max(idealLuminance, ceilingLuminance), floorLuminance);

  const { hue } = toHsl(mutedHex);
  const chroma = chromaOf(mutedHex);
  const matchValue = matchValueForLuminance(hue, chroma, targetLuminance);
  return fromHueChromaMatch({ hue, chroma, matchValue });
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
export function resolveActiveRowAndText(
  groundHex: string,
  bodyHex: string,
  mutedHex: string,
  otherSurfaceHexes: readonly string[],
  idealFraction: number,
): ResolvedRowAndText {
  const mutedSurfaces = [groundHex, ...otherSurfaceHexes];
  const ordinarySubtextHex = repairForegroundAgainstBackgrounds(mutedHex, mutedSurfaces, MUTED_MIN_RATIO) ?? mutedHex;

  const activeRow = resolveActiveRowBackground(groundHex, bodyHex, ordinarySubtextHex, idealFraction);
  const surfaces = [groundHex, activeRow.hex, ...otherSurfaceHexes];
  const textHex = repairForegroundAgainstBackgrounds(bodyHex, surfaces, TEXT_MIN_RATIO) ?? bodyHex;

  // The cap in repairMutedForActiveRow measures against textHex — what
  // Herdr actually paints as body text — not the pre-repair bodyHex: text
  // itself often has to climb to clear TEXT_MIN_RATIO against this same,
  // pulled-back row (see the repair immediately above), which is exactly
  // the headroom "below body" is supposed to measure against.
  const isOrdinarySubtextReadableOnRow = contrastRatio(ordinarySubtextHex, activeRow.hex) >= TEXT_MIN_RATIO;
  const subtextHex = isOrdinarySubtextReadableOnRow ? ordinarySubtextHex : repairMutedForActiveRow(mutedHex, groundHex, textHex, activeRow.hex);

  // subtext0-on-row is maximised toward TEXT_MIN_RATIO by
  // repairMutedForActiveRow, not demanded — see its own doc comment for why
  // a handful of packs cannot clear it without reading as prominent as body,
  // and why that function lets "below body" give way before it ever regresses
  // subtext0-on-row below MUTED_MIN_RATIO, CHM-50's own guarantee. What this
  // checks is that neither hard floor gave way: at least MUTED_MIN_RATIO
  // everywhere muted appears, including the row, and text still fully
  // readable everywhere it appears.
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
