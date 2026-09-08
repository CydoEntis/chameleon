import { z } from "zod";
import { type Role } from "../constants.js";
import type { Scheme } from "../palette/scheme.js";
import { type Shell } from "./platform.js";
/** winget's package identifier for Oh My Posh, used to build the one-line install command `ch doctor` offers. */
export declare const OH_MY_POSH_WINGET_PACKAGE_ID = "JanDeDobbeleer.OhMyPosh";
/**
 * The slice of a .omp.json config this adapter actually depends on.
 * Everything else (segments, blocks, console title template, …) is
 * unvalidated and passed through untouched — this schema exists only to
 * catch shapes this adapter cannot safely edit, never to police the rest of
 * a user's config.
 */
declare const OhMyPoshConfigSchema: z.ZodObject<{
    palette: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    blocks: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
}, z.core.$catchall<z.ZodUnknown>>;
export type OhMyPoshConfig = z.infer<typeof OhMyPoshConfigSchema>;
/**
 * Whether `config`'s own palette table already carries every one of the six
 * role values `scheme` resolves to right now — the same
 * `resolveRoleHexes(scheme)` call recoloredPaletteTable itself makes on
 * apply, so a missing or mismatched key means this target has drifted from
 * whatever pack `ch` last recorded as active. See CHM-27.
 *
 * This takes `scheme`, not a pack's own precomputed role table: CHM-88 found
 * four bundled packs (ayu-light, everforest-light, solarized-light,
 * tokyo-night-light) whose stored "oh-my-posh" payload no longer matched a
 * fresh `resolveRoleHexes(scheme)` — the role-resolution pipeline had moved
 * on since those packs were last built, and nothing rebuilt them. Comparing
 * against that stale payload reported drift on a machine that had just been
 * correctly, freshly applied. See adapters/herdr.ts's herdrMatchesScheme,
 * which hit the same gap for the same reason.
 */
export declare function ohMyPoshMatchesScheme(config: OhMyPoshConfig, scheme: Scheme): boolean;
export interface OhMyPoshAdapter {
    detect(): boolean;
    read(): OhMyPoshConfig;
    /** Returns a one-sentence notice when applying created the shell's profile from scratch — see CHM-39's "say which path it would create and why" — or undefined when it already existed. */
    apply(scheme: Scheme): string | undefined;
    reload(): string | undefined;
}
/**
 * What repairing every segment's own foreground against its own
 * background(s) produced: the config's own "blocks", with any offending
 * segment repointed at a repaired copy of its foreground key, and the new
 * palette entries those copies need. The entries are additions, never
 * replacements of the shared key they were copied from — see
 * SEGMENT_FOREGROUND_REPAIR_SUFFIX.
 */
interface SegmentForegroundRepairResult {
    readonly blocks: readonly unknown[];
    readonly additionalPaletteEntries: Readonly<Record<string, string>>;
}
/**
 * Resolves every segment's own foreground and background(s) through
 * `paletteTable`, and requires TEXT_MIN_RATIO between them (see
 * repairForegroundAgainstBackgrounds). CHM-37 kept every one of a scheme's
 * own roles distinct from every other, but never checked the one pairing
 * that actually renders together — a segment's own foreground against its
 * own background — so a light role could still land on a light background.
 * See CHM-40.
 *
 * Every reference to a key Chameleon generated on an earlier apply is
 * normalized back to its true source key first (see
 * withGeneratedForegroundReferencesNormalized), so this always repairs from
 * the source key's own fresh colour rather than from an already-repaired
 * copy of it — see CHM-43. A source key stays a single, shared colour
 * across every segment that pairs it with the same backgrounds — two
 * segments failing the exact same way share one override, named
 * deterministically from the source key and which distinct background
 * signature this is for that key (see overrideKeysBySignatureFor), never
 * from which segment happened to fail first. Two segments pairing the same
 * source key against genuinely different backgrounds still get different
 * overrides: nothing ties one segment's own fix to what an unrelated
 * segment sharing the same foreground key happens to need, since Oh My Posh
 * evaluates a segment's `foreground`/`foreground_templates` completely
 * independently of its `background`/`background_templates` — there is no
 * safe way to hand every usage of a source key one shared colour without
 * risking it landing illegibly on a background it was never checked
 * against. repairForegroundAgainstBackgrounds already searches for the one
 * colour that reads against every one of a single signature's candidates at
 * once, and ships its best effort even on the rare set no single colour can
 * satisfy simultaneously — closer to legible than the original, even where
 * it cannot clear the floor against all of them at once.
 *
 * A segment with no resolvable background (no `background`/
 * `background_templates` field, or neither names a key `paletteTable`
 * defines) is left alone — there is nothing to check its foreground
 * against. A block or a segment this walk does not recognise (missing a
 * `segments` array, or not an object at all) is passed through completely
 * untouched, never dropped — this reads the config's own raw, unvalidated
 * JSON rather than Chameleon's narrower `ch edit` layout model, precisely so
 * a block type that model does not parse (e.g. "rprompt") still survives an
 * apply.
 */
export declare function repairSegmentForegrounds(rawBlocks: readonly unknown[], paletteTable: Readonly<Record<string, string>>): SegmentForegroundRepairResult;
/** Where Chameleon's single owned config lives — the one file every theme apply rewrites, and the one path the profile's own init line ever names. */
export declare function defaultOwnedConfigPath(): string;
/**
 * The config Chameleon would seed its owned copy from right now, and its raw
 * text — undefined when none is discoverable yet (see resolveConfigPath).
 * Exists for adapters/original-snapshot.ts (CHM-71): the one-time snapshot
 * taken before Chameleon's very first apply must capture this file exactly
 * as the user had it, before ensureOhMyPoshOwnedConfigSeeded ever copies it
 * into Chameleon's own owned path — after that copy, the discovered config
 * and the owned one are two independent files with two different futures,
 * and only this, the pre-copy original, is what `chm original` restores.
 */
export declare function discoverPreOwnedOhMyPoshConfig(profilePath: string, shell: Shell): {
    path: string;
    text: string;
} | undefined;
/**
 * Seeds `ownedConfigPath` the first time anything is ever applied, by
 * copying whatever config was active before Chameleon existed — discovered
 * via $POSH_CONFIG/$POSH_THEME, or failing that, `profilePath`'s own
 * pre-existing `oh-my-posh init` line (see resolveConfigPath). A no-op once
 * `ownedConfigPath` already exists: every apply after the first just
 * recolours that same file in place, and there is nothing left to
 * (re-)discover. Runs migrateAwayFromBundledPromptLayout first, so a machine
 * still carrying CHM-63's deleted prompt-layout state lands back on its own
 * prompt before this seeding check ever runs — see that function's own doc
 * comment.
 *
 * A discovered config whose segments reference no palette key at all — every
 * foreground a literal hex, the norm among Oh My Posh's own bundled themes —
 * is copied in exactly like any other: recolorConfigInto's own
 * liftLiteralForegroundsToPalette lifts those literal hexes into palette
 * keys on the very next apply, the same apply that seeded this file in the
 * first place, so nothing further needs asking for. CHM-74 shipped that lift
 * but only reachable through an explicit `chm reseed`, leaving this path
 * refusing to seed a config the very next line was able to fix — see CHM-87.
 * `chm reseed <path>` (reseedOhMyPoshOwnedConfig) still exists, for pointing
 * Chameleon at a different config on purpose.
 */
export declare function ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath: string, profilePath: string, shell: Shell): string;
/**
 * Re-seeds Chameleon's owned Oh My Posh config from `sourceConfigPath`,
 * overwriting whatever it owned before — CHM-74's supported answer to "which
 * config gets seeded when several exist": rather than guessing again from
 * whichever shell happens to run `chm` next, a person names the file
 * outright. This stays the supported alternative to hand-deleting
 * chameleon.omp.json and hoping the next apply discovers the right thing on
 * its own, even now that ensureOhMyPoshOwnedConfigSeeded seeds a literal-hex
 * config automatically too (CHM-87) — the two answer different questions:
 * automatic seeding picks up whatever config was already active, this
 * points Chameleon at a different one on purpose. Never themes the freshly
 * seeded file itself: the next `chm <theme>` (or a plain re-apply of
 * whatever is already active) does that, the same as any other apply — see
 * recolorConfigInto's own liftLiteralForegroundsToPalette for what makes
 * that safe even for a config with no palette reference at all.
 */
export declare function reseedOhMyPoshOwnedConfig(sourceConfigPath: string, ownedConfigPath?: string): void;
/**
 * Every foreign palette key's own true original hex — CHM-90's fix for a
 * key recolouring from whatever pack applied last rather than from the one
 * it was actually authored under (see recolorConfigInto's own
 * originalForeignPalette). Defaults to {} for a seed-state file written
 * before this ticket, and starts at {} on every fresh seed or reseed (see
 * writeOhMyPoshSeedState) — either way there is nothing recorded yet, and
 * recolorConfigInto treats a key missing here exactly like one this file
 * never existed for: today's live value is adopted as its original,
 * starting now. recordOriginalPaletteHexes is what fills this in, once per
 * apply, after every key that apply touched.
 */
declare const OhMyPoshSeedStateSchema: z.ZodObject<{
    seededFromPath: z.ZodString;
    seededAtMs: z.ZodNumber;
    originalPaletteHexes: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
export type OhMyPoshSeedState = z.infer<typeof OhMyPoshSeedStateSchema>;
/**
 * Which config `ownedConfigPath` was seeded from, or undefined when it
 * cannot be read — a config seeded before this file existed (or migrated
 * from CHM-63's own deleted bundled prompt layout, see
 * migrateAwayFromBundledPromptLayout) never wrote one, and that must read as
 * "unknown", never as a guess or a crash.
 */
export declare function readOhMyPoshSeedState(ownedConfigPath?: string): OhMyPoshSeedState | undefined;
/**
 * `chm doctor`'s own view of the config Chameleon owns outright — CHM-74:
 * "reports which config Chameleon owns and which config it was seeded
 * from." Undefined before the very first seed, since there is nothing to
 * report yet.
 */
export interface OhMyPoshOwnedConfigStatus {
    readonly ownedConfigPath: string;
    readonly seededFromPath: string | undefined;
}
export declare function ohMyPoshOwnedConfigStatus(ownedConfigPath?: string): OhMyPoshOwnedConfigStatus | undefined;
/**
 * Builds the Oh My Posh adapter. `configPath` defaults to Chameleon's own
 * fixed owned path; `profilePath` defaults to its real pwsh location;
 * `shell` defaults to "pwsh", matching that default. All three are only
 * ever overridden by tests, which point them at fixture copies so nothing
 * here touches a real profile or config — real callers instead use
 * createDefaultOhMyPoshAdapter, which resolves the shell `ch` is actually
 * running in and the profile that goes with it.
 *
 * `apply` seeds `configPath` first (ensureOhMyPoshOwnedConfigSeeded) — a
 * no-op once that file already exists, which is the steady state every test
 * built on this function's own fixture paths runs in, and every real apply
 * after the very first.
 */
export declare function createOhMyPoshAdapter(configPath?: string, profilePath?: string, shell?: Shell): OhMyPoshAdapter;
/**
 * Builds the Oh My Posh adapter for whichever shell `ch` is actually running
 * in — the real entry point every caller besides a test uses. Resolving the
 * shell here, rather than in createOhMyPoshAdapter's own parameter defaults,
 * is what lets that function's defaults stay the fixed "pwsh" a test relies
 * on without having to pass a shell of its own. See CHM-25.
 */
export declare function createDefaultOhMyPoshAdapter(): OhMyPoshAdapter;
/**
 * Every segment type Oh My Posh's own JSON schema accepts — the
 * `definitions.segment.properties.type.enum` list from
 * JanDeDobbeleer/oh-my-posh's `themes/schema.json` (main branch, vendored
 * here 2026-09-04), not Chameleon's own curated subset. CHM-16: a curated
 * ten-type list rejected exactly what people put in a real prompt — node,
 * python, rust and the rest of Oh My Posh's language segments. This is a
 * point-in-time snapshot rather than a live fetch — `ch` is a CLI that has
 * to work offline — but every segment type Oh My Posh shipped as of that
 * date is covered, and `ch edit` still reads, reorders and moves any type
 * it does not know, same as before.
 */
export declare const SEGMENT_TYPES: readonly ["angular", "antigravity", "argocd", "aspire", "aurelia", "aws", "az", "azd", "azfunc", "battery", "bazel", "brewfather", "buf", "bun", "carbonintensity", "cds", "cf", "cftarget", "claude", "clojure", "cmake", "copilot", "copilot_cli", "connection", "crystal", "dart", "deno", "docker", "dotnet", "dvc", "elixir", "executiontime", "firebase", "flutter", "fortran", "fossil", "gcp", "git", "gitversion", "go", "gradle", "haskell", "helm", "http", "ipify", "java", "jujutsu", "julia", "kotlin", "kubectl", "language", "lastfm", "lua", "mercurial", "mojo", "mvn", "nba", "nbgv", "nightscout", "nim", "nix-shell", "node", "npm", "nx", "ocaml", "orthodoxcal", "os", "owm", "path", "perl", "php", "plastic", "pnpm", "project", "pulumi", "python", "quasar", "r", "ramadan", "react", "root", "ruby", "rust", "sapling", "session", "shell", "sitecore", "spotify", "status", "strava", "svelte", "svn", "swift", "sysinfo", "talosctl", "taskwarrior", "tauri", "terraform", "text", "time", "todoist", "ui5tooling", "umbraco", "uno", "unity", "upgrade", "v", "vala", "vimode", "wakatime", "winget", "winreg", "withings", "xmake", "yarn", "ytm", "zig", "zvm"];
export type SegmentType = (typeof SEGMENT_TYPES)[number];
/** Whether `candidateType` is one of SEGMENT_TYPES — the boundary check `ch edit add`'s own `--type` flag must clear, same pattern as isKnownRole for `--foreground`/`--background`. */
export declare function isSegmentType(candidateType: string): candidateType is SegmentType;
/**
 * One entry in a block's segment list. `type`, `foreground` and
 * `background` are all this adapter needs to reason about; every other
 * property a real segment carries — style, properties, template, … — is
 * unvalidated and carried through untouched, the same "validate only what we
 * edit" contract as OhMyPoshConfigSchema above.
 */
declare const LayoutSegmentSchema: z.ZodObject<{
    type: z.ZodString;
}, z.core.$catchall<z.ZodUnknown>>;
export type LayoutSegment = z.infer<typeof LayoutSegmentSchema>;
/** "left" is the prompt's own block; "right" is the status line — see CLAUDE.md's "why" for CHM-8. */
export type LayoutBlockName = "left" | "right";
/**
 * One block of the config's "blocks" array that `ch edit` can address.
 * `extra` carries every block-level property beyond type/alignment/segments
 * — Oh My Posh's schema also allows a block "newline", "overflow", "filler"
 * and more — untouched, so editing one block's segments never drops what a
 * sibling block declared about itself. See CHM-16: the real "chips"
 * community theme turns its second "left" block into its own prompt row
 * with "newline": true, and losing that on an unrelated edit would silently
 * break the very theme this ticket exists to support.
 */
export interface LayoutBlock {
    readonly alignment: LayoutBlockName;
    readonly segments: readonly LayoutSegment[];
    readonly extra: Readonly<Record<string, unknown>>;
}
/**
 * Chameleon's own model of a config's segment layout, in the config's own
 * block order. CHM-16: a real theme is not limited to one block per side —
 * "chips" carries two "left" blocks (a main prompt row and a second row
 * toggled on by "newline": true) and one "right" — and document order is
 * what keeps a block that starts a new row rendering after, not before, the
 * block sharing its own row. Never carries a colour beyond a role
 * reference, and never carries the palette table itself — see CHM-8's
 * "operate on the layout file only; never touch the palette."
 */
export interface Layout {
    readonly blocks: readonly LayoutBlock[];
}
/** Reads Chameleon's owned config's layout — the left and right-hand segment blocks `ch edit` operates on. */
export declare function readOhMyPoshLayout(configPath?: string | undefined): Layout;
/** Writes `layout` back to Chameleon's owned config, backed up first. Not part of the adapter interface — editing the layout is `ch edit`'s job, never a step in the theming pipeline. */
export declare function writeOhMyPoshLayout(layout: Layout, configPath?: string | undefined): void;
/** Builds a brand-new segment of `type`, coloured entirely by role reference — never a literal hex. `backgroundRole` is genuinely optional: plenty of real segments set only a foreground and let the block's own styling supply the rest. */
export declare function buildLayoutSegment(type: SegmentType, foregroundRole: Role, backgroundRole?: Role): LayoutSegment;
/**
 * Every block on `alignment`'s own side, in document order — CHM-16's
 * "addressing them unambiguously": what a caller uses to decide whether a
 * `--block-index` needs to be asked for at all, since a side with exactly
 * one block never needs to name it.
 */
export declare function layoutBlocksOnSide(layout: Layout, alignment: LayoutBlockName): readonly LayoutBlock[];
/**
 * Inserts `segment` into the `blockIndex`-th block of `alignment` at
 * `atIndex`, defaulting to the end of that block — creating the block
 * itself first when `blockIndex` names a fresh one, see
 * resolveBlockForWrite. Pure — the caller is responsible for reading the
 * current layout first and writing the result back.
 */
export declare function addSegment(layout: Layout, alignment: LayoutBlockName, blockIndex: number, segment: LayoutSegment, atIndex?: number): Layout;
/** Removes the segment at `atIndex` from the `blockIndex`-th block of `alignment`. Pure — see addSegment. */
export declare function removeSegment(layout: Layout, alignment: LayoutBlockName, blockIndex: number, atIndex: number): Layout;
/** Moves the segment at `fromIndex` to `toIndex` within the `blockIndex`-th block of `alignment`, shifting the segments between them. Pure — see addSegment. */
export declare function reorderSegment(layout: Layout, alignment: LayoutBlockName, blockIndex: number, fromIndex: number, toIndex: number): Layout;
/**
 * Moves the segment at `fromIndex` in the `fromBlockIndex`-th block of
 * `fromAlignment` into the `toBlockIndex`-th block of `toAlignment`, at
 * `toIndex` (defaulting to the end). This is what makes a segment cross
 * from the prompt into the status line, or between two blocks on the same
 * side — the one operation neither addSegment nor removeSegment can express
 * alone, since a segment moving blocks has to leave one array and land in
 * the other atomically or a caller could observe it in neither. The
 * destination block is created fresh, the same as addSegment, when
 * `toBlockIndex` names one that does not exist yet.
 */
export declare function moveSegmentBetweenBlocks(layout: Layout, fromAlignment: LayoutBlockName, fromBlockIndex: number, fromIndex: number, toAlignment: LayoutBlockName, toBlockIndex: number, toIndex?: number): Layout;
/**
 * Restores the config and the profile from the backups written by the most
 * recent `apply`. Not part of the adapter interface — undo is a user
 * command, not a step in the theming pipeline — but it lives beside the
 * adapter because the backup files' locations and format are this file's
 * business.
 */
export declare function undoOhMyPosh(configPath?: string | undefined, profilePath?: string): void;
export {};
