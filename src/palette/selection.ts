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

import { RATIO_CLEARANCE_MARGIN, SELECTION_HUE_MIN_DISTANCE_DEGREES, SELECTION_IDEAL_RATIO, SELECTION_MIN_RESOLVED_CHROMA, SELECTION_MIN_VISIBLE_RATIO, TEXT_MIN_RATIO, WCAG_CONTRAST_OFFSET } from "../constants.js";
import { chromaOf, contrastRatio, fromHueChromaMatch, hueDistanceDegrees, relativeLuminance, toHsl } from "./color.js";
import { matchValueForLuminance } from "./repair.js";

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

/** Which hue a repaired selection tints toward, and whether reaching it needed the fallback — see chooseSelectionHue. */
interface SelectionHueChoice {
  readonly hue: number;
  readonly usedFallbackHue: boolean;
}

/**
 * The hue a repaired selection tints toward: the pack's own accent, unless
 * accent's hue sits within SELECTION_HUE_MIN_DISTANCE_DEGREES of ground's
 * own — indistinguishable from it in practice, the "still basically grey"
 * failure this ticket reports — in which case this falls back to whichever
 * of `otherChromaticHexes` (success, error) reads as farthest from ground
 * instead of collapsing to grey. CHM-38 tinted ground's own hue at a
 * near-zero chroma, which is by construction a slightly different shade of
 * the background rather than a different colour — see this file's own doc
 * comment for the worked nord-dark example.
 */
function chooseSelectionHue(groundHex: string, accentHex: string, otherChromaticHexes: readonly string[]): SelectionHueChoice {
  const groundHue = toHsl(groundHex).hue;
  const accentHue = toHsl(accentHex).hue;
  if (hueDistanceDegrees(accentHue, groundHue) >= SELECTION_HUE_MIN_DISTANCE_DEGREES) {
    return { hue: accentHue, usedFallbackHue: false };
  }

  const fallbackHue = otherChromaticHexes.map((hex) => toHsl(hex).hue).reduce((mostDistant, candidateHue) =>
    hueDistanceDegrees(candidateHue, groundHue) > hueDistanceDegrees(mostDistant, groundHue) ? candidateHue : mostDistant,
  );
  return { hue: fallbackHue, usedFallbackHue: true };
}

/**
 * How finely maxChromaClearingFloors scans chroma. Coarser than the
 * 40-iteration bisections elsewhere in this file on purpose — see its own
 * doc comment for why this scans a prefix instead of bisecting — but still
 * far finer than an 8-bit channel can tell apart (a step is worth roughly
 * 1/500th of a channel's full range).
 */
const CHROMA_SEARCH_STEPS = 200;

/**
 * The colour at `hue` and `chroma` landing closest to `targetLuminance`:
 * exactly on it when `chroma` leaves it reachable, or the nearest edge of
 * what this hue/chroma pair can reach otherwise (see
 * matchValueForLuminance) — the same clamp-to-nearest behaviour every other
 * luminance search in this file already relies on.
 */
function hueTintedTowardLuminance(hue: number, chroma: number, targetLuminance: number): string {
  const matchValue = matchValueForLuminance(hue, chroma, targetLuminance);
  return fromHueChromaMatch({ hue, chroma, matchValue });
}

/**
 * Whether `candidateLuminance` sits on the same side of `groundLuminance`
 * that `targetLuminance` does (or exactly on ground) — the guard
 * maxChromaClearingFloors uses to rule out a chroma that "clears" ground
 * visibility only by overshooting past ground on the far side, in the
 * opposite direction from the one the luminance search (nearestLuminanceReaching
 * et al.) actually chose.
 */
function isOnTargetSideOfGround(candidateLuminance: number, targetLuminance: number, groundLuminance: number): boolean {
  return (candidateLuminance - groundLuminance) * (targetLuminance - groundLuminance) >= 0;
}

/**
 * The largest chroma, at `hue`, whose tint toward `targetLuminance` (see
 * hueTintedTowardLuminance) still clears `bodyFloorRatio` against `bodyHex`
 * and `minGroundRatio` against `groundHex`, without overshooting past ground
 * onto its far side — CHM-70's replacement for CHM-38's fixed low ceiling
 * (SELECTION_MAX_CHROMA), maximising chroma at whatever the two floors
 * actually leave room for instead of holding it to an arbitrary narrow band.
 *
 * Scans the full range rather than bisecting or stopping at the first
 * failure: whether a chroma clears both floors is *not* strictly
 * downward-closed. nord-dark is the fixture this matters for — its target
 * luminance sits exactly on the body floor's own boundary (any grey there
 * measures precisely the margined floor, 4.7268 against a 4.725 minimum),
 * so 8-bit channel rounding on a *chromatic* tint at that same luminance can
 * land a hair either side of it non-monotonically as chroma grows
 * (4.7215 at chroma 0.005, back up to 4.762 at chroma 0.02) — a search that
 * stopped at the first dip would settle for chroma 0 and ship exactly the
 * "still basically grey" result this ticket reports. The far-side guard
 * above (isOnTargetSideOfGround) is what keeps scanning the *whole* range
 * safe: without it, a chroma large enough to clamp targetLuminance onto
 * ground's far side could look like it clears ground-visibility from over
 * there while having long since failed the far stricter body floor —
 * Solarized Dark's own targetLuminance of 0 is the fixture proving that
 * side exists at all.
 */
function maxChromaClearingFloors(
  hue: number,
  targetLuminance: number,
  groundHex: string,
  bodyHex: string,
  bodyFloorRatio: number,
  minGroundRatio: number,
): number {
  const groundLuminance = relativeLuminance(groundHex);
  let bestChroma = 0;
  for (let step = 1; step <= CHROMA_SEARCH_STEPS; step += 1) {
    const candidateChroma = step / CHROMA_SEARCH_STEPS;
    const candidateHex = hueTintedTowardLuminance(hue, candidateChroma, targetLuminance);
    const staysOnTargetSide = isOnTargetSideOfGround(relativeLuminance(candidateHex), targetLuminance, groundLuminance);
    const clearsBodyFloor = contrastRatio(bodyHex, candidateHex) >= bodyFloorRatio;
    const clearsGroundVisibility = contrastRatio(candidateHex, groundHex) >= minGroundRatio;
    if (staysOnTargetSide && clearsBodyFloor && clearsGroundVisibility) {
      bestChroma = candidateChroma;
    }
  }
  return bestChroma;
}

/**
 * `hue`, tinted toward `targetLuminance` at the most chroma the two floors
 * leave room for (see maxChromaClearingFloors) — CHM-70's replacement for
 * groundTintedAtLuminance, which held chroma to a narrow, mostly-arbitrary
 * band regardless of what the target luminance could actually support.
 * Chroma 0 (used whenever nothing more is safe) reproduces exactly the
 * grey CHM-30/CHM-50 already proved clears both floors for every bundled
 * pack, so this can never do worse than the pre-CHM-70 behaviour.
 */
function hueTintedAtLuminance(
  hue: number,
  targetLuminance: number,
  groundHex: string,
  bodyHex: string,
  bodyFloorRatio: number,
  minGroundRatio: number,
): string {
  const chroma = maxChromaClearingFloors(hue, targetLuminance, groundHex, bodyHex, bodyFloorRatio, minGroundRatio);
  return hueTintedTowardLuminance(hue, chroma, targetLuminance);
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
  accentHex: string,
  otherChromaticHexes: readonly string[],
  bodyFloorRatio: number,
  achievableRatio: number,
): ResolvedSelection {
  const groundLuminance = relativeLuminance(groundHex);
  const bodyLuminance = relativeLuminance(bodyHex);
  const targetRatio = Math.min(SELECTION_IDEAL_RATIO, achievableRatio);

  const candidateGroundRatio = contrastRatio(candidateHex, groundHex);
  const candidateClearsBodyFloor = contrastRatio(bodyHex, candidateHex) >= TEXT_MIN_RATIO;
  // CHM-76: a candidate clearing both contrast floors can still be
  // grey-on-grey — contrast is a function of luminance alone and has no
  // notion of colour. monokai-dark's authored selection clears both floors
  // (2.06 vs ground, 7.12 vs body) at a chroma of 0.035, indistinguishable
  // from the background it sits on. Checked here, not folded into the
  // floors above, because it gates the same early return rather than
  // widening what counts as "clearing" a contrast ratio.
  const candidateClearsChromaFloor = chromaOf(candidateHex) >= SELECTION_MIN_RESOLVED_CHROMA;
  if (candidateClearsBodyFloor && candidateGroundRatio >= targetRatio && candidateClearsChromaFloor) {
    return { hex: candidateHex, selectionVsGroundRatio: candidateGroundRatio, wasRepaired: false, usedFallbackHue: false };
  }

  const targetLuminance = nearestLuminanceReaching(groundLuminance, bodyLuminance, bodyFloorRatio, targetRatio);
  const { hue, usedFallbackHue } = chooseSelectionHue(groundHex, accentHex, otherChromaticHexes);
  // The bare visibility floor, not the margined targetRatio above: even the
  // pre-CHM-70 grey search only ever promised *this* much after 8-bit
  // rounding on the final hex (tokyo-night-light's own shipped grey ships at
  // 1.30, already under the margined 1.3125) — see maxChromaClearingFloors'
  // own doc comment. Demanding the margined value here would reject chroma
  // the surrounding code has always accepted, for no floor this ticket
  // actually needs to hold.
  const hex = hueTintedAtLuminance(hue, targetLuminance, groundHex, bodyHex, bodyFloorRatio, SELECTION_MIN_VISIBLE_RATIO);
  return { hex, selectionVsGroundRatio: contrastRatio(hex, groundHex), wasRepaired: true, usedFallbackHue };
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
 *
 * `accentHex` and `otherChromaticHexes` (success, error) are only consulted
 * when a repair actually fires — see chooseSelectionHue — never when the
 * scheme's own authored `candidateSelectionHex` already clears both floors
 * on its own.
 */
export function resolveSelectionAndBody(
  candidateSelectionHex: string,
  groundHex: string,
  bodyHex: string,
  accentHex: string,
  otherChromaticHexes: readonly string[],
): SelectionResolution {
  const groundLuminance = relativeLuminance(groundHex);
  const bodyLuminance = relativeLuminance(bodyHex);
  const minAcceptableBodyRatio = TEXT_MIN_RATIO * RATIO_CLEARANCE_MARGIN;
  const minAcceptableVisibleRatio = SELECTION_MIN_VISIBLE_RATIO * RATIO_CLEARANCE_MARGIN;

  const achievableRatio = bestGroundRatioAmong(oneSidedPiecesClearingBodyFloor(groundLuminance, bodyLuminance, minAcceptableBodyRatio), groundLuminance);
  if (achievableRatio >= minAcceptableVisibleRatio) {
    const selection = resolveSelectionAgainstBody(candidateSelectionHex, groundHex, bodyHex, accentHex, otherChromaticHexes, minAcceptableBodyRatio, achievableRatio);
    assertClearsBodyFloor(selection.hex, bodyHex);
    return { selection, body: { hex: bodyHex, wasNudged: false } };
  }

  const widenedLuminance = widenedBodyLuminance(groundLuminance, bodyLuminance, minAcceptableBodyRatio, minAcceptableVisibleRatio);
  const nudgedBodyHex = bodyAtLuminance(bodyHex, widenedLuminance);
  const nudgedAchievableRatio = bestGroundRatioAmong(
    oneSidedPiecesClearingBodyFloor(groundLuminance, relativeLuminance(nudgedBodyHex), minAcceptableBodyRatio),
    groundLuminance,
  );
  const selection = resolveSelectionAgainstBody(
    candidateSelectionHex,
    groundHex,
    nudgedBodyHex,
    accentHex,
    otherChromaticHexes,
    minAcceptableBodyRatio,
    nudgedAchievableRatio,
  );
  assertClearsBodyFloor(selection.hex, nudgedBodyHex);
  return { selection, body: { hex: nudgedBodyHex, wasNudged: true } };
}
