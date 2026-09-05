/**
 * Maps a palette key Chameleon does not own to the role it most resembles,
 * so an adapter can recolour that key from the new theme instead of
 * deleting it. See CHM-31: Oh My Posh's palette table used to be replaced
 * wholesale with Chameleon's own six role names, deleting every key a real
 * prompt's segments referenced.
 */

import {
  GREEN_HUE_MAX_DEGREES,
  GREEN_HUE_MIN_DEGREES,
  RED_HUE_MAX_DEGREES,
  RED_HUE_WRAP_MIN_DEGREES,
  type Role,
} from "../constants.js";
import { toHsl } from "./color.js";

/**
 * Name fragments reliable enough to pick a role without looking at the
 * key's colour at all — an "error" or "success" segment colour almost never
 * means anything else, unlike a bare hue which a theme author could have
 * picked for decoration. Checked before nearestRoleByColor below.
 */
const ERROR_NAME_PATTERN = /error|fail/i;
const SUCCESS_NAME_PATTERN = /success/i;

/**
 * Lightness (HSL percent) above which a colour with little or no hue reads
 * as body text rather than muted — the same rough split assignRolesByContrast
 * draws between a scheme's foreground and its dim secondary slot, applied
 * here to a single standalone colour instead of a whole scheme.
 */
const LOW_SATURATION_BODY_LIGHTNESS_THRESHOLD = 50;

/**
 * The role `hex` most resembles by measured hue, for a colour with no
 * scheme context to compare it against. Reuses the same red/green/cool hue
 * bands roles.ts classifies a scheme's own slots by; a hue that lands in
 * neither band (yellow/orange, and anything with no real saturation) falls
 * back to a lightness split between body and muted, mirroring how repair
 * treats a low-chroma candidate as text rather than an accent.
 */
function nearestRoleByColor(hex: string): Role {
  const { hue, saturation, lightness } = toHsl(hex);
  if (saturation > 0) {
    if (hue < RED_HUE_MAX_DEGREES || hue >= RED_HUE_WRAP_MIN_DEGREES) return "error";
    if (hue >= GREEN_HUE_MIN_DEGREES && hue < GREEN_HUE_MAX_DEGREES) return "success";
    if (hue >= GREEN_HUE_MAX_DEGREES && hue < RED_HUE_WRAP_MIN_DEGREES) return "accent";
  }
  return lightness >= LOW_SATURATION_BODY_LIGHTNESS_THRESHOLD ? "body" : "muted";
}

/**
 * The role a foreign palette key's `name` and current `hex` most resemble —
 * CHM-31's recolour step. A name that reliably announces its own intent
 * wins outright; everything else is classified by the colour actually sitting
 * there today, since that is the only signal left once the name does not say
 * what the key is for.
 */
export function nearestRoleFor(name: string, hex: string): Role {
  if (ERROR_NAME_PATTERN.test(name)) return "error";
  if (SUCCESS_NAME_PATTERN.test(name)) return "success";
  return nearestRoleByColor(hex);
}
