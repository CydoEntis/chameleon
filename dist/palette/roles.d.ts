import { type Role } from "../constants.js";
import type { Palette, SlotName } from "./palette.js";
/**
 * One role's resolved colour: which slot it came from (for traceability —
 * never for trusting the slot's name over its measured properties) and its
 * contrast against ground at the point of assignment, before repair.
 */
export interface RoleColor {
    readonly hex: string;
    readonly slot: SlotName;
    readonly contrastRatio: number;
}
export type RoleAssignment = Readonly<Record<Role, RoleColor>>;
/**
 * The six base ANSI colour slots a hue-bearing role can be drawn from.
 * Bright variants are excluded — they exist to be brighter, not to carry a
 * different hue, and mixing them in would let a role win purely by being
 * the lightest slot rather than the most fitting hue.
 *
 * The order is a tiebreak only, used when two candidates share a hue
 * category and tie on contrast (Gruvbox's blue and purple both measure
 * 3.48 against its dark background) — never a substitute for measuring.
 *
 * Exported for palette/role-mapping.ts, which scans these same six slots to
 * find which of a *destination* theme's own colours a foreign palette key's
 * hue is nearest to — see CHM-53's nearestHueFamilyHue.
 */
export declare const BASE_COLOR_SLOTS: readonly SlotName[];
export type HueCategory = "red" | "green" | "cool" | "other";
/**
 * Classifies a slot's *measured* hue, not its name. Rosé Pine Dawn's
 * `green` slot holds a blue (hue ~197°, "cool") and its `cyan` slot holds a
 * pink (hue ~3°, "red") — a role built from the slot named `green` would be
 * wrong in that theme.
 */
export declare function hueCategoryOf(hex: string): HueCategory;
/**
 * Assigns Chameleon's six roles from a measured scheme's slots, by
 * measured contrast against ground rather than by trusting a slot's name.
 *
 * Ground and body are structural — the scheme's background and foreground
 * are always what they claim to be. Muted follows the terminal convention
 * of `brightBlack` as the dim/secondary text slot. Accent, success and
 * error are drawn from whichever base ANSI slot actually measures as
 * cool-, green- or red-hued, then ranked by contrast within that hue.
 *
 * This is assignment only — the result can still fail its floor (see
 * repairFailingRoles in repair.ts, the next stage).
 */
export declare function assignRolesByContrast(measured: Palette): RoleAssignment;
