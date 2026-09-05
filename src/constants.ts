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
 */
export const TEXT_MIN_RATIO = 4.5;

/**
 * Minimum contrast muted text must clear against ground. Lower than
 * TEXT_MIN_RATIO because muted text is deliberately de-emphasised — but it
 * must also stay below body's ratio (see repairFailingRoles), or it reads
 * as more prominent than the text it is meant to recede behind.
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
 * Minimum chroma (see chromaOf in palette/color.ts) a repaired selection
 * highlight holds onto, even when ground itself holds less. CHM-38:
 * repairing a selection by searching a hue-free grey satisfies both
 * contrast floors but throws away the theme's own colour identity — 25 of
 * the 26 bundled packs shipped a selection with essentially zero chroma,
 * and Solarized Dark's search landed exactly on pure black. A repaired
 * selection now tints ground's own hue instead (see
 * palette/selection.ts's groundTintedAtLuminance) at a chroma related to
 * ground's own — this floor only bites when ground itself is this neutral
 * or more so, in which case a near-neutral selection is correct, not a bug.
 * Kept low and unrelated to MIN_REPAIRED_CHROMA on purpose: a selection is
 * a background fill sitting behind ordinary body text, not a role that
 * needs to read as strongly coloured, and a value this small still rules
 * out a literal chroma-0 grey.
 */
export const SELECTION_MIN_CHROMA = 0.05;

/**
 * Ceiling on the chroma a repaired selection tints toward, even when ground
 * itself holds more. Reusing ground's own chroma verbatim can pin the tint
 * back onto ground itself: Solarized Dark's ground (chroma 0.212) already
 * sits at the darkest RGB byte its own hue and chroma allow (one channel is
 * 0), so searching "darker than ground" at that same hue and chroma has
 * nowhere to go and returns ground unchanged — a selection identical to its
 * own background, invisible rather than merely grey. A lower ceiling keeps
 * enough of the reachable-luminance range open on both sides of ground for
 * the search in palette/selection.ts's groundTintedAtLuminance to actually
 * move away from it, while staying comfortably above SELECTION_MIN_CHROMA
 * so the ticket's own floor (chroma above 0.05 whenever ground's is) still
 * clears with rounding room to spare.
 */
export const SELECTION_MAX_CHROMA = 0.08;

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
 * the row back toward invisibility to make them fit.
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
