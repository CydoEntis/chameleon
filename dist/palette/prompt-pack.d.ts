import { z } from "zod";
import { type Role } from "../constants.js";
/** Everything about a bundled prompt that is not colour: identity and whether it needs a Nerd Font to render its glyphs. Kept deliberately smaller than ThemePackManifest — a prompt pack owes no per-pack attribution of its own; see prompts/ATTRIBUTION.md for the shared, once-per-file credit. */
export declare const PromptPackManifestSchema: z.ZodObject<{
    slug: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    requiresNerdFont: z.ZodBoolean;
}, z.core.$strip>;
export type PromptPackManifest = z.infer<typeof PromptPackManifestSchema>;
/**
 * The slice of a bundled `.omp.json` this module actually reasons about.
 * Deliberately narrower than the adapter's own OhMyPoshConfigSchema
 * (oh-my-posh.ts): a bundled layout is authored by hand, never edited by a
 * user, so there is no need to tolerate the arbitrary shapes a stranger's
 * config can take — only to lint the one shape Chameleon itself writes.
 * `foreground`/`background` are read as plain strings, never
 * `*_templates` arrays: no bundled layout uses a conditional colour, so
 * there is nothing for this schema to tolerate there either.
 */
declare const PromptSegmentSchema: z.ZodObject<{
    foreground: z.ZodOptional<z.ZodString>;
    background: z.ZodOptional<z.ZodString>;
}, z.core.$catchall<z.ZodUnknown>>;
export declare const PromptLayoutSchema: z.ZodObject<{
    blocks: z.ZodArray<z.ZodObject<{
        segments: z.ZodOptional<z.ZodArray<z.ZodObject<{
            foreground: z.ZodOptional<z.ZodString>;
            background: z.ZodOptional<z.ZodString>;
        }, z.core.$catchall<z.ZodUnknown>>>>;
    }, z.core.$catchall<z.ZodUnknown>>>;
}, z.core.$catchall<z.ZodUnknown>>;
export type PromptLayout = z.infer<typeof PromptLayoutSchema>;
export type PromptSegment = z.infer<typeof PromptSegmentSchema>;
/** Parses a bundled layout's raw JSON, naming the file whose shape is wrong rather than throwing a bare ZodError — the same contract as theme-pack.ts's parseThemePack. */
export declare function parsePromptLayout(rawJson: unknown, fileName: string): PromptLayout;
/** Every hex colour literal anywhere in `layoutText`, deduplicated — CLAUDE.md's "Never ship a colour that fails its contrast floor" only holds if nothing in a bundled layout can bypass repair with a colour of its own. Scans the raw text rather than the parsed structure, since a stray hex belongs nowhere in a bundled layout at all, not only in `foreground`/`background`. */
export declare function findLiteralHexColors(layoutText: string): string[];
/** Every Nerd Font glyph codepoint anywhere in `layoutText`, deduplicated. Empty for a layout that renders with no Nerd Font at all — see half-life's own manifest, requiresNerdFont: false. */
export declare function findNerdFontGlyphs(layoutText: string): string[];
/**
 * Every reason `layout`'s own segments are not safe to ship, named per
 * segment so a broken fixture (or a broken hand-authored layout) fails with
 * something a person can act on rather than a bare boolean. Two kinds of
 * defect, per CHM-46's authoring rule:
 *
 * - a `foreground`/`background` field that is present but not a `p:<role>`
 *   reference at all (a typo, an unknown role, a colour name);
 * - a segment naming both a foreground and a background role where neither
 *   one is `ground` — CLAUDE.md's "One side of every foreground/background
 *   pair must be ground", the rule that keeps a segment out of the unsafe
 *   region measured across all 26 bundled packs (body-vs-accent as low as
 *   1.00 on Solarized Dark).
 *
 * A segment with only a foreground (no background at all) is never flagged
 * here: it renders on the terminal's own background, which is ground.
 */
export declare function findGroundPairingViolations(layout: PromptLayout): string[];
/** Every reason `layoutText` must not ship, combining both guarantees CLAUDE.md names for a bundled prompt: no literal hex, and every segment ground-paired. Pure and total — never throws, so a caller (a test, or the build-time lint) decides what "must not ship" means for it. */
export declare function lintPromptLayout(layoutText: string, fileName: string): string[];
/** Throws, naming `fileName` and every violation, when `layoutText` fails lintPromptLayout — the build-time gate CLAUDE.md's "A bad layout must not be able to ship" needs to be a checked fact. */
export declare function assertPromptLayoutIsSafe(layoutText: string, fileName: string): void;
/** Every segment `layout` carries, counted once each — the denominator CHM-46's own acceptance criterion asks for: "assert the count of segments checked", so a contrast test that silently checked zero segments (CHM-40's own failure mode: a single-sample check) fails loudly instead of passing for the wrong reason. */
export declare function countSegments(layout: PromptLayout): number;
/** Every segment in `layout` whose foreground-against-background contrast, measured against `roleHexes`, falls below TEXT_MIN_RATIO — CHM-46's own acceptance criterion, checked per pack rather than assumed from the authoring rule alone. Named per segment index, the same as findGroundPairingViolations, so a failure names exactly which segment and which pack. */
export declare function findContrastFailures(layout: PromptLayout, roleHexes: Readonly<Record<Role, string>>, packSlug: string): string[];
/**
 * `layout` with every `p:<role>` reference resolved against `roleHexes` —
 * the moment a bundled prompt pack becomes an Oh My Posh config Oh My Posh
 * itself can render. `roleHexes` is a specific theme pack's own resolved
 * "oh-my-posh" payload (ThemePackPayloads["oh-my-posh"]), so the same
 * layout paints differently under every theme, the whole point of CHM-46's
 * "any theme paints them for free". Pure — no file I/O — so this stays
 * testable against fixtures the same way every other palette/ module is.
 */
export declare function resolvePromptLayoutRoleReferences(layout: PromptLayout, roleHexes: Readonly<Record<Role, string>>): Record<string, unknown>;
export {};
