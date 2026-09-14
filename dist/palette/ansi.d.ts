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
import { type Appearance } from "./palette.js";
import type { Scheme } from "./scheme.js";
/**
 * The 16 ANSI colour slots a Scheme carries, as distinct from the 4 named
 * ones — background, foreground, cursorColor, selectionBackground — that
 * describe the terminal's own chrome rather than something an application
 * paints text in.
 */
export declare const ANSI_SLOT_NAMES: readonly ["black", "red", "green", "yellow", "blue", "purple", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightPurple", "brightCyan", "brightWhite"];
export type AnsiSlotName = (typeof ANSI_SLOT_NAMES)[number];
export interface ClaudeCodeMessageSlots {
    readonly text: AnsiSlotName;
    readonly messageBackground: AnsiSlotName;
}
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
export declare const CLAUDE_CODE_MESSAGE_SLOTS: Readonly<Record<Appearance, ClaudeCodeMessageSlots>>;
export interface AnsiRepairReport {
    readonly slots: Readonly<Record<AnsiSlotName, string>>;
    /**
     * Slots whose colour changed, either because they failed ANSI_MIN_RATIO
     * against the scheme's background or because Claude Code's user message
     * could not be read on them (see CLAUDE_CODE_MESSAGE_SLOTS). Every slot not
     * named here is byte-identical to the upstream scheme — see CLAUDE.md's
     * "Leave every slot already above the floor untouched."
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
 * of two of Chameleon's own roles reading as identical. Then repairs the
 * pair Claude Code paints a user's own message in, on top of those
 * already-visible slots — see repairClaudeCodeMessagePair.
 */
export declare function repairAnsiSlots(scheme: Scheme): AnsiRepairReport;
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
export declare function repairCursorColor(cursorHex: string, groundHex: string): string;
