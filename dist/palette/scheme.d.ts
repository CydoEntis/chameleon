import { z } from "zod";
/**
 * Raw Windows Terminal colour scheme JSON: the 16 ANSI slots plus the 4
 * named ones every scheme carries. This is the "scheme" of the three-word
 * model — upstream input, unmeasured and unassigned.
 */
export declare const SchemeSchema: z.ZodObject<{
    name: z.ZodString;
    black: z.ZodString;
    red: z.ZodString;
    green: z.ZodString;
    yellow: z.ZodString;
    blue: z.ZodString;
    purple: z.ZodString;
    cyan: z.ZodString;
    white: z.ZodString;
    brightBlack: z.ZodString;
    brightRed: z.ZodString;
    brightGreen: z.ZodString;
    brightYellow: z.ZodString;
    brightBlue: z.ZodString;
    brightPurple: z.ZodString;
    brightCyan: z.ZodString;
    brightWhite: z.ZodString;
    background: z.ZodString;
    foreground: z.ZodString;
    cursorColor: z.ZodString;
    selectionBackground: z.ZodString;
}, z.core.$strip>;
export type Scheme = z.infer<typeof SchemeSchema>;
/**
 * Parses raw Windows Terminal scheme JSON into a Scheme. Throws a ZodError
 * naming the missing or malformed slot — a scheme that fails validation
 * must say why, never silently drop a colour.
 */
export declare function parseScheme(input: unknown): Scheme;
