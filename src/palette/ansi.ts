/**
 * Repairs the 16 ANSI colour slots a Scheme carries — the ones a terminal
 * application actually paints text with, distinct from Chameleon's six
 * resolved roles (see roles.ts, repair.ts). A role is something Chameleon
 * assigns meaning to; an ANSI slot is one of the 16 numbered colours an
 * application picks by index, with no notion of "role" at all — so a slot
 * that fails its own floor against the scheme's background is invisible
 * wherever an application happened to use it. Reported as "black circles in
 * dark mode": Claude Code's own bullet markers, drawn in ANSI black, on top
 * of a background four bundled packs make byte-identical to it (CHM-32).
 *
 * Unlike the six roles, no slot is checked against any other: an
 * application uses one ANSI colour at a time, so there is nothing here
 * playing the part of repairFailingRoles' collision avoidance — only
 * whether each of the 16 slots, alone, clears ANSI_MIN_RATIO against
 * ground.
 */

import { ANSI_MIN_RATIO } from "../constants.js";
import { contrastRatio } from "./color.js";
import { repairTowardFloor } from "./repair.js";
import type { Scheme } from "./scheme.js";

/**
 * The 16 ANSI colour slots a Scheme carries, as distinct from the 4 named
 * ones — background, foreground, cursorColor, selectionBackground — that
 * describe the terminal's own chrome rather than something an application
 * paints text in.
 */
export const ANSI_SLOT_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "purple",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightPurple",
  "brightCyan",
  "brightWhite",
] as const;

export type AnsiSlotName = (typeof ANSI_SLOT_NAMES)[number];

export interface AnsiRepairReport {
  readonly slots: Readonly<Record<AnsiSlotName, string>>;
  /**
   * Slots whose colour changed because they failed ANSI_MIN_RATIO against
   * the scheme's background. Every slot not named here is byte-identical to
   * the upstream scheme — see CLAUDE.md's "Leave every slot already above
   * the floor untouched."
   */
  readonly repairedSlots: readonly AnsiSlotName[];
}

/**
 * Repairs every ANSI slot in `scheme` that fails ANSI_MIN_RATIO against its
 * own background, reusing the exact hue/chroma-preserving search
 * repairFailingRoles uses for the six roles (repairTowardFloor in
 * repair.ts) — a repaired red must still read as red. Called with an empty
 * takenHexes, since two ANSI slots landing on the same hex is not the
 * collision repairFailingRoles guards against: nothing here plays the part
 * of two of Chameleon's own roles reading as identical.
 */
export function repairAnsiSlots(scheme: Scheme): AnsiRepairReport {
  const groundHex = scheme.background;
  const noTakenHexes = new Set<string>();
  const repairedSlots: AnsiSlotName[] = [];

  const slots = {} as Record<AnsiSlotName, string>;
  for (const slotName of ANSI_SLOT_NAMES) {
    const hex = scheme[slotName];
    const candidate = { hex, slot: slotName, contrastRatio: contrastRatio(hex, groundHex) };
    const repaired = repairTowardFloor(candidate, groundHex, ANSI_MIN_RATIO, noTakenHexes);
    slots[slotName] = repaired.hex;
    if (repaired.wasRepaired) repairedSlots.push(slotName);
  }

  return { slots: Object.freeze(slots), repairedSlots: Object.freeze(repairedSlots) };
}
