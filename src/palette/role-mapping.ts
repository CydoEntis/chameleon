/**
 * Recolours a palette key Chameleon does not own into the new theme's own
 * colour space, so an adapter can retint that key instead of deleting it or
 * flattening it. See CHM-31: Oh My Posh's palette table used to be replaced
 * wholesale with Chameleon's own six role names, deleting every key a real
 * prompt's segments referenced. See CHM-37: the fix for that, mapping every
 * key onto one of six roles, was still wrong — 46 of a real 47-key prompt
 * palette landed on the same three or four role colours, so the prompt
 * still rendered as flat, illegible blobs. See CHM-53: the fix for *that*
 * overcorrected the other way — carrying a key's own hue and chroma through
 * unchanged reproduced the source theme so faithfully that the destination
 * theme barely participated; four unrelated destination packs rendered the
 * same Solarized olive/gold/blue a user's config started with. What a
 * palette's keys are for is the relationships between them, not the literal
 * colours — those belong to whichever theme is active.
 *
 * See CHM-90: that reasoning holds only for a key a theme author actually
 * named. CHM-74's literal-hex lift mints a key with no relationship to
 * protect at all — recoloredHexFor's own hue-family retint left one
 * permanently red, or teal, under every pack it was ever applied to, which
 * is the opposite of what retinting is for. recoloredLiteralHexFor is the
 * lift's own recolour path: a full snap onto the destination pack's own
 * role colours, never a hue-family retint.
 */

import {
  GREEN_HUE_MAX_DEGREES,
  GREEN_HUE_MIN_DEGREES,
  MIN_REPAIRED_CHROMA,
  RED_HUE_MAX_DEGREES,
  RED_HUE_WRAP_MIN_DEGREES,
  type Role,
} from "../constants.js";
import { chromaOf, fromHueChromaMatch, hueDistanceDegrees, relativeLuminance, toHsl } from "./color.js";
import { matchValueForLuminance, poleWithMoreHeadroom } from "./repair.js";
import { BASE_COLOR_SLOTS } from "./roles.js";
import type { Scheme } from "./scheme.js";

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
 * The hue of whichever of the destination scheme's own base ANSI colours
 * measures closest to `sourceHue` — never the slot sharing the source key's
 * own name or hue category, for the same reason role assignment never
 * trusts a slot's name over what it measures (roles.ts: Rosé Pine Dawn's
 * `green` slot measures as a blue). This is what CHM-53 means by
 * "re-express using the target pack's colours for that family": the six
 * base slots (BASE_COLOR_SLOTS) are the only hue-bearing colours a theme
 * actually ships, so the nearest of those six *is* the family, for both the
 * source key and the destination alike.
 */
function nearestHueFamilyHue(sourceHue: number, targetScheme: Scheme): number {
  const candidateHues = BASE_COLOR_SLOTS.map((slot) => toHsl(targetScheme[slot]).hue);
  return candidateHues.reduce((nearest, candidate) =>
    hueDistanceDegrees(candidate, sourceHue) < hueDistanceDegrees(nearest, sourceHue) ? candidate : nearest,
  );
}

/**
 * Recolours `hex` into `targetScheme`'s own colour space rather than a
 * perturbation of `hex` itself. A genuinely coloured source — chroma at or
 * above MIN_REPAIRED_CHROMA, the same "recognisably tinted, not a grey"
 * floor repair.ts holds a repaired role to — is re-expressed at the hue of
 * whichever of `targetScheme`'s own six base ANSI colours reads as the same
 * hue family (see nearestHueFamilyHue); a near-neutral source keeps its own
 * (largely irrelevant) hue, since there is no family for a grey border or
 * label to belong to. Chroma is always the source's own, both cases: two
 * keys that started at different saturations — chips's own vivid battery-
 * error red next to its muted date-segment grey-blue — must stay
 * distinguishable by more than luminance alone once several keys land in the
 * same destination hue family, and a theme's own base colour is one fixed
 * chroma, not a range a source's whole spread of them could map onto without
 * collapsing most of it.
 *
 * Either way, only luminance moves — from wherever the source sat between
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
 * This is what keeps CHM-37's distinctness guarantee even though CHM-53
 * changes whose hue is carried through: within one destination hue family
 * the map is still monotonic in both chroma and luminance, so two sources
 * land on the same colour only if they already agreed on family, chroma
 * *and* relative luminance — never merely a rough similarity in one alone.
 */
function retintByLuminance(hex: string, targetScheme: Scheme, groundHex: string): string {
  const originalHue = toHsl(hex).hue;
  const chroma = chromaOf(hex);
  const isGenuinelyColoured = chroma >= MIN_REPAIRED_CHROMA;
  const hue = isGenuinelyColoured ? nearestHueFamilyHue(originalHue, targetScheme) : originalHue;

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
 * resolved colour outright; everything else is re-expressed in
 * `targetScheme`'s own colour space, at the same relative lightness the
 * source held in its own scheme — see retintByLuminance. This is CHM-37's
 * replacement for CHM-31's nearestRoleFor, which threw away the distinction
 * between keys and snapped every one onto one of six flat roles, and
 * CHM-53's replacement for CHM-37's own retintByLuminance, which carried a
 * key's hue and chroma through unchanged and so barely moved at all.
 */
export function recoloredHexFor(name: string, hex: string, resolvedRoleHexes: Readonly<Record<Role, string>>, targetScheme: Scheme): string {
  const impliedRole = roleImpliedByName(name);
  if (impliedRole) return resolvedRoleHexes[impliedRole];
  return retintByLuminance(hex, targetScheme, resolvedRoleHexes.ground);
}

/**
 * Lightness (HSL percent, [0, 100]) above which a colour too near-neutral to
 * belong to any hue-based role reads as body text rather than muted — the
 * same split assignRolesByContrast draws between a scheme's own foreground
 * and its dim secondary slot (roles.ts), applied here to one standalone
 * colour with no scheme of its own to compare against.
 */
const NEUTRAL_BODY_LIGHTNESS_THRESHOLD = 50;

/**
 * The role `hex` most resembles by its own measured hue and lightness alone
 * — never `ground`, since every caller here is recolouring a segment's own
 * foreground, and a foreground landing on the same colour as the background
 * it renders over is exactly the failure repairSegmentForegrounds exists to
 * catch afterwards. Reuses the same red/green/cool hue bands roles.ts
 * classifies a scheme's own slots by (see hueCategoryOf there), so a hue this
 * calls "success" and a hue assignRolesByContrast calls "green" are always
 * the same hue. A colour with too little chroma to belong to any hue family
 * — below MIN_REPAIRED_CHROMA, the same "recognisably tinted, not a grey"
 * floor repair.ts holds every role to — falls back to a lightness split
 * between body and muted instead, same as a hue that lands in neither band
 * (the yellow/orange gap roles.ts's own hueCategoryOf calls "other").
 */
function nearestRoleByHue(hex: string): Exclude<Role, "ground"> {
  const { hue, lightness } = toHsl(hex);
  if (chromaOf(hex) >= MIN_REPAIRED_CHROMA) {
    if (hue < RED_HUE_MAX_DEGREES || hue >= RED_HUE_WRAP_MIN_DEGREES) return "error";
    if (hue >= GREEN_HUE_MIN_DEGREES && hue < GREEN_HUE_MAX_DEGREES) return "success";
    if (hue >= GREEN_HUE_MAX_DEGREES && hue < RED_HUE_WRAP_MIN_DEGREES) return "accent";
  }
  return lightness >= NEUTRAL_BODY_LIGHTNESS_THRESHOLD ? "body" : "muted";
}

/**
 * The colour a lifted literal-hex palette key becomes when Chameleon retints
 * a scheme — CHM-90's replacement for recoloredHexFor when `hex` came from
 * CHM-74's literal-hex lift (see oh-my-posh.ts's
 * LITERAL_COLOR_PALETTE_KEY_PREFIX), never for a key a theme author actually
 * named.
 *
 * A named key like chips.omp.json's c-git-ahead carries a relationship to
 * every other key in that same prompt worth protecting, which is exactly
 * what recoloredHexFor's hue-family-preserving retint is for — see its own
 * doc comment, and CHM-37/CHM-53's reasoning for why. A literal key carries
 * none of that: it is one segment's own decorative hex, picked by whichever
 * theme the user's prompt happened to be written in, with no other key
 * depending on it staying in the same hue family. Preserving that hue family
 * regardless is CHM-90's own bug report — a prompt that stays recognisably
 * red, or teal, under every pack it is ever applied to, because a hue family
 * is exactly the thing a hue-preserving retint holds fixed. This snaps a
 * literal key fully onto the destination pack's own resolved role colour
 * instead, so a pack switch changes it exactly as much as it changes body or
 * accent — see nearestRoleByHue.
 */
export function recoloredLiteralHexFor(hex: string, resolvedRoleHexes: Readonly<Record<Role, string>>): string {
  return resolvedRoleHexes[nearestRoleByHue(hex)];
}
