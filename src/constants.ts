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
 * Minimum chroma (see chromaOf in palette/color.ts) a repaired colour must
 * clear once repair has finished trading hue and saturation for contrast —
 * below this it reads as grey rather than as the role's colour. Set at the
 * ceiling reachable, within repair's bounded hue trade, by the hardest
 * known case: Hot Dog Stand's success candidate against its saturated
 * red-orange ground, which can only buy back this much chroma before
 * a further trade would misread it as the red hue family reserved for
 * error. A role that cannot clear this floor falls back instead of
 * shipping a colour that has been driven to white or black — see
 * repairFailingRoles.
 */
export const MIN_REPAIRED_CHROMA = 0.06;

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
