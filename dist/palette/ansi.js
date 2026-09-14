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
 * Unlike the six roles, slots are not checked for collisions with one
 * another: an application uses one ANSI colour at a time, so there is
 * nothing here playing the part of repairFailingRoles' own collision
 * avoidance. The one slot measured against another slot is the pair Claude
 * Code paints a user's own message in — text on a filled band, both drawn
 * from the 16 — see CLAUDE_CODE_MESSAGE_SLOTS.
 */
import { ANSI_MIN_RATIO, RATIO_CLEARANCE_MARGIN, TEXT_MIN_RATIO } from "../constants.js";
import { chromaOf, contrastRatio, toHsl } from "./color.js";
import { toPalette } from "./palette.js";
import { repairAtHue, repairTowardFloor } from "./repair.js";
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
 * The two slots Claude Code's "-ansi" themes paint a user's own message in,
 * keyed by the appearance adapters/claude-code.ts picks that theme for. Read
 * out of Claude Code's own binary: dark-ansi sets `text` to ansi:whiteBright
 * on `userMessageBackground` ansi:blackBright, and light-ansi sets ansi:black
 * on ansi:white. That is running text a person reads back, so the pair owes
 * TEXT_MIN_RATIO — and it is one slot on another, which the per-slot floor
 * against ground never measures. PaperColor Dark's brightWhite is a teal
 * (#5f8787) that clears its own floor against ground easily and measures
 * 1.80 on its own brightBlack.
 */
export const CLAUDE_CODE_MESSAGE_SLOTS = {
    dark: { text: "brightWhite", messageBackground: "brightBlack" },
    light: { text: "black", messageBackground: "white" },
};
/** The colour at `hex`'s own hue, holding as much of its chroma as it can, that measures `targetRatio` against `referenceHex` on the given side of it — see repairAtHue. */
function moveAtOwnHue(hex, referenceHex, targetRatio, isLighterThanReference) {
    return repairAtHue(toHsl(hex).hue, chromaOf(hex), referenceHex, targetRatio, targetRatio, isLighterThanReference).hex;
}
/**
 * Makes Claude Code's user message readable — text clearing TEXT_MIN_RATIO
 * on its message background — without either slot dropping under
 * ANSI_MIN_RATIO against ground.
 *
 * Text moves first, and always away from ground's side: brighter on a dark
 * pack, darker on a light one, which can only widen its own gap from ground
 * as well. The message background moves only when even the far pole cannot
 * read on it. It first retreats toward ground; when that would leave it
 * indistinguishable from ground, it crosses to ground's other side instead.
 * Seoulbones Dark is that case: its mid-grey ground (#4b4b4b) forces
 * brightBlack up to #7c7c7c just to be visible, and pure white measures
 * only 4.2 on that — so its message band ends up darker than the terminal.
 */
function repairClaudeCodeMessagePair(textHex, messageBackgroundHex, groundHex, appearance) {
    if (contrastRatio(textHex, messageBackgroundHex) >= TEXT_MIN_RATIO)
        return { textHex, messageBackgroundHex };
    const targetTextRatio = TEXT_MIN_RATIO * RATIO_CLEARANCE_MARGIN;
    const isTextLighter = appearance === "dark";
    const repairedTextHex = moveAtOwnHue(textHex, messageBackgroundHex, targetTextRatio, isTextLighter);
    if (contrastRatio(repairedTextHex, messageBackgroundHex) >= TEXT_MIN_RATIO) {
        return { textHex: repairedTextHex, messageBackgroundHex };
    }
    const towardGroundHex = moveAtOwnHue(messageBackgroundHex, repairedTextHex, targetTextRatio, !isTextLighter);
    if (contrastRatio(towardGroundHex, groundHex) >= ANSI_MIN_RATIO) {
        return { textHex: repairedTextHex, messageBackgroundHex: towardGroundHex };
    }
    const pastGroundHex = moveAtOwnHue(messageBackgroundHex, groundHex, ANSI_MIN_RATIO * RATIO_CLEARANCE_MARGIN, !isTextLighter);
    return { textHex: repairedTextHex, messageBackgroundHex: pastGroundHex };
}
/**
 * Repairs every ANSI slot in `scheme` that fails ANSI_MIN_RATIO against its
 * own background, reusing the exact hue/chroma-preserving search
 * repairFailingRoles uses for the six roles (repairTowardFloor in
 * repair.ts) — a repaired red must still read as red. Called with an empty
 * takenHexes, since two ANSI slots landing on the same hex is not the
 * collision repairFailingRoles guards against: nothing here plays the part
 * of two of Chameleon's own roles reading as identical. Then repairs the
 * pair Claude Code paints a user's own message in, on top of those
 * already-visible slots — see repairClaudeCodeMessagePair.
 */
export function repairAnsiSlots(scheme) {
    const groundHex = scheme.background;
    const noTakenHexes = new Set();
    const repairedSlots = new Set();
    const slots = {};
    for (const slotName of ANSI_SLOT_NAMES) {
        const hex = scheme[slotName];
        const candidate = { hex, slot: slotName, contrastRatio: contrastRatio(hex, groundHex) };
        const repaired = repairTowardFloor(candidate, groundHex, ANSI_MIN_RATIO, noTakenHexes);
        slots[slotName] = repaired.hex;
        if (repaired.wasRepaired)
            repairedSlots.add(slotName);
    }
    const { appearance } = toPalette(scheme);
    const messageSlots = CLAUDE_CODE_MESSAGE_SLOTS[appearance];
    const message = repairClaudeCodeMessagePair(slots[messageSlots.text], slots[messageSlots.messageBackground], groundHex, appearance);
    if (message.textHex !== slots[messageSlots.text])
        repairedSlots.add(messageSlots.text);
    if (message.messageBackgroundHex !== slots[messageSlots.messageBackground])
        repairedSlots.add(messageSlots.messageBackground);
    slots[messageSlots.text] = message.textHex;
    slots[messageSlots.messageBackground] = message.messageBackgroundHex;
    const repairedSlotsInOrder = ANSI_SLOT_NAMES.filter((slotName) => repairedSlots.has(slotName));
    return { slots: Object.freeze(slots), repairedSlots: Object.freeze(repairedSlotsInOrder) };
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