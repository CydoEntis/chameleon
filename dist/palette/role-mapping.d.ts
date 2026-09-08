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
import { type Role } from "../constants.js";
import type { Scheme } from "./scheme.js";
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
export declare function recoloredHexFor(name: string, hex: string, resolvedRoleHexes: Readonly<Record<Role, string>>, targetScheme: Scheme): string;
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
export declare function recoloredLiteralHexFor(hex: string, resolvedRoleHexes: Readonly<Record<Role, string>>): string;
/**
 * The six colours a prompt paints its segments in, drawn from what the
 * scheme actually ships rather than from the six resolved roles.
 *
 * assignRolesByContrast picks accent, success and error by measured contrast
 * against ground. That is the right rule for text that must stay readable on
 * every surface, and the wrong one for a prompt: it touches only 6 of the
 * scheme's 16 slots and prefers whichever is safest, so a prompt ends up
 * paler and flatter than the theme it is supposed to be wearing. Monokai is
 * the clearest case — its signature #f92672 sits at hue 337, just short of
 * the red band's 345, so it is classified cool, loses the accent contest to
 * #66d9ef on contrast, and never reaches the prompt at all.
 *
 * These six are picked by hue instead: for each, whichever slot sits nearest
 * that hue while still clearing ANSI_MIN_RATIO against ground, with chroma
 * breaking ties so the vivid member of a family wins over its washed-out
 * sibling. A scheme with nothing near a given hue falls back to the resolved
 * role, which is safe by construction.
 */
export interface PromptPalette {
    readonly blue: string;
    readonly cyan: string;
    readonly green: string;
    readonly purple: string;
    readonly yellow: string;
    readonly red: string;
}
export declare function promptPaletteFor(scheme: Scheme, resolvedRoleHexes: Readonly<Record<Role, string>>): PromptPalette;
