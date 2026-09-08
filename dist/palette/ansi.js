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
];
/**
 * Repairs every ANSI slot in `scheme` that fails ANSI_MIN_RATIO against its
 * own background, reusing the exact hue/chroma-preserving search
 * repairFailingRoles uses for the six roles (repairTowardFloor in
 * repair.ts) — a repaired red must still read as red. Called with an empty
 * takenHexes, since two ANSI slots landing on the same hex is not the
 * collision repairFailingRoles guards against: nothing here plays the part
 * of two of Chameleon's own roles reading as identical.
 */
export function repairAnsiSlots(scheme) {
    const groundHex = scheme.background;
    const noTakenHexes = new Set();
    const repairedSlots = [];
    const slots = {};
    for (const slotName of ANSI_SLOT_NAMES) {
        const hex = scheme[slotName];
        const candidate = { hex, slot: slotName, contrastRatio: contrastRatio(hex, groundHex) };
        const repaired = repairTowardFloor(candidate, groundHex, ANSI_MIN_RATIO, noTakenHexes);
        slots[slotName] = repaired.hex;
        if (repaired.wasRepaired)
            repairedSlots.push(slotName);
    }
    return { slots: Object.freeze(slots), repairedSlots: Object.freeze(repairedSlots) };
}
/**
 * Repairs the cursor colour against `groundHex`, reusing the exact
 * hue/chroma-preserving search repairAnsiSlots uses for the 16 ANSI slots
 * (repairTowardFloor) — the cursor is the same kind of pair as those (CHM-79:
 * "distinguishable from the background it is drawn on", never a text
 * legibility guarantee), it just is not one of the 16 numbered slots a Scheme
 * carries. ayu-light's own authored cursor measures 1.80 against its
 * background and nord-light's 1.90 — both under ANSI_MIN_RATIO before this
 * repair, and neither is caught anywhere else: cursorColor is never part of
 * ANSI_SLOT_NAMES, and nothing previously checked it at all.
 */
export function repairCursorColor(cursorHex, groundHex) {
    const candidate = { hex: cursorHex, slot: "cursorColor", contrastRatio: contrastRatio(cursorHex, groundHex) };
    return repairTowardFloor(candidate, groundHex, ANSI_MIN_RATIO, new Set()).hex;
}
//# sourceMappingURL=ansi.js.map