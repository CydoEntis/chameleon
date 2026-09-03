import {
  GREEN_HUE_MAX_DEGREES,
  GREEN_HUE_MIN_DEGREES,
  RED_HUE_MAX_DEGREES,
  RED_HUE_WRAP_MIN_DEGREES,
  ROLES,
  type Role,
} from "../constants.js";
import { contrastRatio, toHsl } from "./color.js";
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
 */
const BASE_COLOR_SLOTS: readonly SlotName[] = ["blue", "cyan", "purple", "green", "red", "yellow"];

type HueCategory = "red" | "green" | "cool" | "other";

/**
 * Classifies a slot's *measured* hue, not its name. Rosé Pine Dawn's
 * `green` slot holds a blue (hue ~197°, "cool") and its `cyan` slot holds a
 * pink (hue ~3°, "red") — a role built from the slot named `green` would be
 * wrong in that theme.
 */
function hueCategoryOf(hex: string): HueCategory {
  const { hue, saturation } = toHsl(hex);
  if (saturation === 0) return "other";
  if (hue < RED_HUE_MAX_DEGREES || hue >= RED_HUE_WRAP_MIN_DEGREES) return "red";
  if (hue >= GREEN_HUE_MIN_DEGREES && hue < GREEN_HUE_MAX_DEGREES) return "green";
  if (hue >= GREEN_HUE_MAX_DEGREES && hue < RED_HUE_WRAP_MIN_DEGREES) return "cool";
  return "other";
}

function toRoleColor(measured: Palette, slot: SlotName, groundHex: string): RoleColor {
  const hex = measured.slots[slot].hex;
  return { hex, slot, contrastRatio: contrastRatio(hex, groundHex) };
}

/**
 * Picks the base colour slot that best fits a hue category, by measured
 * contrast against ground. Falls back to scanning every base slot if none
 * measures into the category — a theme with no genuinely green-hued slot
 * still needs a success colour.
 */
function strongestInCategory(measured: Palette, groundHex: string, category: HueCategory): RoleColor {
  const inCategory = BASE_COLOR_SLOTS.filter(
    (slot) => hueCategoryOf(measured.slots[slot].hex) === category,
  );
  const candidateSlots = inCategory.length > 0 ? inCategory : BASE_COLOR_SLOTS;

  return candidateSlots
    .map((slot) => toRoleColor(measured, slot, groundHex))
    .reduce((strongest, candidate) => (candidate.contrastRatio > strongest.contrastRatio ? candidate : strongest));
}

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
export function assignRolesByContrast(measured: Palette): RoleAssignment {
  const groundHex = measured.slots.background.hex;
  const ground = toRoleColor(measured, "background", groundHex);
  const body = toRoleColor(measured, "foreground", groundHex);
  const muted = toRoleColor(measured, "brightBlack", groundHex);
  const accent = strongestInCategory(measured, groundHex, "cool");
  const success = strongestInCategory(measured, groundHex, "green");
  const error = strongestInCategory(measured, groundHex, "red");

  const assignment: Record<Role, RoleColor> = { ground, body, muted, accent, success, error };
  for (const role of ROLES) Object.freeze(assignment[role]);
  return Object.freeze(assignment);
}
