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
 * A colour in hue/saturation/lightness form: hue in degrees [0, 360),
 * saturation and lightness as percentages [0, 100]. Repair shifts
 * lightness only, so hue and saturation carry through unchanged — that is
 * what "preserves hue" means in practice.
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
