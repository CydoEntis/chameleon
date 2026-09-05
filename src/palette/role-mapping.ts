/**
 * Recolours a palette key Chameleon does not own into the new theme's own
 * colour space, so an adapter can retint that key instead of deleting it or
 * flattening it. See CHM-31: Oh My Posh's palette table used to be replaced
 * wholesale with Chameleon's own six role names, deleting every key a real
 * prompt's segments referenced. See CHM-37: the fix for that, mapping every
 * key onto one of six roles, was still wrong — 46 of a real 47-key prompt
 * palette landed on the same three or four role colours, so the prompt
 * still rendered as flat, illegible blobs. What a palette's keys are for is
 * the relationships between them, not merely their surviving as keys.
 */

import type { Role } from "../constants.js";
import { chromaOf, fromHueChromaMatch, relativeLuminance, toHsl } from "./color.js";
import { matchValueForLuminance, poleWithMoreHeadroom } from "./repair.js";

/**
 * Name fragments reliable enough to pick a role without looking at the
 * key's colour at all — an "error" or "success" segment colour almost never
 * means anything else, unlike a bare hue a theme author could have picked
 * for decoration. Checked before retintByLuminance below.
 */
const ERROR_NAME_PATTERN = /error|fail/i;
const SUCCESS_NAME_PATTERN = /success/i;

/**
 * The role `name` announces outright, or undefined when it carries no such
 * signal — the common case, recoloured by retintByLuminance instead.
 */
function roleImpliedByName(name: string): Extract<Role, "error" | "success"> | undefined {
  if (ERROR_NAME_PATTERN.test(name)) return "error";
  if (SUCCESS_NAME_PATTERN.test(name)) return "success";
  return undefined;
}

/**
 * Recolours `hex` by carrying its own hue and chroma through unchanged and
 * moving only its WCAG relative luminance, from wherever it sat between
 * black (0) and white (1), to the same relative point between `groundHex`
 * and whichever of pure black or pure white sits farthest from it —
 * poleWithMoreHeadroom, the same "which extreme has more room" question
 * repair.ts asks when a role needs to move away from ground. A key that
 * started near-black lands near the new theme's own dark pole, and one
 * that started near-white lands near its light pole, whatever the new
 * theme's own appearance turns out to be.
 *
 * The far pole is the true extreme (luminance 0 or 1), not one of
 * Chameleon's own repaired roles such as body: two roles are each only
 * guaranteed to individually clear TEXT_MIN_RATIO against ground, never
 * against each other, so a foreign key retinted toward body can still land
 * within a hair of error or success by coincidence (Solarized Light's body
 * and error measure 0.154 and 0.158 relative luminance — near-identical).
 * The true extreme carries no such risk: nothing repair.ts ever produces
 * sits at literal black or white, so anything genuinely dark or light in
 * the original key stays the most extreme thing on the segment it renders
 * on, by construction.
 *
 * Luminance, not HSL lightness, is what this measures and targets — a fully
 * saturated yellow reads far lighter than its own HSL lightness number
 * suggests (yellow's green and red channels both carry heavy luminance
 * weight), so targeting HSL lightness let a yellow badge and a mid-grey
 * text colour land on the same measured luminance and vanish into each
 * other. matchValueForLuminance (repair.ts's own hue/chroma-preserving
 * search, reused rather than duplicated) is what makes targeting the real
 * luminance possible without giving up hue or chroma.
 *
 * Holding hue and chroma fixed, and only ever sliding luminance along a
 * fixed line between two fixed points, is what keeps two keys that differed
 * before still differing after: the map is monotonic in luminance, so two
 * different inputs collide only if they already agreed on hue, chroma *and*
 * luminance — i.e. were already the same colour.
 */
function retintByLuminance(hex: string, groundHex: string): string {
  const { hue } = toHsl(hex);
  const chroma = chromaOf(hex);
  const groundLuminance = relativeLuminance(groundHex);
  const farPoleLuminance = poleWithMoreHeadroom(groundHex) ? 1 : 0;
  const darkPoleLuminance = Math.min(groundLuminance, farPoleLuminance);
  const lightPoleLuminance = Math.max(groundLuminance, farPoleLuminance);
  const originalLuminance = relativeLuminance(hex);
  const targetLuminance = darkPoleLuminance + originalLuminance * (lightPoleLuminance - darkPoleLuminance);
  const matchValue = matchValueForLuminance(hue, chroma, targetLuminance);
  return fromHueChromaMatch({ hue, chroma, matchValue });
}

/**
 * The colour a foreign palette key becomes when Chameleon retints a scheme.
 * A name that reliably announces its own intent is pinned to that role's
 * resolved colour outright; everything else keeps its own hue and chroma
 * and has only its luminance carried into the new theme's own dark/light
 * range — see retintByLuminance. This is CHM-37's replacement for CHM-31's
 * nearestRoleFor, which threw away that distinction and snapped every key
 * onto one of six flat roles.
 */
export function recoloredHexFor(name: string, hex: string, resolvedRoleHexes: Readonly<Record<Role, string>>): string {
  const impliedRole = roleImpliedByName(name);
  if (impliedRole) return resolvedRoleHexes[impliedRole];
  return retintByLuminance(hex, resolvedRoleHexes.ground);
}
