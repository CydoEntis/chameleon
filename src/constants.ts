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
