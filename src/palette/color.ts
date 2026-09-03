/**
 * Colour maths with no knowledge of schemes, palettes or targets. Every
 * function here is pure: same input, same output, no I/O.
 */

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
