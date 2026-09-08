import { z } from "zod";
import { type Role } from "../constants.js";
import { type Appearance } from "./palette.js";
import { type Scheme } from "./scheme.js";
/**
 * Where a bundled pack's source scheme came from, carried through to the
 * shipped pack so attribution and licence travel with the colours rather
 * than living only in a vendor directory that never ships — see CLAUDE.md's
 * "Attribution and the upstream MIT licence ship with the packs".
 */
export interface PackAttribution {
    readonly source: string;
    readonly sourceUrl: string;
    readonly commit: string;
    readonly license: string;
}
/**
 * Everything about a pack that is not colour: identity, grouping and
 * provenance. Attribution is optional because it names an *upstream*
 * source — every bundled pack has one (see PackAttribution above), but a
 * pack a user drops into their own theme directory adapts a scheme of
 * their own choosing and owes no attribution to Chameleon.
 */
export interface ThemePackManifest {
    readonly slug: string;
    readonly name: string;
    readonly family: string;
    readonly appearance: Appearance;
    readonly attribution?: PackAttribution | undefined;
}
/**
 * The colour data every target needs to theme itself, computed once at
 * build time. windows-terminal's payload is the scheme's own 20 slots,
 * verbatim, apart from `selectionBackground` — resolved against ground and
 * body once, the same resolution herdr's `selection_bg` reuses, so the two
 * targets can never disagree about what selection is (see CHM-30's
 * resolveSelectionAndBody) — and `foreground`, which carries the same call's
 * resolved `body` (CHM-33: three packs shipped Windows Terminal's own raw,
 * unrepaired `foreground` sitting behind the *resolved* selection those two
 * had never been checked against together, unreadable underneath it even
 * though herdr's own copy of body was already correct). oh-my-posh and
 * herdr's payload is the resolved, repaired role table those adapters key
 * their own blocks off — herdr's own `body` and `muted` are resolved a
 * second time against its selected-row background (see CHM-50's
 * resolveActiveRowAndText), and its `accent`/`success`/`error` a second time
 * against panel_bg (see CHM-85's repairHerdrAccentFamily), so they can differ
 * from oh-my-posh's copy of the same roles; `ground` always matches. Every
 * adapter's apply() still takes a Scheme and derives what it needs itself —
 * see adapters/*.ts — so this is a precomputed, build-time-checkable copy of
 * exactly what apply() would derive live, not a second source of truth:
 * assignRolesByContrast, repairFailingRoles, resolveSelectionAndBody,
 * resolveActiveRowAndText, resolvePanelBackground and repairHerdrAccentFamily
 * are all pure, so the two can never disagree.
 */
export interface ThemePackPayloads {
    readonly "windows-terminal": Scheme;
    readonly "oh-my-posh": Readonly<Record<Role, string>>;
    readonly herdr: Readonly<Record<Role, string>> & {
        readonly selection_bg: string;
    };
    readonly statusline: StatuslineMeterHexes;
}
/**
 * `chm statusline`'s own three meter colours — context, 5-hour and 7-day
 * (CHM-89). The six roles have no colour left to spare for three more that
 * must also stay distinct from one another (accent and body are already
 * spoken for by the model name and directory segment, success by the git
 * branch, and muted — the one role left — is what all three meters
 * collapsed onto before this fix, reading as one undifferentiated colour
 * across the bulk of the line). Resolved the same way
 * adapters/herdr.ts's badge tokens are — drawn from the scheme's own base
 * ANSI slots rather than invented (see resolveStatuslineMeterHexes) — so
 * they still come from the active pack and still change when the theme
 * does.
 */
export interface StatuslineMeterHexes {
    readonly context: string;
    readonly fiveHour: string;
    readonly sevenDay: string;
}
export interface ThemePack {
    readonly manifest: ThemePackManifest;
    readonly payloads: ThemePackPayloads;
}
/**
 * Runs a scheme through the full contrast engine — assign, then repair —
 * and packages the result as a shippable pack: a manifest carrying identity
 * and attribution, plus every target's payload. Pure: no file I/O, so the
 * build tool that generates the bundled packs, the loader that reads a
 * user's dropped-in pack, and any test can all call it directly against a
 * scheme literal. `attribution` is omitted for a user pack, which has no
 * upstream to credit — see ThemePackManifest.
 *
 * `explicitSlug`, when given, is used verbatim instead of the slug derived
 * from `family` and the measured appearance. This is what lets a dropped-in
 * pack's declared slug collide with a bundled pack's on purpose, so it can
 * override it — see CLAUDE.md: "A manifest's declared slug is what the pack
 * loads as. Never derive it from name when one is declared."
 */
export declare function buildThemePack(scheme: Scheme, family: string, attribution?: PackAttribution, explicitSlug?: string): ThemePack;
/**
 * Validates a shipped pack file's shape at load time. The packs under
 * themes/ are generated and committed by this project, never user-edited,
 * but they still cross a file-system boundary into the running CLI — see
 * code-standards.md, "Validate at every boundary" — so a corrupted or
 * hand-edited pack file fails with a named reason instead of a crash deep
 * inside an adapter.
 */
export declare const ThemePackSchema: z.ZodObject<{
    manifest: z.ZodObject<{
        slug: z.ZodString;
        name: z.ZodString;
        family: z.ZodString;
        appearance: z.ZodEnum<{
            light: "light";
            dark: "dark";
        }>;
        attribution: z.ZodOptional<z.ZodObject<{
            source: z.ZodString;
            sourceUrl: z.ZodString;
            commit: z.ZodString;
            license: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    payloads: z.ZodObject<{
        "windows-terminal": z.ZodObject<{
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
        "oh-my-posh": z.ZodObject<{
            ground: z.ZodString;
            body: z.ZodString;
            accent: z.ZodString;
            muted: z.ZodString;
            success: z.ZodString;
            error: z.ZodString;
        }, z.core.$strip>;
        herdr: z.ZodObject<{
            ground: z.ZodString;
            body: z.ZodString;
            accent: z.ZodString;
            muted: z.ZodString;
            success: z.ZodString;
            error: z.ZodString;
            selection_bg: z.ZodString;
        }, z.core.$strip>;
        statusline: z.ZodObject<{
            context: z.ZodString;
            fiveHour: z.ZodString;
            sevenDay: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>;
}, z.core.$strip>;
/** Parses a shipped pack's raw JSON, naming the file whose shape is wrong rather than throwing a bare ZodError. */
export declare function parseThemePack(input: unknown, fileName: string): ThemePack;
/**
 * What a user hand-writes in a dropped-in pack's pack.json: the one scheme
 * it adapts, plus an optional family for grouping it with a light/dark
 * sibling of its own, and an optional slug.
 *
 * `slug` is optional in the *file*, but never silently defaulted past this
 * point — a manifest that omits it must still get one, and the caller that
 * derives it is responsible for warning that it did (see
 * adapters/user-theme-packs.ts). When a manifest does declare a slug, it is
 * load-bearing: it is what a user pack collides on to override a bundled
 * pack of the same slug, and CHM-12 shipped a version of this loader that
 * silently discarded a declared slug in favour of one derived from `family`,
 * which made overriding a bundled pack impossible by construction.
 */
export declare const UserPackManifestSchema: z.ZodObject<{
    slug: z.ZodOptional<z.ZodString>;
    family: z.ZodOptional<z.ZodString>;
    scheme: z.ZodObject<{
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
}, z.core.$strip>;
export type UserPackManifest = z.infer<typeof UserPackManifestSchema>;
/**
 * Parses a dropped-in pack's pack.json, naming the pack directory whose
 * shape is wrong rather than throwing a bare ZodError — the same
 * name-the-source contract as parseThemePack, but keyed by directory name
 * rather than file name since a user pack is a directory of its own.
 */
export declare function parseUserPackManifest(input: unknown, packDirName: string): UserPackManifest;
