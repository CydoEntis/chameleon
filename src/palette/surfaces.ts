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

import { ACTIVE_ROW_MIN_VISIBLE_RATIO, ANSI_MIN_RATIO, MUTED_MIN_RATIO, RATIO_CLEARANCE_MARGIN, SELECTION_MIN_VISIBLE_RATIO, TEXT_MIN_RATIO } from "../constants.js";
import { ANSI_SLOT_NAMES } from "./ansi.js";
import { chromaOf, contrastRatio, fromHueChromaMatch, mix, relativeLuminance, toHsl } from "./color.js";
import { matchValueForLuminance, repairForegroundAgainstBackgrounds, targetLuminanceFor } from "./repair.js";
import type { Scheme } from "./scheme.js";

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

// --- CHM-79: the declared contrast inventory --------------------------------
//
// Every fix up to this ticket (CHM-30, CHM-38, CHM-50, CHM-70, CHM-75, CHM-76,
// CHM-78) measured one more (foreground, background) pair Herdr or Windows
// Terminal actually renders, because nothing before this point *enumerated*
// them — a token's legality depends entirely on what it lands on, and the
// only way to stop finding the next unchecked pair by accident is to name
// every pair once, here, and gate all of them together. This is that
// inventory: what each target renders, the floor each pair owes, and the
// generic measurement (checkContrastPairs) that both theme-pack.ts's
// build-time gate (all 29 bundled packs) and `ch doctor` (one live machine)
// run against it — the same pure functions either way, so the two can never
// disagree about what "clears its floor" means.

/**
 * Herdr's overlay0 ramp step — 4/6 of the way from ground to body (see
 * adapters/herdr.ts's surfaceScale). Lives here, not in herdr.ts, for the
 * same reason ACTIVE_ROW_IDEAL_FRACTION does: theme-pack.ts's build-time gate
 * and herdr.ts's live apply must derive overlay0's own pre-repair candidate
 * from the exact same fraction, or the gate could pass a value the live
 * adapter never actually ships.
 */
export const OVERLAY_0_FRACTION = 4 / 6;

/**
 * Herdr's four supplementary badge/label swatches beyond Chameleon's own
 * accent/success/error roles — established by probe, not by reading Herdr's
 * docs (CHM-79's ticket body): blue, teal (cyan), mauve (purple) and yellow
 * are the scheme's own ANSI slots, already repaired against ANSI_MIN_RATIO by
 * repairAnsiSlots (see ansi.ts) by the time they reach here; peach is their
 * own midpoint, since no ANSI slot is orange. Moved here from
 * adapters/herdr.ts so theme-pack.ts's build-time gate and herdr.ts's live
 * apply can never disagree about what these are — the same "one source of
 * truth" ACTIVE_ROW_IDEAL_FRACTION already holds for the selected row.
 * `scheme` is expected to carry already-repaired ANSI slots (see
 * repairAnsiSlots) — this only re-labels them under Herdr's own token names
 * and computes peach, it never repairs anything itself.
 */
export interface HerdrBadgeTokens {
  readonly blue: string;
  readonly teal: string;
  readonly mauve: string;
  readonly yellow: string;
  readonly peach: string;
}

export function resolveHerdrBadgeTokens(scheme: Scheme): HerdrBadgeTokens {
  return {
    blue: scheme.blue,
    teal: scheme.cyan,
    mauve: scheme.purple,
    yellow: scheme.yellow,
    peach: mix(scheme.red, scheme.yellow, 0.5),
  };
}

/**
 * Whether a declared pair carries text a reader must be able to read
 * (TEXT_MIN_RATIO's own territory, or MUTED_MIN_RATIO for the tokens
 * deliberately de-emphasised) or exists only to be told apart from whatever
 * surrounds it — an ANSI slot, a badge swatch, a cursor, a selection
 * highlight. Acceptance criterion: "text pairs are held to TEXT_MIN_RATIO,
 * and any pair exempted from it carries a stated reason" — `kind` plus each
 * builder's own doc comment is that stated reason.
 */
export type ContrastPairKind = "text" | "visibility";

/**
 * One (foreground, background) pair a target actually renders, and the floor
 * it owes that specific background — CHM-79's own inventory unit. `label`
 * names both colours by their real token name, not their role, so a failure
 * reads as "herdr overlay0 on active_row_bg measures 3.10", not "muted
 * measures 3.10" — the exact ambiguity CHM-75 mistook a different token for.
 */
export interface ContrastPair {
  readonly label: string;
  readonly foregroundHex: string;
  readonly backgroundHex: string;
  readonly minRatio: number;
  readonly kind: ContrastPairKind;
}

export interface ContrastFailure {
  readonly pair: ContrastPair;
  readonly ratio: number;
}

/**
 * Measures every declared pair and reports the ones under their own floor.
 * Generic over what built the inventory: a build-time pack's resolved
 * colours, or a live config `chm doctor` just read back off disk, measure
 * exactly the same way.
 */
export function checkContrastPairs(pairs: readonly ContrastPair[]): readonly ContrastFailure[] {
  return pairs
    .map((pair) => ({ pair, ratio: contrastRatio(pair.foregroundHex, pair.backgroundHex) }))
    .filter(({ pair, ratio }) => ratio < pair.minRatio);
}

/** Scheme fields that only ever appear as a background in windowsTerminalContrastPairs, never as a foreground of their own. */
const WINDOWS_TERMINAL_BACKGROUND_ONLY_FIELDS: ReadonlySet<string> = new Set(["background", "selectionBackground"]);

/**
 * Throws, naming the field, when `scheme` carries a slot this inventory does
 * not know to check or exempt — CHM-79's own "adding a token to a target
 * adapter without adding its pairs to the inventory fails the gate rather
 * than passing silently." Scheme's own shape is a fixed Zod schema (see
 * scheme.ts), so this only ever fires if that schema itself grows a new
 * named colour without this file being taught what it renders on.
 */
function assertEverySchemeFieldAccountedFor(scheme: Scheme): void {
  const checkedForegroundFields = new Set<string>([...ANSI_SLOT_NAMES, "foreground", "cursorColor"]);
  for (const field of Object.keys(scheme)) {
    if (field === "name") continue;
    if (!checkedForegroundFields.has(field) && !WINDOWS_TERMINAL_BACKGROUND_ONLY_FIELDS.has(field)) {
      throw new Error(`windows terminal scheme field "${field}" has no declared contrast pair — add it to palette/surfaces.ts's windowsTerminalContrastPairs`);
    }
  }
}

/**
 * Every (foreground, background) pair Windows Terminal actually renders, for
 * `scheme` — CHM-79's own declared inventory for this target: the 16 ANSI
 * slots and the cursor on background, foreground on background, and
 * foreground on the selection highlight.
 *
 * The 16 ANSI slots and cursorColor are visibility pairs, not text: an
 * application picks one ANSI colour at a time and must be able to tell it
 * from the background it sits on, never held to body text's own legibility
 * guarantee (ANSI_MIN_RATIO — see ansi.ts's own doc comment, which this
 * reuses for the cursor too, the same "distinguishable, not legible" pair).
 * `scheme` is expected to be the fully resolved payload — ANSI slots and the
 * cursor already repaired (see ansi.ts), foreground already the resolved
 * body, selectionBackground already the resolved selection — the same object
 * theme-pack.ts ships and windows-terminal.ts applies; this only measures,
 * it never repairs.
 */
export function windowsTerminalContrastPairs(scheme: Scheme): ContrastPair[] {
  assertEverySchemeFieldAccountedFor(scheme);

  const ansiPairs: ContrastPair[] = ANSI_SLOT_NAMES.map((slotName) => ({
    label: `windows-terminal ${slotName} on background`,
    foregroundHex: scheme[slotName],
    backgroundHex: scheme.background,
    minRatio: ANSI_MIN_RATIO,
    kind: "visibility",
  }));

  return [
    ...ansiPairs,
    { label: "windows-terminal cursorColor on background", foregroundHex: scheme.cursorColor, backgroundHex: scheme.background, minRatio: ANSI_MIN_RATIO, kind: "visibility" },
    { label: "windows-terminal foreground on background", foregroundHex: scheme.foreground, backgroundHex: scheme.background, minRatio: TEXT_MIN_RATIO, kind: "text" },
    { label: "windows-terminal foreground on selectionBackground", foregroundHex: scheme.foreground, backgroundHex: scheme.selectionBackground, minRatio: TEXT_MIN_RATIO, kind: "text" },
  ];
}

/**
 * Every token Herdr's own [theme.custom] table carries, keyed by its real
 * Herdr name — established by reading Herdr's published config reference and
 * probing the live UI with distinct colours per token (CHM-79's own ticket
 * body). The four ramp steps that carry no text at all (surface_dim,
 * surface0, surface1, overlay1 — see HERDR_TOKENS_CARRYING_NO_TEXT) are
 * optional here: theme-pack.ts's build-time gate never computes them, since
 * no pair below ever reads them.
 */
export interface HerdrTokenSet {
  readonly sidebar_bg: string;
  readonly panel_bg: string;
  readonly active_row_bg: string;
  readonly selection_bg: string;
  readonly text: string;
  readonly subtext0: string;
  readonly overlay0: string;
  readonly accent: string;
  readonly green: string;
  readonly red: string;
  readonly yellow: string;
  readonly blue: string;
  readonly teal: string;
  readonly mauve: string;
  readonly peach: string;
  readonly surface_dim?: string;
  readonly surface0?: string;
  readonly surface1?: string;
  readonly overlay1?: string;
}

/**
 * Herdr tokens that paint no text at all, and so owe no pair below: the
 * separator rule (surface_dim) and three ramp steps that appeared nowhere in
 * the sidebar under CHM-78's own probe (surface0, surface1, overlay1) — see
 * adapters/herdr.ts's surfaceScale. Named explicitly, not just left off the
 * lists below, so assertHerdrTokensAccountedFor can tell "never checked
 * because it carries no text" apart from "forgotten".
 */
const HERDR_TOKENS_CARRYING_NO_TEXT: ReadonlySet<string> = new Set(["surface_dim", "surface0", "surface1", "overlay1"]);

/** Herdr tokens that only ever appear as a background below, never as a foreground of their own. */
const HERDR_BACKGROUND_ONLY_TOKENS: ReadonlySet<string> = new Set(["sidebar_bg", "panel_bg", "active_row_bg"]);

/** The tokens every pair below actually reads — HerdrTokenSet's own required fields, as distinct from the four optional ramp steps that carry no pair at all (see HERDR_TOKENS_CARRYING_NO_TEXT). Named so `tokens[key]` below is known to be a plain `string`, never `string | undefined`. */
type RequiredHerdrToken = Exclude<keyof HerdrTokenSet, "surface_dim" | "surface0" | "surface1" | "overlay1">;

/** The three sidebar surfaces text, subtext0 and overlay0 each render on top of — established by reading Herdr's config reference and probing the live UI (CHM-79's own ticket body): "text, subtext0 and overlay0 each on sidebar_bg, panel_bg and active_row_bg". */
const HERDR_TEXT_BEARING_SURFACES: readonly RequiredHerdrToken[] = ["sidebar_bg", "panel_bg", "active_row_bg"];

/** Herdr's own accent family — Chameleon's three text roles plus its four supplementary badge swatches — checked against both backgrounds a badge or label ever renders on: "accent, green, red, yellow, blue, teal, mauve and peach on sidebar_bg and panel_bg". */
const HERDR_ACCENT_FOREGROUNDS: readonly RequiredHerdrToken[] = ["accent", "green", "red", "yellow", "blue", "teal", "mauve", "peach"];
const HERDR_ACCENT_BACKGROUNDS: readonly RequiredHerdrToken[] = ["sidebar_bg", "panel_bg"];

/**
 * The four of HERDR_ACCENT_FOREGROUNDS that are supplementary badge/label
 * swatches, never body text — accent, green and red are Chameleon's own
 * roles and stay held to TEXT_MIN_RATIO; these four are exempted from it
 * down to ANSI_MIN_RATIO instead (see resolveHerdrBadgeTokens's own doc
 * comment for why: they are the scheme's own repaired ANSI slots, or a
 * midpoint of two of them, and Herdr paints them as labels and badges, not
 * running text). This is the acceptance criterion's own "stated reason" for
 * the one exemption this inventory makes.
 */
const HERDR_BADGE_TOKENS: ReadonlySet<RequiredHerdrToken> = new Set(["yellow", "blue", "teal", "mauve", "peach"]);

/**
 * Throws, naming the token, when `tokens` carries a key this inventory does
 * not know to check or exempt — CHM-79's own "adding a token to a target
 * adapter without adding its pairs to the inventory fails the gate rather
 * than passing silently." A key present in `tokens` but absent from every
 * list below — the checked foregrounds, the background-only tokens, or the
 * ones declared to carry no text — is exactly that: a token someone taught
 * adapters/herdr.ts to write without ever teaching this file what it paints.
 */
function assertHerdrTokensAccountedFor(tokens: HerdrTokenSet): void {
  const checkedForegroundTokens = new Set<string>(["text", "subtext0", "overlay0", ...HERDR_ACCENT_FOREGROUNDS, "selection_bg"]);
  for (const token of Object.keys(tokens)) {
    const isAccountedFor =
      checkedForegroundTokens.has(token) || HERDR_TOKENS_CARRYING_NO_TEXT.has(token) || HERDR_BACKGROUND_ONLY_TOKENS.has(token);
    if (!isAccountedFor) {
      throw new Error(`herdr token "${token}" has no declared contrast pair and is not exempted — add it to palette/surfaces.ts's herdrContrastPairs`);
    }
  }
}

/**
 * Every (foreground, background) pair Herdr actually renders, for one
 * resolved token set — CHM-79's own declared inventory for this target,
 * established by reading Herdr's published config reference and probing the
 * live UI with distinct colours per token (see this ticket's own body):
 *
 * - text, subtext0 and overlay0 each on sidebar_bg, panel_bg and
 *   active_row_bg — subtext0 to MUTED_MIN_RATIO (CHM-50's own de-emphasised
 *   floor), text and overlay0 to TEXT_MIN_RATIO (CHM-78: overlay0 paints
 *   section headers and every agent row's own subtitle line, read text, not
 *   a ramp step).
 * - accent, green, red, yellow, blue, teal, mauve and peach on sidebar_bg
 *   and panel_bg — the three Chameleon roles at TEXT_MIN_RATIO, the four
 *   supplementary badge swatches exempted to ANSI_MIN_RATIO (see
 *   HERDR_BADGE_TOKENS's own doc comment).
 * - text on selection_bg, at TEXT_MIN_RATIO.
 * - selection_bg itself against sidebar_bg, a highlight-visibility pair at
 *   SELECTION_MIN_VISIBLE_RATIO — so a selection can never render as the
 *   same tone as the sidebar it sits on.
 *
 * surface_dim, surface0, surface1 and overlay1 carry no pair at all — see
 * HERDR_TOKENS_CARRYING_NO_TEXT.
 */
export function herdrContrastPairs(tokens: HerdrTokenSet): ContrastPair[] {
  assertHerdrTokensAccountedFor(tokens);

  const textBearingPairs: ContrastPair[] = (["text", "subtext0", "overlay0"] as const).flatMap((foregroundToken) =>
    HERDR_TEXT_BEARING_SURFACES.map((backgroundToken) => ({
      label: `herdr ${foregroundToken} on ${backgroundToken}`,
      foregroundHex: tokens[foregroundToken],
      backgroundHex: tokens[backgroundToken],
      minRatio: foregroundToken === "subtext0" ? MUTED_MIN_RATIO : TEXT_MIN_RATIO,
      kind: "text" as const,
    })),
  );

  const accentPairs: ContrastPair[] = HERDR_ACCENT_FOREGROUNDS.flatMap((foregroundToken) =>
    HERDR_ACCENT_BACKGROUNDS.map((backgroundToken) => {
      const isBadgeToken = HERDR_BADGE_TOKENS.has(foregroundToken);
      return {
        label: `herdr ${foregroundToken} on ${backgroundToken}`,
        foregroundHex: tokens[foregroundToken],
        backgroundHex: tokens[backgroundToken],
        minRatio: isBadgeToken ? ANSI_MIN_RATIO : TEXT_MIN_RATIO,
        kind: isBadgeToken ? ("visibility" as const) : ("text" as const),
      };
    }),
  );

  return [
    ...textBearingPairs,
    ...accentPairs,
    { label: "herdr text on selection_bg", foregroundHex: tokens.text, backgroundHex: tokens.selection_bg, minRatio: TEXT_MIN_RATIO, kind: "text" },
    {
      label: "herdr selection_bg on sidebar_bg",
      foregroundHex: tokens.selection_bg,
      backgroundHex: tokens.sidebar_bg,
      minRatio: SELECTION_MIN_VISIBLE_RATIO,
      kind: "visibility",
    },
  ];
}
