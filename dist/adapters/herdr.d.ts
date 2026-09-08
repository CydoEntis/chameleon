import { z } from "zod";
import type { Scheme } from "../palette/scheme.js";
/**
 * The slice of Herdr's config.toml this adapter actually depends on.
 * [ui]'s own behaviour settings (status-bar, pane border style, …) are never
 * parsed and never touched; [ui].accent is the one exception — see CHM-23 —
 * and is read back the same way [theme.custom] is. This schema exists only
 * to describe the shape this adapter reads back out, never to police the
 * rest of a user's config.
 */
declare const HerdrConfigSchema: z.ZodObject<{
    theme: z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        custom: z.ZodRecord<z.ZodString, z.ZodString>;
    }, z.core.$strip>;
    ui: z.ZodObject<{
        accent: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type HerdrConfig = z.infer<typeof HerdrConfigSchema>;
export interface HerdrAdapter {
    detect(): boolean;
    read(): HerdrConfig;
    apply(scheme: Scheme, slug: string): void;
    /** Returns a one-sentence notice when there was nothing running to reload — see reloadHerdr's own "server_not_running" handling (CHM-45) — or undefined once the reload actually took. */
    reload(): string | undefined;
}
/**
 * Ground colour for every one of Herdr's own built-ins, keyed by the same
 * name written to [theme].name — the only thing nearestHerdrBuiltinThemeNameFor
 * below needs to pick the closest one for a pack with no family match (CHM-41).
 * Herdr's CLI has no command that reports a built-in's own colours (its only
 * relevant diagnostic is the bare name list — see HERDR_BUILTIN_THEME_NAMES),
 * so these are pinned by hand:
 *
 * - Sixteen of the eighteen are the background of the Chameleon pack that
 *   shares the built-in's own upstream family — see PACK_SLUG_TO_HERDR_THEME
 *   and themes/<slug>.json — since Herdr's built-in and Chameleon's bundled
 *   pack both trace back to the same original colour scheme.
 * - "terminal", Herdr's generic non-family dark theme, is pure black — see
 *   this ticket's own body (CHM-41) for the reasoning: it's what every
 *   unmatched pack fell back to before this fix.
 * - "vesper" has no Chameleon family at all; its ground is taken from
 *   Rauno Freiberg's Vesper theme (https://github.com/raunofreiberg/vesper),
 *   which is the theme Herdr's own built-in is named after.
 */
export declare const HERDR_BUILTIN_GROUNDS: Readonly<Record<string, string>>;
/**
 * Herdr's own built-in whose ground is nearest `groundHex` by RGB distance
 * (see rgbDistance) — the fallback for a pack whose slug has no entry in
 * PACK_SLUG_TO_HERDR_THEME. Replaces the old generic terminal/one-light
 * fallback (CHM-41): with 18 built-ins to choose from, something in the
 * same colour family is almost always closer than a flat black or white,
 * and it's the tab bar, borders and cursor — none of them reachable by
 * [theme.custom] or [ui].accent — that this closeness is actually for.
 *
 * Exported so a test can assert the acceptance criterion directly — every
 * bundled pack's chosen base within a stated RGB distance of its own ground
 * — without re-deriving this file's own selection logic.
 */
export declare function nearestHerdrBuiltinThemeNameFor(groundHex: string): string;
/**
 * Whether `config`'s own [theme.custom] tokens and [ui] accent already carry
 * every colour `scheme` would actually resolve to under Herdr's own token
 * names, right now — the same values applyHerdrScheme itself writes (see
 * resolveHerdrTheme), so a mismatch means this target has drifted from
 * whatever pack `ch` last recorded as active. See CHM-27.
 *
 * This takes `scheme`, not a pack's own precomputed role table, and re-runs
 * the same repair pipeline apply uses — CHM-88: a bundled pack's stored
 * colours are only as fresh as the last time its own build step ran, and
 * this pipeline has grown twice since (CHM-79's ANSI and cursor floors,
 * CHM-85's panel_bg-aware accent family) without every bundled theme being
 * regenerated. Comparing against the stored payload meant a machine that had
 * just been correctly, freshly applied was reported as drifted, forever —
 * the repair had moved a role off the payload's own value on purpose, and
 * the payload never caught up.
 */
export declare function herdrMatchesScheme(config: HerdrConfig, scheme: Scheme): boolean;
/**
 * Builds the Herdr adapter. `configPath` defaults to the real config.toml
 * location and is only ever overridden by tests, which point it at a
 * fixture copy so nothing here touches a real config.
 */
export declare function createHerdrAdapter(configPath?: string | undefined): HerdrAdapter;
/**
 * Restores config.toml from the backup written by the most recent `apply`.
 * Not part of the adapter interface — undo is a user command, not a step in
 * the theming pipeline — but it lives beside the adapter because the backup
 * file's location and format are this file's business.
 */
export declare function undoHerdr(configPath?: string | undefined): void;
export {};
