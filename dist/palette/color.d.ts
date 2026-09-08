/**
 * Colour maths with no knowledge of schemes, palettes or targets. Every
 * function here is pure: same input, same output, no I/O.
 */
/**
 * WCAG 2.x relative luminance of a hex colour, from 0 (black) to 1 (white).
 * This is the one number every contrast ratio and appearance check in this
 * project is built from — computed once at parse time because it is
 * expensive, pure, and can never disagree with the hex it came from.
 */
export declare function relativeLuminance(hex: string): number;
/**
 * WCAG 2.x contrast ratio between two colours: 1 (identical luminance) to
 * 21 (black against white). Order does not matter — the formula always
 * divides the lighter relative luminance by the darker one — so this is
 * every floor check and role-assignment ranking in the project built on.
 */
export declare function contrastRatio(hexA: string, hexB: string): number;
/**
 * Euclidean distance between two hex colours in 8-bit RGB space — 0 for
 * identical colours, roughly 441 for black against white. This is a
 * plain-eye "how far apart do these look" measure, never a stand-in for
 * {@link contrastRatio}: it has no notion of luminance or text-on-background
 * legibility, so it is only ever used to rank a fixed set of candidates
 * against each other (e.g. Herdr's own built-in themes — see
 * adapters/herdr.ts), never to gate a contrast decision.
 */
export declare function rgbDistance(hexA: string, hexB: string): number;
/**
 * How colourful a hex reads, from 0 (grey) to 1 (a fully saturated channel
 * pair at the most colourful lightness for that pair). This is the spread
 * between a colour's lightest and darkest channel — what HSL calls chroma
 * before it gets rescaled into "saturation". HSL saturation stays at 100%
 * as a colour is pushed toward white or black, but chroma collapses to 0,
 * which is what actually makes the colour disappear. Repair holds this
 * fixed rather than HSL saturation — see fromHueChromaMatch and repair.ts.
 */
export declare function chromaOf(hex: string): number;
/**
 * Circular distance, in degrees, between two hues on the 360° colour wheel —
 * 0 for identical hues, at most 180 for two sitting directly opposite each
 * other. Plain subtraction is wrong here because hue wraps: 350° and 10° are
 * 20° apart, not 340°. Shared by palette/role-mapping.ts (finding the
 * destination hue family nearest a foreign key) and palette/selection.ts
 * (checking the selection's hue actually differs from ground's) — same
 * wheel, same wraparound, named once.
 */
export declare function hueDistanceDegrees(hueA: number, hueB: number): number;
/**
 * Linear RGB interpolation between two hex colours: fraction 0 returns
 * `hexA`, fraction 1 returns `hexB`. Used to build a neutral tone scale
 * between two colours that are already known-good (e.g. a repaired ground
 * and body) rather than reaching for the hue/chroma repair machinery, which
 * exists to fix a *failing* candidate, not to invent a shade that was never
 * there.
 */
export declare function mix(hexA: string, hexB: string, fraction: number): string;
/**
 * A colour as hue (degrees, [0, 360)), chroma (see chromaOf, [0, 1]) and
 * matchValue — the offset every channel shares once the hue's chroma-scaled
 * pair is laid down, the same "m" term the CSS Color spec adds when it
 * turns HSL into RGB. Sweeping matchValue over its valid range, [0, 1 -
 * chroma], moves a colour from its darkest expression at this hue and
 * chroma up to its lightest, without ever changing how colourful it is —
 * which is exactly the axis contrast repair needs to search.
 */
export interface HueChromaMatch {
    readonly hue: number;
    readonly chroma: number;
    readonly matchValue: number;
}
/** Converts an {@link HueChromaMatch} to a hex colour. */
export declare function fromHueChromaMatch({ hue, chroma, matchValue }: HueChromaMatch): string;
/**
 * A colour in hue/saturation/lightness form: hue in degrees [0, 360),
 * saturation and lightness as percentages [0, 100]. Used for measuring a
 * candidate's hue (role assignment, and repair's starting point) and for
 * hue-category classification — repair itself searches hue/chroma/
 * matchValue space instead, see {@link HueChromaMatch}.
 */
export interface Hsl {
    readonly hue: number;
    readonly saturation: number;
    readonly lightness: number;
}
/** Converts a hex colour to HSL. */
export declare function toHsl(hex: string): Hsl;
/** Converts HSL back to a hex colour — the inverse of {@link toHsl}. */
export declare function fromHsl({ hue, saturation, lightness }: Hsl): string;
