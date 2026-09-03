import { z } from "zod";

const hexColor = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, "must be a 6-digit hex colour");

/**
 * Raw Windows Terminal colour scheme JSON: the 16 ANSI slots plus the 4
 * named ones every scheme carries. This is the "scheme" of the three-word
 * model — upstream input, unmeasured and unassigned.
 */
export const SchemeSchema = z.object({
  name: z.string().min(1),
  black: hexColor,
  red: hexColor,
  green: hexColor,
  yellow: hexColor,
  blue: hexColor,
  purple: hexColor,
  cyan: hexColor,
  white: hexColor,
  brightBlack: hexColor,
  brightRed: hexColor,
  brightGreen: hexColor,
  brightYellow: hexColor,
  brightBlue: hexColor,
  brightPurple: hexColor,
  brightCyan: hexColor,
  brightWhite: hexColor,
  background: hexColor,
  foreground: hexColor,
  cursorColor: hexColor,
  selectionBackground: hexColor,
});

export type Scheme = z.infer<typeof SchemeSchema>;

/**
 * Parses raw Windows Terminal scheme JSON into a Scheme. Throws a ZodError
 * naming the missing or malformed slot — a scheme that fails validation
 * must say why, never silently drop a colour.
 */
export function parseScheme(input: unknown): Scheme {
  return SchemeSchema.parse(input);
}
