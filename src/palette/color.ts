/**
 * Colour maths with no knowledge of schemes, palettes or targets. Every
 * function here is pure: same input, same output, no I/O.
 */

import { WCAG_CONTRAST_OFFSET } from "../constants.js";

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

interface RgbChannels {
  red: number;
  green: number;
  blue: number;
}

function toRgbChannels(hex: string): RgbChannels {
  if (!HEX_COLOR_PATTERN.test(hex)) {
    throw new Error(`not a 6-digit hex colour: ${hex}`);
  }
  return {
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16),
  };
}

/** WCAG 2.x linearised channel value, in the 0-1 range. */
function linearizeChannel(channel8Bit: number): number {
  const channelFraction = channel8Bit / 255;
  return channelFraction <= 0.03928
    ? channelFraction / 12.92
    : ((channelFraction + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG 2.x relative luminance of a hex colour, from 0 (black) to 1 (white).
 * This is the one number every contrast ratio and appearance check in this
 * project is built from — computed once at parse time because it is
 * expensive, pure, and can never disagree with the hex it came from.
 */
export function relativeLuminance(hex: string): number {
  const { red, green, blue } = toRgbChannels(hex);
  return (
    0.2126 * linearizeChannel(red) +
    0.7152 * linearizeChannel(green) +
    0.0722 * linearizeChannel(blue)
  );
}

/**
 * WCAG 2.x contrast ratio between two colours: 1 (identical luminance) to
 * 21 (black against white). Order does not matter — the formula always
 * divides the lighter relative luminance by the darker one — so this is
 * every floor check and role-assignment ranking in the project built on.
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const luminanceA = relativeLuminance(hexA);
  const luminanceB = relativeLuminance(hexB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + WCAG_CONTRAST_OFFSET) / (darker + WCAG_CONTRAST_OFFSET);
}

/**
 * Euclidean distance between two hex colours in 8-bit RGB space — 0 for
 * identical colours, roughly 441 for black against white. This is a
 * plain-eye "how far apart do these look" measure, never a stand-in for
 * {@link contrastRatio}: it has no notion of luminance or text-on-background
 * legibility, so it is only ever used to rank a fixed set of candidates
 * against each other (e.g. Herdr's own built-in themes — see
 * adapters/herdr.ts), never to gate a contrast decision.
 */
export function rgbDistance(hexA: string, hexB: string): number {
  const channelsA = toRgbChannels(hexA);
  const channelsB = toRgbChannels(hexB);
  return Math.sqrt(
    (channelsA.red - channelsB.red) ** 2 +
      (channelsA.green - channelsB.green) ** 2 +
      (channelsA.blue - channelsB.blue) ** 2,
  );
}

/**
 * How colourful a hex reads, from 0 (grey) to 1 (a fully saturated channel
 * pair at the most colourful lightness for that pair). This is the spread
 * between a colour's lightest and darkest channel — what HSL calls chroma
 * before it gets rescaled into "saturation". HSL saturation stays at 100%
 * as a colour is pushed toward white or black, but chroma collapses to 0,
 * which is what actually makes the colour disappear. Repair holds this
 * fixed rather than HSL saturation — see fromHueChromaMatch and repair.ts.
 */
export function chromaOf(hex: string): number {
  const { red, green, blue } = toRgbChannels(hex);
  return (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function byteToHexPair(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

/**
 * Linear RGB interpolation between two hex colours: fraction 0 returns
 * `hexA`, fraction 1 returns `hexB`. Used to build a neutral tone scale
 * between two colours that are already known-good (e.g. a repaired ground
 * and body) rather than reaching for the hue/chroma repair machinery, which
 * exists to fix a *failing* candidate, not to invent a shade that was never
 * there.
 */
export function mix(hexA: string, hexB: string, fraction: number): string {
  const channelsA = toRgbChannels(hexA);
  const channelsB = toRgbChannels(hexB);
  const mixChannel = (a: number, b: number) => clampByte(a + (b - a) * fraction);
  return `#${byteToHexPair(mixChannel(channelsA.red, channelsB.red))}${byteToHexPair(mixChannel(channelsA.green, channelsB.green))}${byteToHexPair(mixChannel(channelsA.blue, channelsB.blue))}`;
}

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
export function fromHueChromaMatch({ hue, chroma, matchValue }: HueChromaMatch): string {
  const huePrime = hue / 60;
  const secondLargest = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const [red, green, blue] = rgbFractionsForHueSextant(huePrime, chroma, secondLargest);
  return `#${toHexPair(red, matchValue)}${toHexPair(green, matchValue)}${toHexPair(blue, matchValue)}`;
}

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
export function toHsl(hex: string): Hsl {
  const { red, green, blue } = toRgbChannels(hex);
  const redFraction = red / 255;
  const greenFraction = green / 255;
  const blueFraction = blue / 255;
  const max = Math.max(redFraction, greenFraction, blueFraction);
  const min = Math.min(redFraction, greenFraction, blueFraction);
  const lightness = (max + min) / 2;
  const chroma = max - min;

  if (chroma === 0) {
    return { hue: 0, saturation: 0, lightness: lightness * 100 };
  }

  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
  const hueTurns =
    max === redFraction
      ? ((greenFraction - blueFraction) / chroma) % 6
      : max === greenFraction
        ? (blueFraction - redFraction) / chroma + 2
        : (redFraction - greenFraction) / chroma + 4;
  const hue = ((hueTurns * 60) % 360 + 360) % 360;

  return { hue, saturation: saturation * 100, lightness: lightness * 100 };
}

/** Converts HSL back to a hex colour — the inverse of {@link toHsl}. */
export function fromHsl({ hue, saturation, lightness }: Hsl): string {
  const saturationFraction = saturation / 100;
  const lightnessFraction = lightness / 100;
  const chroma = (1 - Math.abs(2 * lightnessFraction - 1)) * saturationFraction;
  const huePrime = hue / 60;
  const secondLargest = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const [red, green, blue] = rgbFractionsForHueSextant(huePrime, chroma, secondLargest);
  const lightnessMatch = lightnessFraction - chroma / 2;

  return `#${toHexPair(red, lightnessMatch)}${toHexPair(green, lightnessMatch)}${toHexPair(blue, lightnessMatch)}`;
}

/** The (red, green, blue) fractions for a hue's 60°-wide sextant, before the lightness offset. */
function rgbFractionsForHueSextant(
  huePrime: number,
  chroma: number,
  secondLargest: number,
): [number, number, number] {
  if (huePrime < 1) return [chroma, secondLargest, 0];
  if (huePrime < 2) return [secondLargest, chroma, 0];
  if (huePrime < 3) return [0, chroma, secondLargest];
  if (huePrime < 4) return [0, secondLargest, chroma];
  if (huePrime < 5) return [secondLargest, 0, chroma];
  return [chroma, 0, secondLargest];
}

function toHexPair(fraction: number, lightnessMatch: number): string {
  const channelByte = Math.round((fraction + lightnessMatch) * 255);
  const clampedByte = Math.min(255, Math.max(0, channelByte));
  return clampedByte.toString(16).padStart(2, "0");
}
