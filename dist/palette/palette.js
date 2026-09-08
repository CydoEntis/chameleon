import { APPEARANCE_LUMINANCE_THRESHOLD } from "../constants.js";
import { relativeLuminance } from "./color.js";
function measureColor(hex) {
    return Object.freeze({ hex, relativeLuminance: relativeLuminance(hex) });
}
// A lookup table mapping the twenty slots is one function and stays one —
// see code-standards.md, "Keep functions thin".
function measureSlots(scheme) {
    return {
        black: measureColor(scheme.black),
        red: measureColor(scheme.red),
        green: measureColor(scheme.green),
        yellow: measureColor(scheme.yellow),
        blue: measureColor(scheme.blue),
        purple: measureColor(scheme.purple),
        cyan: measureColor(scheme.cyan),
        white: measureColor(scheme.white),
        brightBlack: measureColor(scheme.brightBlack),
        brightRed: measureColor(scheme.brightRed),
        brightGreen: measureColor(scheme.brightGreen),
        brightYellow: measureColor(scheme.brightYellow),
        brightBlue: measureColor(scheme.brightBlue),
        brightPurple: measureColor(scheme.brightPurple),
        brightCyan: measureColor(scheme.brightCyan),
        brightWhite: measureColor(scheme.brightWhite),
        background: measureColor(scheme.background),
        foreground: measureColor(scheme.foreground),
        cursorColor: measureColor(scheme.cursorColor),
        selectionBackground: measureColor(scheme.selectionBackground),
    };
}
function appearanceOf(scheme) {
    return relativeLuminance(scheme.background) >= APPEARANCE_LUMINANCE_THRESHOLD
        ? "light"
        : "dark";
}
/**
 * Converts a parsed Scheme into a Palette: every slot measured, appearance
 * derived from the background. The result is deep-frozen — the palette
 * itself, its slots record, and every MeasuredColor within it — so repair
 * (the next ticket) returns a new palette, it never edits the one it was
 * given.
 */
export function toPalette(scheme) {
    return Object.freeze({
        name: scheme.name,
        appearance: appearanceOf(scheme),
        slots: Object.freeze(measureSlots(scheme)),
    });
}
//# sourceMappingURL=palette.js.map