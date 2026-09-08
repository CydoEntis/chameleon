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
/**
 * Converts a parsed Scheme into a Palette: every slot measured, appearance
 * derived from the background. The result is deep-frozen — the palette
 * itself, its slots record, and every MeasuredColor within it — so repair
 * (the next ticket) returns a new palette, it never edits the one it was
 * given.
 */
export declare function toPalette(scheme: Scheme): Palette;
