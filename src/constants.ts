/**
 * Values shared across the pure palette pipeline that would otherwise be
 * duplicated as raw literals. See code-standards.md, "No magic strings, no
 * magic numbers".
 */

/**
 * A background at or above this relative luminance reads as a light
 * appearance; below it, dark. 0.5 sits mid-way on the WCAG relative
 * luminance scale (0 is black, 1 is white) and is the threshold every
 * vendored scheme's background falls cleanly on one side of.
 */
export const APPEARANCE_LUMINANCE_THRESHOLD = 0.5;

/**
 * The offset in the WCAG contrast-ratio formula: (lighter + K) / (darker +
 * K). It keeps the ratio finite when either colour is pure black (relative
 * luminance 0) and is fixed by the WCAG 2.x spec, not a tuning knob.
 */
export const WCAG_CONTRAST_OFFSET = 0.05;

/**
 * Chameleon's six roles, resolved from a scheme's slots by measured
 * contrast rather than by trusting a slot's name. See the three-word model
 * in CLAUDE.md: a "palette" is these roles, not the raw scheme slots.
 */
export const ROLES = ["ground", "body", "accent", "muted", "success", "error"] as const;

export type Role = (typeof ROLES)[number];

/** Whether `candidateRole` is one of Chameleon's six roles — the boundary check every role a user or a config supplies must clear before it is trusted, so a typo or a made-up name is rejected by name rather than silently accepted. */
export function isKnownRole(candidateRole: string): candidateRole is Role {
  return ROLES.some((role) => role === candidateRole);
}

/**
 * Minimum contrast, against ground, that body text and the accent colour
 * must clear to be legible. Reused for success and error, which are also
 * rendered as text. WCAG 2.x AA for normal-size text.
 *
 * Also the target muted reaches for — not against ground, but against
 * Herdr's selected row — once CHM-75 established that a de-emphasised
 * colour is the thing being read there, not skimmed past. See
 * palette/surfaces.ts's resolveActiveRowAndText.
 */
export const TEXT_MIN_RATIO = 4.5;

/**
 * Minimum contrast muted text must clear against ground. Lower than
 * TEXT_MIN_RATIO because muted text is deliberately de-emphasised — but it
 * must also stay below body's ratio (see repairFailingRoles), or it reads
 * as more prominent than the text it is meant to recede behind.
 *
 * This is still the floor muted owes every surface it renders on — Herdr's
 * selected row included, never regressed below it — even where CHM-75 asks
 * for more (see TEXT_MIN_RATIO's own doc comment above).
 */
export const MUTED_MIN_RATIO = 3.0;

/**
 * The selection highlight's own ideal contrast against ground — the most
 * visible a highlight needs to be. Repair reaches for this but never
 * demands it: body-on-selection (TEXT_MIN_RATIO) is the one floor that is
 * never traded away, and for 10 of the 26 bundled packs no colour clears
 * both at once (tokyo-night-light's body clears ground by only 4.52 — see
 * palette/selection.ts). Selection-vs-ground is maximised up to this value,
 * never demanded to reach it.
 */
export const SELECTION_IDEAL_RATIO = 2.0;

/**
 * The lowest selection-vs-ground contrast that still counts as a visible
 * highlight at all. Below this, resolveSelection stops trying to move the
 * selection colour itself and nudges body further from ground instead —
 * see palette/selection.ts's resolveSelectionAndBody.
 */
export const SELECTION_MIN_VISIBLE_RATIO = 1.25;

/**
 * Ratio a repair targets past its floor, so integer-RGB rounding on the
 * repaired hex never lands it back under the floor. Shared by repair.ts
 * (the six roles) and palette/selection.ts (the selection highlight and its
 * rare body nudge) — same rounding-safety margin, same reason, named once.
 */
export const RATIO_CLEARANCE_MARGIN = 1.05;

/**
 * CHM-38's old floor on a repaired selection's chroma, and the ceiling it
 * was clamped to below (SELECTION_MAX_CHROMA) — both retained only as the
 * regression baseline CHM-70's tests assert a repaired selection now clears
 * by a wide margin, never as a target either constant is searched toward
 * any more.
 *
 * CHM-38 fixed a hue-free grey search (contrast floors satisfied, colour
 * identity thrown away — 25 of the 26 bundled packs shipped a selection
 * with essentially zero chroma, Solarized Dark's landing on pure black) by
 * tinting ground's own hue at a chroma clamped to this narrow band. That
 * was progress over grey, but ground's hue at a chroma this low is, by
 * construction, still a slightly different shade of the background — CHM-70
 * is the report that a selection built this way still reads as "a lighter
 * grey", not a distinct colour. CHM-70 replaces the clamp outright: hue now
 * comes from the pack's own accent (see palette/selection.ts's
 * chooseSelectionHue), and chroma is maximised at whatever luminance the
 * contrast floors demand (see maxChromaAtLuminance) rather than held down
 * near this ceiling.
 */
export const SELECTION_MIN_CHROMA = 0.05;
export const SELECTION_MAX_CHROMA = 0.08;

/**
 * The lowest chroma a *resolved* selection is allowed to ship at, whether or
 * not a repair fired to get there (CHM-76). CHM-70's tint only ran on the
 * repair branch: resolveSelectionAndBody's early return handed back an
 * authored selectionBackground untouched the moment it cleared its two
 * contrast floors, never checking what it looked like. Contrast floors are a
 * function of luminance alone, so a candidate can clear both while carrying
 * almost no colour at all — monokai-dark's authored selection measures 2.06
 * against ground (clears SELECTION_MIN_VISIBLE_RATIO) and 7.12 against body
 * (clears TEXT_MIN_RATIO) yet its chroma is 0.035, grey-on-grey to the eye;
 * gruvbox-dark's is 0.071, the same failure.
 *
 * Set above both of those, but below ayu-light's own 0.165 — the tightest
 * ceiling maxChromaClearingFloors finds on any of the 29 bundled packs'
 * repair path, where the ground/body pair leaves little room to move at all
 * (ayu-light's own selection-vs-ground caps at 1.29, short of
 * SELECTION_IDEAL_RATIO). A floor above that would be unreachable for a pack
 * already spending its whole budget on the two contrast floors, which this
 * ticket does not touch. Below jellybeans's own native 0.290, too, so a pack
 * whose authored candidate already carries ample chroma is kept rather than
 * retinted for no reason (CHM-76 is a floor on invisible highlights, not a
 * mandate to retint every pack). A candidate below this is retinted toward
 * the pack's own accent hue exactly like a contrast repair (see
 * palette/selection.ts's chooseSelectionHue) rather than shipped as
 * whatever chroma the upstream theme happened to author.
 */
export const SELECTION_MIN_RESOLVED_CHROMA = 0.15;

/**
 * The lowest hue distance, in degrees, from ground's own hue that still
 * reads as a genuinely different colour rather than a tinted shade of the
 * background — the bar CHM-70's selection hue must clear. Reuses
 * RED_HUE_MAX_DEGREES's own boundary rather than inventing a second one: a
 * hue within 20° of another already falls in the same hue-category bucket
 * roles.ts classifies slots into, so a selection that close to ground would
 * be that same "barely a different shade" complaint CHM-70 reports, just at
 * a hue level instead of a luminance one.
 *
 * Checked against the 29 bundled packs' own measured accent-to-ground
 * distances: catppuccin-light's accent sits 0.1° from ground (fallback
 * fires), one-half-dark's 13.0°, night-owl-dark's 14.0° and solarized-dark's
 * 16.8° all read as the same hue as their ground in practice (fallback
 * fires for all four); the next-nearest pack, kanagawa-dark, clears this
 * floor exactly at 20.0°, and every pack above it is unambiguously a
 * different colour from its own ground.
 */
export const SELECTION_HUE_MIN_DISTANCE_DEGREES = 20;

/**
 * The lowest active-row-background-vs-sidebar-background contrast that
 * still reads as a distinct, selected row rather than an ordinary one.
 * CHM-50: a prior fix chased subtext0's readability by moving
 * active_row_bg almost onto sidebar_bg, and 17 of the 26 bundled packs
 * measured under 1.15 for the pair — dracula-dark at 1.00, the same colour,
 * so the "selected" row was not visibly selected at all. This floor is
 * resolved first and never traded away for readability; see
 * palette/surfaces.ts's resolveActiveRowAndText, which repairs the text
 * tokens themselves against whatever this settles on, rather than pulling
 * the row back toward invisibility to make them fit. CHM-75 adds a second
 * move in the other direction — the row's own fraction can fall back toward
 * ground, never below this same floor, so muted reads against it without
 * needing to move further from ground itself.
 */
export const ACTIVE_ROW_MIN_VISIBLE_RATIO = 2.0;

/**
 * Minimum chroma (see chromaOf in palette/color.ts) a repaired colour must
 * clear before it still counts as its role's colour rather than a tinted
 * grey. Set below Fairyfloss's error candidate's own native chroma (0.24,
 * a real vendored value) so a candidate that started this restrained is
 * not punished for it, and well above the floor an earlier, rejected
 * repair design settled for (0.06 — a target so low it let Acid Lime,
 * Thayer Bright and Fairyfloss all repair to within a hair of white
 * anyway). A role that cannot clear both this and its contrast floor at
 * once falls back to a computed grey instead of shipping a barely-tinted
 * near-white or near-black — see repairFailingRoles.
 */
export const MIN_REPAIRED_CHROMA = 0.2;

/**
 * Minimum contrast an ANSI slot must clear against its own background.
 * Lower than TEXT_MIN_RATIO because a slot's job is only to be
 * distinguishable from the background it is drawn on, not to carry body
 * text's own legibility guarantee — but 22 of the 26 bundled packs ship at
 * least one ANSI slot below even this, four of them with black
 * byte-identical to the background (contrast 1.00). See palette/ansi.ts.
 */
export const ANSI_MIN_RATIO = 2.0;

/**
 * Hue boundaries, in degrees, used to classify an ANSI slot's *measured*
 * hue rather than trust its name — Rosé Pine Dawn's `green` slot holds a
 * blue (hue ~197°) and its `cyan` slot holds a pink (hue ~3°). A slot's
 * hue falling below RED_HUE_MAX_DEGREES or at/above RED_HUE_WRAP_MIN_DEGREES
 * reads as red; between GREEN_HUE_MIN_DEGREES and GREEN_HUE_MAX_DEGREES it
 * reads as green; the remainder, up to the red wrap, reads as the cool
 * (blue/cyan/purple) family accent is drawn from.
 */
export const RED_HUE_MAX_DEGREES = 20;
export const RED_HUE_WRAP_MIN_DEGREES = 345;
export const GREEN_HUE_MIN_DEGREES = 60;
export const GREEN_HUE_MAX_DEGREES = 170;
