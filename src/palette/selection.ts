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
 * landed on pure black. The search now tints ground's own hue instead (see
 * groundTintedAtLuminance), at a chroma related to ground's own but clamped
 * between SELECTION_MIN_CHROMA and SELECTION_MAX_CHROMA — the achieved
 * ratio matches what a grey would reach whenever that clamped chroma still
 * leaves the target luminance reachable, which is the case for all 26
 * bundled packs (see theme-pack.test.ts).
 */

import { RATIO_CLEARANCE_MARGIN, SELECTION_IDEAL_RATIO, SELECTION_MAX_CHROMA, SELECTION_MIN_CHROMA, SELECTION_MIN_VISIBLE_RATIO, TEXT_MIN_RATIO, WCAG_CONTRAST_OFFSET } from "../constants.js";
import { chromaOf, contrastRatio, fromHueChromaMatch, relativeLuminance, toHsl } from "./color.js";
import { matchValueForLuminance } from "./repair.js";

export interface ResolvedSelection {
  readonly hex: string;
  /** contrastRatio(hex, ground) — the achieved pair this ticket asks to be inspectable rather than hidden; see resolveSelectionAndBody. */
  readonly selectionVsGroundRatio: number;
  readonly wasRepaired: boolean;
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

/** Bisections used to find a luminance hitting a target; matches repair.ts's own SEARCH_ITERATIONS — 40 gives far more precision than an 8-bit channel can express. */
const SEARCH_ITERATIONS = 40;

/** One contiguous band of relative luminance, within [0, 1]. */
interface LuminanceInterval {
  readonly low: number;
  readonly high: number;
}

function ratioBetweenLuminances(luminanceA: number, luminanceB: number): number {
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + WCAG_CONTRAST_OFFSET) / (darker + WCAG_CONTRAST_OFFSET);
}

/**
 * The luminance band(s) whose contrast against `referenceLuminance` clears
 * `minRatio` — a darker band and/or a lighter one, either of which is
 * omitted when the reference sits too close to that end of [0, 1] to leave
 * room for it (e.g. a reference already near-black leaves no darker band).
 */
function luminancesClearingRatio(referenceLuminance: number, minRatio: number): LuminanceInterval[] {
  const darkCeiling = (referenceLuminance + WCAG_CONTRAST_OFFSET) / minRatio - WCAG_CONTRAST_OFFSET;
  const lightFloor = minRatio * (referenceLuminance + WCAG_CONTRAST_OFFSET) - WCAG_CONTRAST_OFFSET;

  const intervals: LuminanceInterval[] = [];
  if (darkCeiling >= 0) intervals.push({ low: 0, high: Math.min(1, darkCeiling) });
  if (lightFloor <= 1) intervals.push({ low: Math.max(0, lightFloor), high: 1 });
  return intervals;
}

/**
 * Splits `interval` at `pivot` when it falls strictly inside. Contrast
 * against `pivot` is a "V" shape in luminance space — minimum at `pivot`
 * itself, rising monotonically away from it on either side — so a piece
 * that straddles `pivot` is not monotonic across its own length; splitting
 * there is what makes every returned piece one where the maximum (see
 * bestGroundRatioAmong) or an exact target (see luminanceAtGroundRatio) can
 * be found by looking only at its own two ends.
 */
function splitAtPivot(interval: LuminanceInterval, pivot: number): LuminanceInterval[] {
  if (pivot > interval.low && pivot < interval.high) {
    return [
      { low: interval.low, high: pivot },
      { low: pivot, high: interval.high },
    ];
  }
  return [interval];
}

/** Every luminance clearing the body floor, as one-sided pieces relative to ground — see splitAtPivot. */
function oneSidedPiecesClearingBodyFloor(groundLuminance: number, bodyLuminance: number, bodyFloorRatio: number): LuminanceInterval[] {
  return luminancesClearingRatio(bodyLuminance, bodyFloorRatio).flatMap((interval) => splitAtPivot(interval, groundLuminance));
}

/**
 * The highest contrast-vs-ground any luminance clearing the body floor can
 * reach. Since each piece is one-sided (see oneSidedPiecesClearingBodyFloor),
 * its own maximum sits at one of its two ends — never its interior — so the
 * overall best is just the largest value found at any piece's edge.
 */
function bestGroundRatioAmong(pieces: readonly LuminanceInterval[], groundLuminance: number): number {
  return pieces.reduce(
    (best, piece) => Math.max(best, ratioBetweenLuminances(piece.low, groundLuminance), ratioBetweenLuminances(piece.high, groundLuminance)),
    1,
  );
}

/**
 * The luminance within `piece` whose ground-ratio is exactly `targetRatio`,
 * by bisection — valid because ground-ratio is monotonic across any
 * one-sided piece (see splitAtPivot), so it crosses `targetRatio` exactly
 * once between the piece's own two ends.
 */
function luminanceAtGroundRatio(piece: LuminanceInterval, groundLuminance: number, targetRatio: number): number {
  const ratioRisesWithLuminance = ratioBetweenLuminances(piece.high, groundLuminance) >= ratioBetweenLuminances(piece.low, groundLuminance);
  let low = piece.low;
  let high = piece.high;
  for (let iteration = 0; iteration < SEARCH_ITERATIONS; iteration += 1) {
    const mid = (low + high) / 2;
    const midIsBelowTarget = ratioBetweenLuminances(mid, groundLuminance) < targetRatio;
    if (midIsBelowTarget === ratioRisesWithLuminance) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

/** The luminance nearest ground's own, among every piece able to reach `targetRatio` against ground at all, that hits it exactly — the least extreme colour that still gets there. */
function nearestLuminanceReaching(
  groundLuminance: number,
  bodyLuminance: number,
  bodyFloorRatio: number,
  targetRatio: number,
): number {
  const pieces = oneSidedPiecesClearingBodyFloor(groundLuminance, bodyLuminance, bodyFloorRatio);
  const reachingPieces = pieces.filter(
    (piece) => Math.max(ratioBetweenLuminances(piece.low, groundLuminance), ratioBetweenLuminances(piece.high, groundLuminance)) >= targetRatio,
  );

  const candidateLuminances = reachingPieces.map((piece) => luminanceAtGroundRatio(piece, groundLuminance, targetRatio));
  return candidateLuminances.reduce((nearest, candidate) =>
    Math.abs(candidate - groundLuminance) < Math.abs(nearest - groundLuminance) ? candidate : nearest,
  );
}

/**
 * Ground's own hue, tinted to `targetLuminance` at a chroma clamped between
 * SELECTION_MIN_CHROMA and SELECTION_MAX_CHROMA — CHM-38's replacement for a
 * hue-free grey search. Contrast is a function of luminance alone (see
 * contrastRatio), so whenever that luminance is reachable at this chroma
 * this lands on the same ratio a grey would; it only changes which colour
 * gets there, favouring one that still reads as the theme's own rather than
 * a fill borrowed from a greyscale. The ceiling matters more than it looks:
 * see SELECTION_MAX_CHROMA's own doc comment for why holding ground's full
 * chroma can otherwise pin the result back onto ground itself.
 */
function groundTintedAtLuminance(groundHex: string, targetLuminance: number): string {
  const { hue } = toHsl(groundHex);
  const chroma = Math.min(Math.max(chromaOf(groundHex), SELECTION_MIN_CHROMA), SELECTION_MAX_CHROMA);
  const matchValue = matchValueForLuminance(hue, chroma, targetLuminance);
  return fromHueChromaMatch({ hue, chroma, matchValue });
}

/** `bodyHex`, pushed toward `targetLuminance` while holding its own hue and chroma — a stronger version of the same colour, not a different one. */
function bodyAtLuminance(bodyHex: string, targetLuminance: number): string {
  const { hue } = toHsl(bodyHex);
  const chroma = chromaOf(bodyHex);
  const matchValue = matchValueForLuminance(hue, chroma, targetLuminance);
  return fromHueChromaMatch({ hue, chroma, matchValue });
}

/**
 * The luminance body must move to, on its own current side of ground, for
 * `maxAchievableRatio` (see bestGroundRatioAmong) to clear `targetRatio` —
 * found by bisection since pushing body further from ground only ever
 * widens the band a selection can occupy while still clearing the body
 * floor, never narrows it.
 */
function widenedBodyLuminance(groundLuminance: number, bodyLuminance: number, bodyFloorRatio: number, targetRatio: number): number {
  const isBodyDarkerThanGround = bodyLuminance < groundLuminance;
  const extremeLuminance = isBodyDarkerThanGround ? 0 : 1;

  let insufficient = bodyLuminance;
  let sufficient = extremeLuminance;
  for (let iteration = 0; iteration < SEARCH_ITERATIONS; iteration += 1) {
    const mid = (insufficient + sufficient) / 2;
    const achievableRatio = bestGroundRatioAmong(oneSidedPiecesClearingBodyFloor(groundLuminance, mid, bodyFloorRatio), groundLuminance);
    if (achievableRatio < targetRatio) {
      insufficient = mid;
    } else {
      sufficient = mid;
    }
  }
  return sufficient;
}

/** Resolves the selection highlight against a fixed ground/body pair — the shared last step of resolveSelectionAndBody, run once against the original body and, only when that leaves no room for a visible highlight, again against the widened one. */
function resolveSelectionAgainstBody(
  candidateHex: string,
  groundHex: string,
  bodyHex: string,
  bodyFloorRatio: number,
  achievableRatio: number,
): ResolvedSelection {
  const groundLuminance = relativeLuminance(groundHex);
  const bodyLuminance = relativeLuminance(bodyHex);
  const targetRatio = Math.min(SELECTION_IDEAL_RATIO, achievableRatio);

  const candidateGroundRatio = contrastRatio(candidateHex, groundHex);
  const candidateClearsBodyFloor = contrastRatio(bodyHex, candidateHex) >= TEXT_MIN_RATIO;
  if (candidateClearsBodyFloor && candidateGroundRatio >= targetRatio) {
    return { hex: candidateHex, selectionVsGroundRatio: candidateGroundRatio, wasRepaired: false };
  }

  const targetLuminance = nearestLuminanceReaching(groundLuminance, bodyLuminance, bodyFloorRatio, targetRatio);
  const hex = groundTintedAtLuminance(groundHex, targetLuminance);
  return { hex, selectionVsGroundRatio: contrastRatio(hex, groundHex), wasRepaired: true };
}

/**
 * Throws if `selectionHex` cannot actually be read under `bodyHex` — the one
 * floor resolveSelectionAndBody's whole contract rests on (CHM-30, hardened
 * by CHM-33). Every return path above is expected to already clear this by
 * construction, so tripping it means the resolver's own search has a bug,
 * not that some pack's colours are merely unusual — see CHM-33: three
 * bundled packs shipped for weeks missing exactly this floor, with nothing
 * checking for it at the one function whose entire job is to guarantee it.
 */
function assertClearsBodyFloor(selectionHex: string, bodyHex: string): void {
  const ratio = contrastRatio(bodyHex, selectionHex);
  if (ratio < TEXT_MIN_RATIO) {
    throw new Error(
      `resolveSelectionAndBody produced a selection measuring ${ratio.toFixed(2)} for body-on-selection, below its floor of ${TEXT_MIN_RATIO} — this is a bug in the resolver, not the pack it was given`,
    );
  }
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
 */
export function resolveSelectionAndBody(candidateSelectionHex: string, groundHex: string, bodyHex: string): SelectionResolution {
  const groundLuminance = relativeLuminance(groundHex);
  const bodyLuminance = relativeLuminance(bodyHex);
  const minAcceptableBodyRatio = TEXT_MIN_RATIO * RATIO_CLEARANCE_MARGIN;
  const minAcceptableVisibleRatio = SELECTION_MIN_VISIBLE_RATIO * RATIO_CLEARANCE_MARGIN;

  const achievableRatio = bestGroundRatioAmong(oneSidedPiecesClearingBodyFloor(groundLuminance, bodyLuminance, minAcceptableBodyRatio), groundLuminance);
  if (achievableRatio >= minAcceptableVisibleRatio) {
    const selection = resolveSelectionAgainstBody(candidateSelectionHex, groundHex, bodyHex, minAcceptableBodyRatio, achievableRatio);
    assertClearsBodyFloor(selection.hex, bodyHex);
    return { selection, body: { hex: bodyHex, wasNudged: false } };
  }

  const widenedLuminance = widenedBodyLuminance(groundLuminance, bodyLuminance, minAcceptableBodyRatio, minAcceptableVisibleRatio);
  const nudgedBodyHex = bodyAtLuminance(bodyHex, widenedLuminance);
  const nudgedAchievableRatio = bestGroundRatioAmong(
    oneSidedPiecesClearingBodyFloor(groundLuminance, relativeLuminance(nudgedBodyHex), minAcceptableBodyRatio),
    groundLuminance,
  );
  const selection = resolveSelectionAgainstBody(candidateSelectionHex, groundHex, nudgedBodyHex, minAcceptableBodyRatio, nudgedAchievableRatio);
  assertClearsBodyFloor(selection.hex, nudgedBodyHex);
  return { selection, body: { hex: nudgedBodyHex, wasNudged: true } };
}
