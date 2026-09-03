import { APPEARANCE_LUMINANCE_THRESHOLD } from "../constants.js";
import { relativeLuminance } from "./color.js";
import type { Scheme } from "./scheme.js";

/** Whether a scheme's background reads as light or dark. */
export type Appearance = "light" | "dark";

/** A slot's own name — one of the 16 ANSI colours or the 4 named ones. */
export type SlotName = Exclude<keyof Scheme, "name">;

/** A colour with its relative luminance measured at parse time. */
export interface MeasuredColor {
  readonly hex: string;
  readonly relativeLuminance: number;
}

/**
 * Chameleon's internal representation of a scheme, once every slot has been
 * measured and its appearance derived. Role assignment and contrast repair
 * — turning these slots into ground/body/accent/muted/success/error — is
 * the next stage of the pipeline, not this one.
 */
export interface Palette {
  readonly name: string;
  readonly appearance: Appearance;
  readonly slots: Readonly<Record<SlotName, MeasuredColor>>;
}

function measureColor(hex: string): MeasuredColor {
  return { hex, relativeLuminance: relativeLuminance(hex) };
}

// A lookup table mapping the twenty slots is one function and stays one —
// see code-standards.md, "Keep functions thin".
function measureSlots(scheme: Scheme): Record<SlotName, MeasuredColor> {
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

function appearanceOf(scheme: Scheme): Appearance {
  return relativeLuminance(scheme.background) >= APPEARANCE_LUMINANCE_THRESHOLD
    ? "light"
    : "dark";
}

/**
 * Converts a parsed Scheme into a Palette: every slot measured, appearance
 * derived from the background. The result is frozen — repair (the next
 * ticket) returns a new palette, it never edits the one it was given.
 */
export function toPalette(scheme: Scheme): Palette {
  return Object.freeze({
    name: scheme.name,
    appearance: appearanceOf(scheme),
    slots: measureSlots(scheme),
  });
}
