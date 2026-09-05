import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseJsonc, type Node } from "jsonc-parser";
import { z } from "zod";
import { isKnownRole, ROLES, type Role } from "../constants.js";
import { repairForegroundAgainstBackgrounds, resolveRoleHexes } from "../palette/repair.js";
import { recoloredHexFor } from "../palette/role-mapping.js";
import type { Scheme } from "../palette/scheme.js";
import {
  buildPropertyBlockContent,
  dedupeConflict,
  detectLineEnding,
  findPropertyNode,
  parseJsonTree,
  upsertMarkedBlock,
} from "./marked-json-edit.js";
import { detectShell, ohMyPoshProfilePathFor, stateDir, type Shell } from "./platform.js";

/** Suffix for the pre-apply copy of a config or profile file that `undoOhMyPosh` restores from. */
const BACKUP_FILE_SUFFIX = ".chameleon-backup";

/** Oh My Posh's own CLI binary name, resolved via PATH — see detectOhMyPosh. */
const OH_MY_POSH_BINARY_NAME = "oh-my-posh";

/** winget's package identifier for Oh My Posh, used to build the one-line install command `ch doctor` offers. */
export const OH_MY_POSH_WINGET_PACKAGE_ID = "JanDeDobbeleer.OhMyPosh";

/** File name of the pointer `apply` writes and every shell's own live-reload hook reads. */
const POINTER_FILE_NAME = "oh-my-posh-pointer.json";

/**
 * Every edit this adapter makes to a shell's profile is wrapped in this pair
 * — the JSON marker pair from marked-json-edit.ts is a `//` comment, which
 * none of PowerShell, bash or zsh understand, so a profile gets its own
 * markers in the `#` comment syntax all three share. Clink's own hook is Lua,
 * whose comment syntax is `--`, so it gets its own pair — see LUA_MARKER_BEGIN/END.
 */
const PROFILE_MARKER_BEGIN = "# ch:begin";
const PROFILE_MARKER_END = "# ch:end";

const LUA_MARKER_BEGIN = "-- ch:begin";
const LUA_MARKER_END = "-- ch:end";

/**
 * The slice of a .omp.json config this adapter actually depends on.
 * Everything else (segments, blocks, console title template, …) is
 * unvalidated and passed through untouched — this schema exists only to
 * catch shapes this adapter cannot safely edit, never to police the rest of
 * a user's config.
 */
const OhMyPoshConfigSchema = z
  .object({
    palette: z.record(z.string(), z.string()).optional(),
    blocks: z.array(z.unknown()).optional(),
  })
  .catchall(z.unknown());

export type OhMyPoshConfig = z.infer<typeof OhMyPoshConfigSchema>;

/**
 * Whether `config`'s own palette table already carries every one of
 * `roleHexes`' six role values — the same keys recoloredPaletteTable itself
 * writes on apply, so a missing or mismatched key means this target has
 * drifted from whatever pack `ch` last recorded as active. See CHM-27.
 */
export function ohMyPoshMatchesRoleHexes(config: OhMyPoshConfig, roleHexes: Readonly<Record<Role, string>>): boolean {
  return ROLES.every((role) => config.palette?.[role] === roleHexes[role]);
}

const PointerSchema = z.object({
  configPath: z.string().min(1),
  updatedAtMs: z.number(),
});

export interface OhMyPoshAdapter {
  detect(): boolean;
  read(): OhMyPoshConfig;
  /** Returns a one-sentence notice when applying created the shell's profile from scratch — see CHM-39's "say which path it would create and why" — or undefined when it already existed. */
  apply(scheme: Scheme): string | undefined;
  reload(): string | undefined;
}

/**
 * Oh My Posh's own `init` sets POSH_CONFIG in the environment of every shell
 * it initialises, pointed at whichever config that shell is running. `ch`
 * inherits it from its parent shell, the same way it would inherit any
 * other environment variable — there is no separate "active config" file to
 * read, the way Windows Terminal has settings.json. POSH_THEME was the name
 * current Oh My Posh (31.x) replaced with POSH_CONFIG; it is kept as a
 * fallback for an older install, never relied on alone — see CHM-36, where
 * every real apply failed because current Oh My Posh never sets it.
 */
function defaultConfigPath(): string | undefined {
  return process.env["POSH_CONFIG"] || process.env["POSH_THEME"];
}

/**
 * Oh My Posh's own name for `shell` in its `init` subcommand — what a
 * profile's init line actually reads. "powershell" is accepted alongside
 * "pwsh" since some profiles still carry it from an older `oh-my-posh init
 * powershell`. cmd.exe has no `init` subcommand of its own — its hook is a
 * Clink script instead, see buildClinkHookScript — so there is nothing to
 * look for there.
 */
function initShellNamesFor(shell: Shell): readonly string[] {
  if (shell === "pwsh") return ["pwsh", "powershell"];
  if (shell === "bash") return ["bash"];
  if (shell === "zsh") return ["zsh"];
  return [];
}

/**
 * Matches an `... init <shell> ... --config <path>` invocation anywhere on
 * a single line of a shell profile, regardless of what names the binary
 * before "init" — a bare "oh-my-posh", a variable a profile assigned
 * earlier (`$ohMyPoshExe`, an absolute path), or nothing recognisable at
 * all. "init <shell> ... --config" is the one substring every documented
 * invocation shares. Requiring the literal text "oh-my-posh init" missed
 * exactly this: a reporter's own profile routed the binary through a
 * variable first — see CHM-36. `shellNames` is always one of
 * initShellNamesFor's own fixed, alphabetic return values, never user
 * input, so building the alternation without escaping is safe.
 *
 * An unquoted path — the common bash/zsh shape, `--config $HOME/x.json`
 * inside an `eval "$(... )"` with no quotes of its own — stops short of
 * `)`, `"`, `'` and `|`, the characters that routinely sit right up against
 * the path with no space: the closing `)"` of the `eval` itself, or a
 * trailing `| Invoke-Expression`. A quoted path (either quote style) simply
 * stops at its own matching quote and is free to contain any of those.
 */
function initConfigArgumentPattern(shellNames: readonly string[]): RegExp {
  const shellAlternation = shellNames.join("|");
  return new RegExp(`\\binit\\s+(?:${shellAlternation})\\b[^\\r\\n]*?--config\\s+(?:"([^"]+)"|'([^']+)'|([^\\s"')|]+))`, "i");
}

/**
 * Expands the environment-variable and home-directory references a shell
 * profile's own `--config` argument is written with — PowerShell's
 * `$env:VAR`, and bash/zsh's `$VAR`, `${VAR}` and a leading `~` — into the
 * literal path Chameleon needs to open the file. A reference to a variable
 * that is not actually set is left unresolved rather than guessed, so the
 * existsSync check that follows correctly reports it as missing.
 */
function expandPathReferences(rawPath: string, shell: Shell): string {
  if (shell === "pwsh") {
    return rawPath.replace(/\$env:(\w+)/gi, (reference, name: string) => process.env[name] ?? reference);
  }
  const withVariablesExpanded = rawPath.replace(
    /\$\{(\w+)\}|\$(\w+)/g,
    (reference, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare;
      return (name ? process.env[name] : undefined) ?? reference;
    },
  );
  return withVariablesExpanded.startsWith("~") ? path.join(homedir(), withVariablesExpanded.slice(1)) : withVariablesExpanded;
}

/**
 * Removes every block Chameleon itself wrote — everything from a `ch:begin`
 * marker up to and including its matching `ch:end`, greedy for neither —
 * before a profile's text is searched for a user-written `oh-my-posh init`
 * line. Chameleon's own pwsh hook contains the literal text `oh-my-posh init
 * pwsh --config $chameleonPointer.configPath` (see
 * buildSetPoshContextBlock), which otherwise matches
 * initConfigArgumentPattern just as well as a real init line does, and gets
 * read back as a config path pointing nowhere real — see CHM-39, where that
 * produced `ENOENT ... \$chameleonPointer.configPath`. A profile with an
 * unterminated marker (a `ch:begin` with no `ch:end`) is left as-is here;
 * upsertProfileBlock is what refuses to write that shape in the first place.
 */
function withoutOwnedMarkerBlocks(profileText: string): string {
  const ownedBlockPattern = new RegExp(`${PROFILE_MARKER_BEGIN}[\\s\\S]*?${PROFILE_MARKER_END}`, "g");
  return profileText.replace(ownedBlockPattern, "");
}

/**
 * Falls back to the config path a shell profile's own `oh-my-posh init`
 * line names, for a shell Oh My Posh has never actually initialised in this
 * session — no POSH_CONFIG or POSH_THEME to read yet, but the path is
 * written verbatim in the profile that would set them (see CHM-36's "How").
 * Returns undefined, never throws, when the profile does not exist or names
 * no `--config` argument for this shell — the caller, which knows
 * everything else it already tried, is what reports that absence.
 */
function configPathFromProfile(profilePath: string, shell: Shell): string | undefined {
  const shellNames = initShellNamesFor(shell);
  if (shellNames.length === 0 || !existsSync(profilePath)) return undefined;

  const profileText = withoutOwnedMarkerBlocks(readFileSync(profilePath, "utf8"));
  const match = profileText.match(initConfigArgumentPattern(shellNames));
  const rawPath = match?.[1] ?? match?.[2] ?? match?.[3];
  return rawPath ? expandPathReferences(rawPath, shell) : undefined;
}

/**
 * The config path an adapter actually applies to and reads: whatever the
 * environment already names, falling back to `profilePath`'s own init line
 * only when neither POSH_CONFIG nor POSH_THEME is set. This is a plain
 * function call inside createOhMyPoshAdapter's own body, not another
 * parameter default — a parameter default cannot see `profilePath`, the
 * parameter declared after it, and every caller (test or real) needs the
 * fallback to run against the exact profile it passed in, not the host's
 * real one. See CHM-36.
 */
function resolveConfigPath(configPath: string | undefined, profilePath: string, shell: Shell): string | undefined {
  // `||`, not `??` — an unset POSH_CONFIG/POSH_THEME can arrive here as an
  // empty string (defaultConfigPath's own `||` chain bottoms out at "" when
  // both env vars are literally set-but-empty, the shape a test's
  // vi.stubEnv(name, "") produces), and that must fall through to the
  // profile just the same as undefined would — every other emptiness check
  // in this file already treats "" and undefined alike (see `!configPath`
  // in applyOhMyPoshScheme and requireConfigPath).
  return configPath || configPathFromProfile(profilePath, shell);
}

/**
 * The interactive-startup file `shell`'s own live-reload hook belongs in —
 * PowerShell's per-host profile ($PROFILE, "CurrentUserAllHosts" would be
 * Profile.ps1 without the "Microsoft.PowerShell" prefix — Chameleon only
 * ever targets the per-host profile, since that is what oh-my-posh's own
 * install instructions wire up), bash's or zsh's own rc file, or — for
 * cmd.exe, which has no rc file of its own — the Clink script Chameleon
 * installs its hook as. See platform.ts's ohMyPoshProfilePathFor.
 */
function defaultProfilePath(shell: Shell = "pwsh"): string {
  return ohMyPoshProfilePathFor(shell);
}

function defaultPointerPath(): string {
  return path.join(stateDir(), POINTER_FILE_NAME);
}

function backupPathFor(targetPath: string): string {
  return `${targetPath}${BACKUP_FILE_SUFFIX}`;
}

/**
 * Oh My Posh is detected by its own installed binary, never by POSH_CONFIG
 * or POSH_THEME. Both are set per-shell by `oh-my-posh init`, so a shell
 * that has never run init — a fresh git-bash, cmd, or a pwsh before its
 * profile loads — would otherwise report Oh My Posh as missing even when it
 * is on PATH and fully configured elsewhere. See CHM-15, which supersedes
 * CHM-7 for exactly this false negative.
 */
function detectOhMyPosh(): boolean {
  const result = spawnSync(OH_MY_POSH_BINARY_NAME, ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

/**
 * Parses a .omp.json config — tolerating the comments a hand-edited file
 * carries — and validates just enough of its shape for this adapter to
 * trust. A config the user broke must say so by name, never crash and
 * never be silently overwritten.
 */
function readOhMyPoshConfig(configPath: string): OhMyPoshConfig {
  const rawText = readFileSync(configPath, "utf8");
  const parsed: unknown = parseJsonc(rawText, [], { allowTrailingComma: true });
  const validated = OhMyPoshConfigSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`${configPath} is not an Oh My Posh config Chameleon understands: ${validated.error.message}`);
  }
  return validated.data;
}

/**
 * Parses `text`'s root as a JSON object, removes any plain (non-Chameleon-
 * owned) property named `key`, and reparses — the shared first half of
 * every root-level marked-block upsert in this file: "palette" here and
 * "blocks" below both key off a root-level property this way, so this is
 * where that shape lives rather than twice.
 */
function dedupeRootProperty(configPath: string, text: string, key: string): { dedupedText: string; container: Node } {
  const root = parseJsonTree(configPath, text);
  if (root.type !== "object") {
    throw new Error(`${configPath}'s root is not a JSON object`);
  }

  const dedupedText = dedupeConflict(text, root, findPropertyNode(root, key), key);
  const container = parseJsonTree(configPath, dedupedText);
  if (container.type !== "object") {
    throw new Error(`${configPath}'s root is not a JSON object`);
  }
  return { dedupedText, container };
}

/**
 * Swaps the config's top-level "palette" lookup table for `paletteTable`,
 * scoped between ch:begin/ch:end. Never touches "blocks" — the segment
 * list — which is what keeps a theme swap byte-identical there: every
 * segment already resolves its colour through a `p:` reference, so a new
 * palette table alone is enough to repaint it.
 */
function upsertPaletteTable(configPath: string, text: string, paletteTable: Record<string, string>): string {
  const eol = detectLineEnding(text);
  const { dedupedText, container } = dedupeRootProperty(configPath, text, "palette");
  return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent("palette", paletteTable, eol), eol, "palette");
}

/**
 * Recolours every key the config's existing palette already carries to the
 * new theme, and adds whichever of Chameleon's own six roles it does not
 * carry yet — never removing a key. See CHM-31: a real prompt defines its
 * own semantic keys and its segments reference those keys by name, not by
 * Chameleon's role names, so replacing the table with just the six roles
 * deleted every key the prompt actually used and left it colourless.
 *
 * A key Chameleon itself generated on a previous apply (see
 * isGeneratedOverrideKey) is dropped here rather than carried forward and
 * recoloured — repairSegmentForegrounds regenerates whichever of these this
 * apply still needs, from the true source key's own fresh colour, under the
 * same stable name. Carrying the old one forward instead is CHM-43's own
 * bug: a generated key recoloured like an ordinary source key, then
 * re-suffixed if it still failed, compounds one generation of "-legible" per
 * apply.
 *
 * A key that is already one of Chameleon's own roles (from a layout `ch
 * edit` built, or a previous apply) is recoloured by that same role, never
 * reclassified by its current colour — its name already says exactly what
 * it is. Every other key is recoloured by recoloredHexFor, which retints its
 * own colour into the new theme's space rather than snapping it onto one of
 * six roles — see CHM-37: that snap once collapsed 46 of a real 47-key
 * prompt palette onto three or four colours, leaving its segments illegible.
 */
function recoloredPaletteTable(existingPalette: Record<string, string> | undefined, resolvedRoleHexes: Record<Role, string>): Record<string, string> {
  const recoloredExisting = Object.fromEntries(
    Object.entries(existingPalette ?? {})
      .filter(([key]) => !isGeneratedOverrideKey(key))
      .map(([key, hex]) => [key, isKnownRole(key) ? resolvedRoleHexes[key] : recoloredHexFor(key, hex, resolvedRoleHexes)]),
  );
  const missingRoles = ROLES.filter((role) => !(role in recoloredExisting));
  const additions = Object.fromEntries(missingRoles.map((role) => [role, resolvedRoleHexes[role]]));
  return { ...recoloredExisting, ...additions };
}

/** Builds the `p:<role>` reference pattern shared by every scan for a palette reference — either across a whole config's own text (palettesReferencedIn) or inside one segment field's own value (paletteReferencesIn). */
function paletteReferencePattern(): RegExp {
  return new RegExp(`${PALETTE_REF_PREFIX}([A-Za-z0-9_-]+)`, "g");
}

/** Every distinct role name a `p:role` reference names, anywhere in `configText` — segments, transient_prompt, secondary_prompt, and any template string a theme author wrote one into. A plain text scan, not a JSON walk, because a reference can sit inside a Go template string (see chips.omp.json's background_templates) that a JSON parser sees only as opaque text. */
function palettesReferencedIn(configText: string): ReadonlySet<string> {
  const referencedRoles = new Set<string>();
  for (const match of configText.matchAll(paletteReferencePattern())) {
    const referencedRole = match[1];
    if (referencedRole !== undefined) referencedRoles.add(referencedRole);
  }
  return referencedRoles;
}

/** Every `p:role` reference `fieldValue` itself carries — zero for anything that is not a string, one for a plain "foreground"/"background" field, and possibly several for a `*_templates` string, which can name a different role per conditional branch (see chips.omp.json's foreground_templates). */
function paletteReferencesIn(fieldValue: unknown): string[] {
  if (typeof fieldValue !== "string") return [];
  return [...fieldValue.matchAll(paletteReferencePattern())].flatMap((match) => (match[1] !== undefined ? [match[1]] : []));
}

/**
 * Throws, naming every offending key, when `configText` references a
 * palette key `paletteTable` does not define. This is the assertion CHM-31
 * asks for: an undefined `p:` reference is exactly the failure mode that
 * left a real prompt colourless, and it must never reach disk silently.
 */
function assertNoDanglingPaletteReferences(configPath: string, configText: string, paletteTable: Record<string, string>): void {
  const undefinedReferences = [...palettesReferencedIn(configText)].filter((referencedRole) => !(referencedRole in paletteTable));
  if (undefinedReferences.length > 0) {
    throw new Error(`${configPath} would reference undefined palette key(s): ${undefinedReferences.join(", ")}`);
  }
}

/**
 * Suffix CHM-40 gives a foreign palette key's own repaired copy, when a
 * segment's own background makes that key's recoloured value illegible
 * there. The shared key itself is never touched — every other segment still
 * reading fine off it keeps doing exactly that — only the segment(s) that
 * failed get repointed at a copy carrying the fix. See CHM-40's "adjust the
 * foreground role for that segment rather than the shared palette entry."
 *
 * A source key's own override is named `<sourceKey>-legible`, or that name
 * with a "-2", "-3", … counter when the same source key is paired with more
 * than one genuinely different set of backgrounds in the same apply — see
 * overrideKeysBySignatureFor, which orders that counter by the backgrounds'
 * own content rather than by which segment happened to fail first, so the
 * same set of colours always assigns the same names. What CHM-43 actually
 * fixes is not this counter, but a generated key being read back as an
 * ordinary source key on the next apply: that compounded a fresh "-legible"
 * onto every one of these every time the user switched themes —
 * c-badge-text-legible-2 becoming c-badge-text-legible-2-legible and so on,
 * without bound. See GENERATED_OVERRIDE_KEY_SUFFIX_PATTERN and sourceKeyFor,
 * which recognise and unwind exactly that, and
 * withGeneratedForegroundReferencesNormalized, which stops it from
 * happening again.
 */
const SEGMENT_FOREGROUND_REPAIR_SUFFIX = "legible";

/**
 * Matches a generated override key's own suffix, including a counter a
 * pre-CHM-43 apply may have appended: "-legible", "-legible-2", "-legible-3".
 * Never matches a plain source key, which never carries this suffix on its
 * own.
 */
const GENERATED_OVERRIDE_KEY_SUFFIX_PATTERN = new RegExp(`-${SEGMENT_FOREGROUND_REPAIR_SUFFIX}(?:-\\d+)?$`);

/**
 * The source key `key` was generated from, unwinding every generation a
 * pre-CHM-43 apply piled onto it (see GENERATED_OVERRIDE_KEY_SUFFIX_PATTERN) —
 * "c-badge-text-legible-2-legible" unwinds to "c-badge-text". Returns `key`
 * unchanged when it carries no generated suffix at all, which is every
 * ordinary source key.
 */
function sourceKeyFor(key: string): string {
  let sourceKey = key;
  while (GENERATED_OVERRIDE_KEY_SUFFIX_PATTERN.test(sourceKey)) {
    sourceKey = sourceKey.replace(GENERATED_OVERRIDE_KEY_SUFFIX_PATTERN, "");
  }
  return sourceKey;
}

/** Whether `key` is itself a palette key Chameleon generated on a previous apply, rather than one a user or a theme author wrote — see sourceKeyFor. CHM-39's own root cause, repeated here: Chameleon's own output must never be read back as user input. */
function isGeneratedOverrideKey(key: string): boolean {
  return sourceKeyFor(key) !== key;
}

/**
 * The base palette key `sourceKey`'s own repaired copy is named from —
 * `overrideKeysBySignatureFor` uses this verbatim for the first background
 * signature a source key needs a fix for, and with a counter appended for
 * any further one. Deterministic in `sourceKey` alone, unlike the disambig-
 * uation this used to run against whatever else the palette table happened
 * to hold at the time — so an apply that needs the same fix again reuses
 * this exact name instead of minting another. See CHM-43.
 */
function overrideKeyFor(sourceKey: string): string {
  return `${sourceKey}-${SEGMENT_FOREGROUND_REPAIR_SUFFIX}`;
}

/** One raw segment object, exactly as a config's own "blocks" array writes it — every property beyond the four this repair reads (`foreground`, `foreground_templates`, `background`, `background_templates`) is carried through unknown and untouched. */
type RawSegment = Readonly<Record<string, unknown>>;

/** `rawBlock`'s own "segments" array, when it has one — undefined for a block this walk does not recognise (missing a `segments` array, or not an object at all), which every block-walking function below passes straight through untouched rather than dropping. See parseLayoutBlocks/blocksFromLayout for the same "rprompt and friends survive" contract on `ch edit`'s own, narrower layout model. */
function segmentsOf(rawBlock: unknown): readonly unknown[] | undefined {
  if (typeof rawBlock !== "object" || rawBlock === null) return undefined;
  const segments = (rawBlock as RawSegment)["segments"];
  return Array.isArray(segments) ? segments : undefined;
}

/** `rawBlock` with every one of its own segments passed through `transformSegment` — the "walk a block's segments, leave anything else untouched" shape withGeneratedBlockForegroundsNormalized and withOverridesAppliedToBlock both need, differing only in which transform they run per segment. */
function withSegmentsTransformed(rawBlock: unknown, transformSegment: (segment: RawSegment) => RawSegment): unknown {
  const segments = segmentsOf(rawBlock);
  if (segments === undefined) return rawBlock;
  return {
    ...(rawBlock as RawSegment),
    segments: segments.map((rawSegment: unknown) => (typeof rawSegment === "object" && rawSegment !== null ? transformSegment(rawSegment as RawSegment) : rawSegment)),
  };
}

/** Every hex `segment`'s own `background`/`background_templates` fields could resolve to through `paletteTable` — see paletteReferencesIn. A reference `paletteTable` does not define is skipped here; assertNoDanglingPaletteReferences is what reports that, once, by name. */
function segmentBackgroundHexes(segment: RawSegment, paletteTable: Readonly<Record<string, string>>): string[] {
  const backgroundTemplates = Array.isArray(segment["background_templates"]) ? segment["background_templates"] : [];
  const backgroundKeys = [...paletteReferencesIn(segment["background"]), ...backgroundTemplates.flatMap(paletteReferencesIn)];
  return backgroundKeys.flatMap((key) => (paletteTable[key] !== undefined ? [paletteTable[key]] : []));
}

/** Every distinct palette key `segment`'s own `foreground`/`foreground_templates` fields could render — see paletteReferencesIn. */
function segmentForegroundKeys(segment: RawSegment): string[] {
  const foregroundTemplates = Array.isArray(segment["foreground_templates"]) ? segment["foreground_templates"] : [];
  return [...new Set([...paletteReferencesIn(segment["foreground"]), ...foregroundTemplates.flatMap(paletteReferencesIn)])];
}

/** `fieldValue` with every `p:foregroundKey` reference swapped for `p:overrideKey` — the plain-string case for a `foreground` field, or one entry of a `foreground_templates` array. Anything else (a non-string value, or a template naming a different role entirely) survives untouched. */
function withRoleReferenceReplaced(fieldValue: unknown, foregroundKey: string, overrideKey: string): unknown {
  if (typeof fieldValue !== "string") return fieldValue;
  const ownReferencePattern = new RegExp(`${PALETTE_REF_PREFIX}${foregroundKey}(?![A-Za-z0-9_-])`, "g");
  return fieldValue.replace(ownReferencePattern, `${PALETTE_REF_PREFIX}${overrideKey}`);
}

/** `segment` with every reference to `foregroundKey`, in its own `foreground` and `foreground_templates` fields only, repointed at `overrideKey`. `background`/`background_templates` are never touched — a segment keeps rendering exactly the candidate colours it always did, just with legible text over them. */
function segmentWithForegroundRepointed(segment: RawSegment, foregroundKey: string, overrideKey: string): RawSegment {
  const foregroundTemplates = segment["foreground_templates"];
  return {
    ...segment,
    ...(segment["foreground"] !== undefined
      ? { foreground: withRoleReferenceReplaced(segment["foreground"], foregroundKey, overrideKey) }
      : {}),
    ...(Array.isArray(foregroundTemplates)
      ? { foreground_templates: foregroundTemplates.map((template) => withRoleReferenceReplaced(template, foregroundKey, overrideKey)) }
      : {}),
  };
}

/**
 * `segment` with every foreground reference to a key Chameleon generated on
 * a previous apply repointed back at the true source key it was generated
 * from. Runs before this apply recomputes anything, so a foreground that no
 * longer needs a fix reverts to its plain source key instead of carrying a
 * stale override forward forever, and one that still needs a fix is
 * measured fresh from the source key's own newly recoloured hex, not from
 * an already-repaired copy of it. See CHM-43: skipping this step is what let
 * a generated key get read back as an ordinary source key and re-suffixed
 * every apply.
 */
function withGeneratedForegroundReferencesNormalized(segment: RawSegment): RawSegment {
  return segmentForegroundKeys(segment)
    .filter((foregroundKey) => isGeneratedOverrideKey(foregroundKey))
    .reduce(
      (currentSegment, foregroundKey) => segmentWithForegroundRepointed(currentSegment, foregroundKey, sourceKeyFor(foregroundKey)),
      segment,
    );
}

/** `rawBlock` with every one of its segments' own foreground references normalized — see withGeneratedForegroundReferencesNormalized. A block missing a `segments` array, or not an object at all, is passed through untouched, the same as everywhere else this file walks "blocks". */
function withGeneratedBlockForegroundsNormalized(rawBlock: unknown): unknown {
  return withSegmentsTransformed(rawBlock, withGeneratedForegroundReferencesNormalized);
}

/**
 * A stable, order-independent fingerprint of one segment's own resolved
 * background hexes — de-duplicated and sorted, so two segments pairing the
 * same foreground key against the same set of backgrounds (in any order,
 * with any repeats) always produce the same signature, and therefore always
 * share one override — see overrideKeysBySignatureFor. Two segments whose
 * backgrounds actually differ get different signatures, and therefore
 * different overrides: a foreground shared across a badge segment and a git
 * segment can genuinely need two different repaired colours, since nothing
 * ties one segment's fix to what another segment happens to need.
 */
function backgroundSignatureFor(backgroundHexes: readonly string[]): string {
  return [...new Set(backgroundHexes)].sort().join(",");
}

/**
 * Adds `segment`'s own resolvable background hexes onto
 * `signaturesByForegroundKey`'s running collection, keyed first by every
 * foreground key `segment` carries and then by that segment's own
 * background signature — the accumulator repairSegmentForegrounds folds
 * every segment in the config into, so every distinct background set a
 * source key is ever paired against anywhere in the config is known before
 * any override is named. See CHM-43: naming an override the moment a
 * segment failed, in document order, made its name depend on where in the
 * config that segment happened to sit.
 */
function collectSegmentBackgroundHexes(
  segment: RawSegment,
  paletteTable: Readonly<Record<string, string>>,
  signaturesByForegroundKey: Map<string, Map<string, readonly string[]>>,
): void {
  const backgroundHexes = segmentBackgroundHexes(segment, paletteTable);
  if (backgroundHexes.length === 0) return;
  const signature = backgroundSignatureFor(backgroundHexes);

  for (const foregroundKey of segmentForegroundKeys(segment)) {
    const signaturesForKey = signaturesByForegroundKey.get(foregroundKey) ?? new Map<string, readonly string[]>();
    signaturesForKey.set(signature, backgroundHexes);
    signaturesByForegroundKey.set(foregroundKey, signaturesForKey);
  }
}

/**
 * What repairing one source key's foreground against every distinct
 * background signature it is ever paired with, anywhere in the config,
 * produced: the override key each signature needing a fix gets, keyed by
 * that signature. A signature that already clears TEXT_MIN_RATIO needs no
 * override at all, and carries no entry here.
 *
 * Every signature needing a fix gets `overrideKeyFor(foregroundKey)` itself,
 * or that name with a "-2", "-3", … counter, ordered by the signature text
 * — never by which segment happened to fail first. See CHM-43: sorting by
 * content rather than by document encounter order is what makes this
 * assignment reproducible from one apply to the next, given the same
 * colours, instead of depending on where in the config a failing segment
 * happened to sit.
 */
function overrideKeysBySignatureFor(
  foregroundKey: string,
  foregroundHex: string,
  backgroundHexesBySignature: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, { readonly overrideKey: string; readonly repairedHex: string }> {
  const repairedBySignature = [...backgroundHexesBySignature.entries()]
    .map(([signature, backgroundHexes]) => [signature, repairForegroundAgainstBackgrounds(foregroundHex, backgroundHexes)] as const)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([signatureA], [signatureB]) => (signatureA < signatureB ? -1 : signatureA > signatureB ? 1 : 0));

  const bySignature = new Map<string, { overrideKey: string; repairedHex: string }>();
  repairedBySignature.forEach(([signature, repairedHex], index) => {
    const overrideKey = index === 0 ? overrideKeyFor(foregroundKey) : `${overrideKeyFor(foregroundKey)}-${index + 1}`;
    bySignature.set(signature, { overrideKey, repairedHex });
  });
  return bySignature;
}

/**
 * What repairing every source key's own foreground against every
 * background signature it is ever paired with produced: the override key
 * each (foreground key, signature) pair needing a fix gets, and the palette
 * entries those overrides need.
 */
interface ForegroundOverrides {
  readonly overrideKeysByForegroundKeyAndSignature: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly additionalPaletteEntries: Readonly<Record<string, string>>;
}

function computeForegroundOverrides(
  signaturesByForegroundKey: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  paletteTable: Readonly<Record<string, string>>,
): ForegroundOverrides {
  const overrideKeysByForegroundKeyAndSignature = new Map<string, ReadonlyMap<string, string>>();
  const additionalPaletteEntries: Record<string, string> = {};

  for (const [foregroundKey, backgroundHexesBySignature] of signaturesByForegroundKey) {
    const foregroundHex = paletteTable[foregroundKey];
    if (foregroundHex === undefined) continue;

    const overridesBySignature = overrideKeysBySignatureFor(foregroundKey, foregroundHex, backgroundHexesBySignature);
    if (overridesBySignature.size === 0) continue;

    const overrideKeysBySignature = new Map<string, string>();
    for (const [signature, { overrideKey, repairedHex }] of overridesBySignature) {
      overrideKeysBySignature.set(signature, overrideKey);
      additionalPaletteEntries[overrideKey] = repairedHex;
    }
    overrideKeysByForegroundKeyAndSignature.set(foregroundKey, overrideKeysBySignature);
  }
  return { overrideKeysByForegroundKeyAndSignature, additionalPaletteEntries };
}

/** `segment` with every foreground key that has an override for `segment`'s own background signature repointed at it — see computeForegroundOverrides. A foreground key with no matching entry needs no fix here and is left referencing its source key untouched. */
function segmentWithOverridesApplied(
  segment: RawSegment,
  paletteTable: Readonly<Record<string, string>>,
  overrideKeysByForegroundKeyAndSignature: ReadonlyMap<string, ReadonlyMap<string, string>>,
): RawSegment {
  const backgroundHexes = segmentBackgroundHexes(segment, paletteTable);
  if (backgroundHexes.length === 0) return segment;
  const signature = backgroundSignatureFor(backgroundHexes);

  return segmentForegroundKeys(segment).reduce((currentSegment, foregroundKey) => {
    const overrideKey = overrideKeysByForegroundKeyAndSignature.get(foregroundKey)?.get(signature);
    return overrideKey === undefined ? currentSegment : segmentWithForegroundRepointed(currentSegment, foregroundKey, overrideKey);
  }, segment);
}

/** `rawBlock` with every one of its segments repointed at whichever overrides it needs — see segmentWithOverridesApplied. */
function withOverridesAppliedToBlock(
  rawBlock: unknown,
  paletteTable: Readonly<Record<string, string>>,
  overrideKeysByForegroundKeyAndSignature: ReadonlyMap<string, ReadonlyMap<string, string>>,
): unknown {
  return withSegmentsTransformed(rawBlock, (segment) =>
    segmentWithOverridesApplied(segment, paletteTable, overrideKeysByForegroundKeyAndSignature),
  );
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
  readonly wereBlocksChanged: boolean;
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
function repairSegmentForegrounds(rawBlocks: readonly unknown[], paletteTable: Readonly<Record<string, string>>): SegmentForegroundRepairResult {
  const normalizedBlocks = rawBlocks.map(withGeneratedBlockForegroundsNormalized);

  const signaturesByForegroundKey = new Map<string, Map<string, readonly string[]>>();
  for (const rawBlock of normalizedBlocks) {
    const segments = segmentsOf(rawBlock);
    if (segments === undefined) continue;
    for (const rawSegment of segments) {
      if (typeof rawSegment === "object" && rawSegment !== null) {
        collectSegmentBackgroundHexes(rawSegment as RawSegment, paletteTable, signaturesByForegroundKey);
      }
    }
  }

  const { overrideKeysByForegroundKeyAndSignature, additionalPaletteEntries } = computeForegroundOverrides(signaturesByForegroundKey, paletteTable);
  const blocks = normalizedBlocks.map((rawBlock) => withOverridesAppliedToBlock(rawBlock, paletteTable, overrideKeysByForegroundKeyAndSignature));

  // Compared structurally, not tracked with a mutable flag through both
  // passes above: a stale generated reference reverting to its source key
  // (see withGeneratedForegroundReferencesNormalized) is exactly as much a
  // change here as a fresh override being minted, and this is what those
  // rejoin into one answer.
  const wereBlocksChanged = JSON.stringify(blocks) !== JSON.stringify(rawBlocks);
  return { blocks, additionalPaletteEntries, wereBlocksChanged };
}

/**
 * The PowerShell chaining variable names this adapter's own profile block
 * uses. Named so a user reading their profile can tell at a glance these
 * are Chameleon's, not something `Set-PoshContext` itself defines.
 */
const PREVIOUS_HOOK_VARIABLE = "$ChameleonPreviousSetPoshContext";
const LAST_APPLIED_VARIABLE = "$global:ChameleonLastAppliedAtMs";

/**
 * The `Set-PoshContext` hook Oh My Posh calls once per prompt render. It
 * chains to whatever `Set-PoshContext` the rest of the profile already
 * defined — captured *before* this redefinition, so the user's own function
 * still runs — then re-initialises the prompt from the pointer file's own
 * config path whenever its timestamp has moved on from the last render.
 * That re-init is what makes an already-open shell repaint on its very next
 * prompt: nothing in this process can reach into another shell, but every
 * shell already calls this hook on its own.
 */
function buildSetPoshContextBlock(pointerPath: string, eol: string): string {
  const lines = [
    "if (Test-Path Function:\\Set-PoshContext) {",
    `    ${PREVIOUS_HOOK_VARIABLE} = \${function:Set-PoshContext}`,
    "} else {",
    `    ${PREVIOUS_HOOK_VARIABLE} = $null`,
    "}",
    "",
    "function Set-PoshContext {",
    `    if (${PREVIOUS_HOOK_VARIABLE}) {`,
    `        & ${PREVIOUS_HOOK_VARIABLE}`,
    "    }",
    "",
    `    $chameleonPointerPath = "${pointerPath.replace(/"/g, '`"')}"`,
    "    if (Test-Path $chameleonPointerPath) {",
    "        $chameleonPointer = Get-Content $chameleonPointerPath -Raw | ConvertFrom-Json",
    `        if ($chameleonPointer.updatedAtMs -ne ${LAST_APPLIED_VARIABLE}) {`,
    `            ${LAST_APPLIED_VARIABLE} = $chameleonPointer.updatedAtMs`,
    "            oh-my-posh init pwsh --config $chameleonPointer.configPath | Invoke-Expression",
    "        }",
    "    }",
    "}",
  ];
  return lines.join(eol);
}

/**
 * Upserts `ownedContent` between `markerBegin`/`markerEnd`, replacing an
 * earlier Chameleon block in place when one exists, or appending a fresh
 * one at the end of the file when it does not. Appending — rather than
 * inserting at the top — is what makes the chaining in
 * buildSetPoshContextBlock correct: a `Set-PoshContext` the user defined
 * earlier in the file is still the one in scope when this block runs.
 * `markerBegin`/`markerEnd` are parameters, not the module's own constants,
 * because Clink's hook is Lua, whose comment syntax (`--`) differs from the
 * `#` every shell profile in this file shares — see LUA_MARKER_BEGIN/END.
 */
function upsertProfileBlock(text: string, ownedContent: string, eol: string, markerBegin: string, markerEnd: string): string {
  const beginIndex = text.indexOf(markerBegin);
  const block = `${markerBegin}${eol}${ownedContent}${eol}${markerEnd}${eol}`;

  if (beginIndex === -1) {
    if (text.length === 0) return block;
    const separator = text.endsWith(eol) ? eol : eol + eol;
    return `${text}${separator}${block}`;
  }

  const endIndex = text.indexOf(markerEnd, beginIndex);
  if (endIndex === -1) {
    throw new Error("the profile has a ch:begin marker with no matching ch:end — refusing to guess where Chameleon's block ends");
  }
  const afterEnd = endIndex + markerEnd.length;
  const afterEndOwn = text.startsWith(eol, afterEnd) ? afterEnd + eol.length : afterEnd;
  return text.slice(0, beginIndex) + block + text.slice(afterEndOwn);
}

/** Reads `targetPath`, defaulting to an empty file when it does not exist yet — the common case for a PowerShell profile before anything has ever written to it. */
function readTextOrEmpty(targetPath: string): string {
  return existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
}

/**
 * Backs up `targetPath` before it is edited, creating an empty file to back
 * up when none exists yet — so undo always has something to restore to,
 * even when the very first apply is what created the file.
 */
function backupBeforeEdit(targetPath: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  if (!existsSync(targetPath)) {
    writeFileSync(targetPath, "", "utf8");
  }
  copyFileSync(targetPath, backupPathFor(targetPath));
}

/**
 * The function name and chaining variable bash's and zsh's own hooks use —
 * mirrors PREVIOUS_HOOK_VARIABLE/LAST_APPLIED_VARIABLE above, in each
 * shell's own naming convention. Shared by both, since the hook body itself
 * is identical apart from which `oh-my-posh init` subcommand it calls.
 */
const POSIX_HOOK_FUNCTION_NAME = "__chameleon_ohmyposh_precmd";
const POSIX_LAST_APPLIED_VARIABLE = "CHAMELEON_LAST_APPLIED_MS";

/**
 * The body bash's and zsh's own hook share: read the pointer file's
 * `updatedAtMs` and `configPath` with `sed` — no JSON tool is guaranteed
 * installed on a bare bash or zsh, but sed is — and re-run `oh-my-posh init`
 * for `shell` whenever the timestamp has moved on since this function's own
 * last run. That re-init is what makes an already-open shell repaint on its
 * very next prompt, the same trick buildSetPoshContextBlock plays for pwsh.
 */
function buildPosixHookFunction(pointerPath: string, shell: "bash" | "zsh"): string[] {
  const escapedPointerPath = pointerPath.replace(/"/g, '\\"');
  return [
    `${POSIX_HOOK_FUNCTION_NAME}() {`,
    `  [ -f "${escapedPointerPath}" ] || return`,
    `  local chameleon_updated_at_ms`,
    `  chameleon_updated_at_ms=$(sed -n 's/.*"updatedAtMs":[[:space:]]*\\([0-9]*\\).*/\\1/p' "${escapedPointerPath}")`,
    `  [ "$chameleon_updated_at_ms" != "$${POSIX_LAST_APPLIED_VARIABLE}" ] || return`,
    `  ${POSIX_LAST_APPLIED_VARIABLE}=$chameleon_updated_at_ms`,
    `  local chameleon_config_path`,
    `  chameleon_config_path=$(sed -n 's/.*"configPath":[[:space:]]*"\\([^"]*\\)".*/\\1/p' "${escapedPointerPath}")`,
    `  eval "$(oh-my-posh init ${shell} --config "$chameleon_config_path")"`,
    "}",
  ];
}

/** bash calls PROMPT_COMMAND before every prompt; the hook chains onto whatever the user's own profile already set, guarding against adding itself twice on a second `source`. */
function buildBashHookBlock(pointerPath: string, eol: string): string {
  const lines = [
    ...buildPosixHookFunction(pointerPath, "bash"),
    `case ";$PROMPT_COMMAND;" in`,
    `  *";${POSIX_HOOK_FUNCTION_NAME};"*) ;;`,
    `  *) PROMPT_COMMAND="${POSIX_HOOK_FUNCTION_NAME};$PROMPT_COMMAND" ;;`,
    "esac",
  ];
  return lines.join(eol);
}

/** zsh's own precmd_functions array is the equivalent of bash's PROMPT_COMMAND; the guard is an index lookup rather than a string search. */
function buildZshHookBlock(pointerPath: string, eol: string): string {
  const lines = [
    ...buildPosixHookFunction(pointerPath, "zsh"),
    `if (( ! \${precmd_functions[(I)${POSIX_HOOK_FUNCTION_NAME}]} )); then`,
    `  precmd_functions+=(${POSIX_HOOK_FUNCTION_NAME})`,
    "fi",
  ];
  return lines.join(eol);
}

/** cmd.exe's own binary name, resolved via PATH — the one dependency this project's Clink support has: without it, cmd.exe has no way at all to run a hook on every prompt. */
const CLINK_BINARY_NAME = "clink";

function detectClink(): boolean {
  const result = spawnSync(CLINK_BINARY_NAME, ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

/**
 * cmd.exe's own live-reload hook: a Clink prompt filter, called on every
 * prompt render the same way Oh My Posh's own `init` hooks are for the other
 * three shells — but since Clink already calls this on every render, there
 * is no "has it changed" check to make; the pointer file's own config path
 * is simply read fresh every time and handed to `oh-my-posh print primary`.
 */
function buildClinkHookScript(pointerPath: string): string {
  const escapedPointerPath = pointerPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines = [
    "local chameleon = clink.promptfilter(1)",
    "function chameleon:filter(prompt)",
    `    local chameleonPointerFile = io.open("${escapedPointerPath}", "r")`,
    "    if not chameleonPointerFile then return end",
    "    local chameleonPointerJson = chameleonPointerFile:read('*a')",
    "    chameleonPointerFile:close()",
    '    local chameleonConfigPath = chameleonPointerJson:match(\'"configPath"%s*:%s*"(.-)"\')',
    "    if not chameleonConfigPath then return end",
    "    local chameleonHandle = io.popen('oh-my-posh print primary --config \"' .. chameleonConfigPath .. '\" --shell=cmd')",
    "    if not chameleonHandle then return end",
    "    local chameleonPrompt = chameleonHandle:read('*a')",
    "    chameleonHandle:close()",
    "    return chameleonPrompt",
    "end",
  ];
  return lines.join("\n");
}

/** Which marker pair owns `shell`'s own hook block — Lua's comment syntax for cmd's Clink script, the `#` every shell profile in this file shares otherwise. */
const HOOK_MARKERS: Readonly<Record<Shell, { begin: string; end: string }>> = {
  pwsh: { begin: PROFILE_MARKER_BEGIN, end: PROFILE_MARKER_END },
  bash: { begin: PROFILE_MARKER_BEGIN, end: PROFILE_MARKER_END },
  zsh: { begin: PROFILE_MARKER_BEGIN, end: PROFILE_MARKER_END },
  cmd: { begin: LUA_MARKER_BEGIN, end: LUA_MARKER_END },
};

/** `shell`'s own live-reload hook content — see buildSetPoshContextBlock, buildBashHookBlock, buildZshHookBlock and buildClinkHookScript. */
function buildReloadHookBlock(shell: Shell, pointerPath: string, eol: string): string {
  if (shell === "pwsh") return buildSetPoshContextBlock(pointerPath, eol);
  if (shell === "bash") return buildBashHookBlock(pointerPath, eol);
  if (shell === "zsh") return buildZshHookBlock(pointerPath, eol);
  return buildClinkHookScript(pointerPath);
}

/**
 * The one-sentence notice `ch apply` shows instead of creating `profilePath`
 * silently — CHM-39's "say which path it would create and why": a hook
 * written to a file nothing has ever loaded before is exactly the silent
 * breakage this ticket exists to fix, so the first time Chameleon creates
 * one, it says so.
 */
function profileCreationNotice(profilePath: string, shell: Shell): string {
  return `created ${profilePath} — ${shell} had no profile of its own yet, so Oh My Posh's live-reload hook had nowhere to go`;
}

/**
 * Extends `shell`'s own interactive-startup file with Chameleon's live-
 * reload hook, chaining any hook the shell already defines where one exists
 * (pwsh's Set-PoshContext). Idempotent: re-applying replaces Chameleon's own
 * block in place rather than duplicating it. cmd.exe has no startup file of
 * its own — its hook is a Clink Lua script instead, and Clink itself must be
 * installed for cmd.exe to run any hook at all — see CHM-25's "says so
 * plainly where it is not": a cmd shell without Clink is refused here, with
 * a message naming the reason, rather than silently skipped.
 *
 * Returns profileCreationNotice's message when `profilePath` did not exist
 * yet — see CHM-39 — and undefined when it already did, since there is
 * nothing new to say about a file that was already there.
 */
function upsertReloadHook(shell: Shell, profilePath: string, pointerPath: string): string | undefined {
  if (shell === "cmd" && !detectClink()) {
    throw new Error(
      "Clink is not installed — cmd.exe needs Clink for Oh My Posh's live reload (https://chrisant996.github.io/clink/); install it and re-run this command",
    );
  }

  const didProfileAlreadyExist = existsSync(profilePath);
  backupBeforeEdit(profilePath);
  const originalText = readTextOrEmpty(profilePath);
  const eol = detectLineEnding(originalText || "\n");
  const { begin, end } = HOOK_MARKERS[shell];
  const updatedText = upsertProfileBlock(originalText, buildReloadHookBlock(shell, pointerPath, eol), eol, begin, end);
  writeFileSync(profilePath, updatedText, "utf8");
  return didProfileAlreadyExist ? undefined : profileCreationNotice(profilePath, shell);
}

/** Points the pointer file at `configPath`, timestamped now — what the profile's `Set-PoshContext` hook diffs against to know a new theme has been applied. */
function writePointer(pointerPath: string, configPath: string): void {
  mkdirSync(path.dirname(pointerPath), { recursive: true });
  const pointer: z.infer<typeof PointerSchema> = { configPath, updatedAtMs: Date.now() };
  writeFileSync(pointerPath, JSON.stringify(pointer, null, 2), "utf8");
}

/**
 * What Chameleon actually tried before giving up on finding an active
 * config, named plainly rather than pointing at one variable current Oh My
 * Posh never sets — see CHM-36, where "POSH_THEME is not set" survived
 * every real apply failing because that was never the whole story.
 */
function noConfigDiscoveredMessage(profilePath: string, shell: Shell): string {
  const initShellName = initShellNamesFor(shell)[0];
  const initHint = initShellName
    ? ` run \`oh-my-posh init ${initShellName} --config <path>\` (see ${profilePath}) so Oh My Posh sets one of those,`
    : ` run \`oh-my-posh init\` for this shell so Oh My Posh sets one of those,`;
  return `no active Oh My Posh config found — checked $POSH_CONFIG, $POSH_THEME, and ${profilePath} for an "oh-my-posh init" line naming --config;${initHint} or pass a config path directly`;
}

/**
 * Backs up the config and profile, swaps the config's palette table for
 * `scheme`'s resolved roles, repairs any segment whose own foreground fails
 * TEXT_MIN_RATIO against its own background (see repairSegmentForegrounds
 * and CHM-40), extends `shell`'s own live-reload hook, and points the
 * pointer file at the config so every open shell — this one included —
 * repaints on its next prompt. Returns upsertReloadHook's own
 * profile-creation notice, or undefined when the profile already existed —
 * see CHM-39.
 */
function applyOhMyPoshScheme(
  configPath: string | undefined,
  profilePath: string,
  pointerPath: string,
  shell: Shell,
  scheme: Scheme,
): string | undefined {
  if (!configPath) {
    throw new Error(noConfigDiscoveredMessage(profilePath, shell));
  }
  if (!existsSync(configPath)) {
    throw new Error(`no Oh My Posh config found at ${configPath}`);
  }

  copyFileSync(configPath, backupPathFor(configPath));
  const originalText = readFileSync(configPath, "utf8");
  const existingConfig = readOhMyPoshConfig(configPath);
  const paletteTable = recoloredPaletteTable(existingConfig.palette, resolveRoleHexes(scheme));

  // Segment repair reads the recoloured table above, never the config's own
  // original palette — a segment must be checked against the colours it is
  // about to render, not the ones it used to.
  const segmentRepair = repairSegmentForegrounds(existingConfig.blocks ?? [], paletteTable);
  const finalPaletteTable = { ...paletteTable, ...segmentRepair.additionalPaletteEntries };

  let updatedConfigText = upsertPaletteTable(configPath, originalText, finalPaletteTable);
  // "blocks" is left completely untouched — not even re-upserted — when
  // nothing about it changed, so the overwhelming common case still
  // round-trips byte-identical outside the palette block, same as before
  // this ticket.
  if (segmentRepair.wereBlocksChanged) {
    updatedConfigText = upsertBlocksArray(configPath, updatedConfigText, [...segmentRepair.blocks]);
  }
  assertNoDanglingPaletteReferences(configPath, updatedConfigText, finalPaletteTable);
  writeFileSync(configPath, updatedConfigText, "utf8");

  const profileNotice = upsertReloadHook(shell, profilePath, pointerPath);
  writePointer(pointerPath, configPath);
  return profileNotice;
}

/**
 * Nothing to trigger from this process: an already-open shell picks up the
 * new palette on its own next prompt render, through the live-reload hook
 * `apply` wires into its own startup file — see buildReloadHookBlock. A CLI
 * invocation cannot reach into another shell's process to force a repaint
 * any more than it could for the one that ran it. Returns undefined, never
 * a detail: unlike Herdr (CHM-45), there is no "nothing running to tell"
 * case here worth surfacing.
 */
function reloadOhMyPosh(): string | undefined {
  // Intentional no-op — see the doc comment above.
  return undefined;
}

/**
 * Builds the Oh My Posh adapter. `configPath` defaults to whatever
 * POSH_CONFIG or POSH_THEME names in the current environment; `profilePath`
 * and `pointerPath` default to their real pwsh locations; `shell` defaults
 * to "pwsh", matching those defaults. All four are only ever overridden by
 * tests, which point them at fixture copies so nothing here touches a real
 * profile or config — real callers instead use createDefaultOhMyPoshAdapter,
 * which resolves the shell `ch` is actually running in and the profile that
 * goes with it.
 *
 * When `configPath` is not given (or the environment named none), this
 * falls back to parsing `profilePath` itself for an `oh-my-posh init`
 * line — the case CHM-36 exists for: a normal shell that Oh My Posh has
 * never actually initialised this session, so POSH_CONFIG and POSH_THEME
 * are not set yet even though the shell's own profile names a config. That
 * resolution happens here, in the function body, rather than in
 * `configPath`'s own default expression, because a parameter default cannot
 * see `profilePath` — the parameter declared after it — and every caller
 * needs the fallback to run against the exact profile it passed in.
 */
export function createOhMyPoshAdapter(
  configPath: string | undefined = defaultConfigPath(),
  profilePath: string = defaultProfilePath(),
  pointerPath: string = defaultPointerPath(),
  shell: Shell = "pwsh",
): OhMyPoshAdapter {
  const resolvedConfigPath = resolveConfigPath(configPath, profilePath, shell);
  return {
    detect: () => detectOhMyPosh(),
    read: () => readOhMyPoshConfig(resolvedConfigPath ?? throwNoConfigDiscovered(profilePath, shell)),
    apply: (scheme) => applyOhMyPoshScheme(resolvedConfigPath, profilePath, pointerPath, shell, scheme),
    reload: () => reloadOhMyPosh(),
  };
}

/** Throws noConfigDiscoveredMessage — a function, not an inline `if`, so it can sit in the `??` chain read() uses to fall back only when resolvedConfigPath is genuinely absent. */
function throwNoConfigDiscovered(profilePath: string, shell: Shell): never {
  throw new Error(noConfigDiscoveredMessage(profilePath, shell));
}

/**
 * Builds the Oh My Posh adapter for whichever shell `ch` is actually running
 * in — the real entry point every caller besides a test uses. Resolving the
 * shell here, rather than in createOhMyPoshAdapter's own parameter defaults,
 * is what lets that function's defaults stay the fixed "pwsh" a test relies
 * on without having to pass a shell of its own. See CHM-25.
 */
export function createDefaultOhMyPoshAdapter(): OhMyPoshAdapter {
  const shell = detectShell();
  return createOhMyPoshAdapter(defaultConfigPath(), defaultProfilePath(shell), defaultPointerPath(), shell);
}

function requireConfigPath(configPath: string | undefined): string {
  if (!configPath) {
    throw new Error("no active Oh My Posh config to read — checked $POSH_CONFIG and $POSH_THEME; run `oh-my-posh init` for your shell so one is set, or pass a config path directly");
  }
  return configPath;
}

// --- Layout: the left and right-hand (status line) segment blocks ---------
//
// CHM-8's "ch edit" — add, remove, reorder and move a segment between the
// left prompt block and the right-hand status line. This owns the config's
// "blocks" property, scoped in its own ch:begin blocks / ch:end blocks
// region — see marked-json-edit.ts's keyed markers — and never the
// "palette" property applyOhMyPoshScheme owns above: a theme swap and a
// layout edit are independent operations on independent root-level
// properties, which is what lets a layout edit survive a theme swap and
// vice versa.

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
export const SEGMENT_TYPES = [
  "angular", "antigravity", "argocd", "aspire", "aurelia", "aws", "az", "azd", "azfunc", "battery",
  "bazel", "brewfather", "buf", "bun", "carbonintensity", "cds", "cf", "cftarget", "claude", "clojure",
  "cmake", "copilot", "copilot_cli", "connection", "crystal", "dart", "deno", "docker", "dotnet", "dvc",
  "elixir", "executiontime", "firebase", "flutter", "fortran", "fossil", "gcp", "git", "gitversion", "go",
  "gradle", "haskell", "helm", "http", "ipify", "java", "jujutsu", "julia", "kotlin", "kubectl",
  "language", "lastfm", "lua", "mercurial", "mojo", "mvn", "nba", "nbgv", "nightscout", "nim",
  "nix-shell", "node", "npm", "nx", "ocaml", "orthodoxcal", "os", "owm", "path", "perl", "php", "plastic",
  "pnpm", "project", "pulumi", "python", "quasar", "r", "ramadan", "react", "root", "ruby", "rust",
  "sapling", "session", "shell", "sitecore", "spotify", "status", "strava", "svelte", "svn", "swift",
  "sysinfo", "talosctl", "taskwarrior", "tauri", "terraform", "text", "time", "todoist", "ui5tooling",
  "umbraco", "uno", "unity", "upgrade", "v", "vala", "vimode", "wakatime", "winget", "winreg", "withings",
  "xmake", "yarn", "ytm", "zig", "zvm",
] as const;

export type SegmentType = (typeof SEGMENT_TYPES)[number];

/** Whether `candidateType` is one of SEGMENT_TYPES — the boundary check `ch edit add`'s own `--type` flag must clear, same pattern as isKnownRole for `--foreground`/`--background`. */
export function isSegmentType(candidateType: string): candidateType is SegmentType {
  return SEGMENT_TYPES.some((segmentType) => segmentType === candidateType);
}

/** How every colour `ch edit` writes into a segment is expressed — a reference to one of Chameleon's roles, resolved by the palette table `ch <theme>` maintains, never a literal hex. See CHM-8's "no command in this ticket can write a literal colour." */
const PALETTE_REF_PREFIX = "p:";

/**
 * One entry in a block's segment list. `type`, `foreground` and
 * `background` are all this adapter needs to reason about; every other
 * property a real segment carries — style, properties, template, … — is
 * unvalidated and carried through untouched, the same "validate only what we
 * edit" contract as OhMyPoshConfigSchema above.
 */
const LayoutSegmentSchema = z.object({ type: z.string().min(1) }).catchall(z.unknown());
export type LayoutSegment = z.infer<typeof LayoutSegmentSchema>;

const LayoutBlockSchema = z
  .object({
    type: z.literal("prompt"),
    alignment: z.enum(["left", "right"]),
    segments: z.array(LayoutSegmentSchema),
  })
  .catchall(z.unknown());

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

/** The role a segment property references, when it is a "p:role" string — undefined for anything else, including a plain hex a user wrote by hand before ever running `ch edit`. */
function roleReferencedBy(segmentPropertyValue: unknown): string | undefined {
  return typeof segmentPropertyValue === "string" && segmentPropertyValue.startsWith(PALETTE_REF_PREFIX)
    ? segmentPropertyValue.slice(PALETTE_REF_PREFIX.length)
    : undefined;
}

/**
 * Throws, naming the role, when `segment`'s foreground or background
 * references a role Chameleon does not know. Only ever called on a segment
 * `ch edit` itself is about to write — see CHM-8's "a layout referencing an
 * undefined role is rejected with a message naming the role." A segment
 * already sitting in the config, referencing a palette key Chameleon does
 * not own, is never passed to this — see CHM-16's "left alone, not
 * rejected" below.
 */
function assertSegmentRolesAreDefined(segment: LayoutSegment): void {
  for (const property of ["foreground", "background"] as const) {
    const referencedRole = roleReferencedBy(segment[property]);
    if (referencedRole !== undefined && !isKnownRole(referencedRole)) {
      throw new Error(`layout segment "${segment.type}" references undefined role "${referencedRole}"`);
    }
  }
}

/**
 * Metadata keys every raw layout block carries that this adapter interprets
 * itself. Everything else Oh My Posh's own schema allows on a block —
 * "newline", "overflow", "filler", "leading_diamond", … — is opaque as far
 * as `ch edit` cares, and is carried in a block's own `extra`.
 */
const LAYOUT_BLOCK_OWN_KEYS = new Set(["type", "alignment", "segments"]);

/** Every property of a raw, already-schema-validated block object besides the ones this adapter interprets itself — see LAYOUT_BLOCK_OWN_KEYS. */
function extraBlockProperties(rawBlock: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rawBlock).filter(([key]) => !LAYOUT_BLOCK_OWN_KEYS.has(key)));
}

/**
 * Parses the config's "blocks" property into Chameleon's own block model, in
 * document order — CHM-16's "operate on a config with multiple blocks per
 * side, addressing them unambiguously." A block that does not parse as a
 * left/right "prompt" block — Oh My Posh also allows "rprompt" — is left out
 * of the model; every real theme this adapter has been checked against, and
 * CHM-8's own fixture, use "prompt" blocks exclusively. A segment already
 * referencing a palette key Chameleon does not own is read through
 * untouched rather than rejected — see CHM-16's "left alone": only a
 * segment `ch edit` is about to write is ever checked against Chameleon's
 * own roles, via assertSegmentRolesAreDefined above.
 */
function parseLayoutBlocks(rawBlocks: readonly unknown[]): LayoutBlock[] {
  return rawBlocks.flatMap((rawBlock) => {
    const parsedBlock = LayoutBlockSchema.safeParse(rawBlock);
    if (!parsedBlock.success) return [];
    const { alignment, segments } = parsedBlock.data;
    return [{ alignment, segments, extra: extraBlockProperties(parsedBlock.data) }];
  });
}

/** Reads the config's "blocks" property into Chameleon's own layout model. */
function readLayout(configPath: string): Layout {
  const config = readOhMyPoshConfig(configPath);
  return { blocks: parseLayoutBlocks(config.blocks ?? []) };
}

/** Renders `layout` back into Oh My Posh's own "blocks" shape, in the same document order the config was read in. */
function blocksFromLayout(layout: Layout): unknown[] {
  return layout.blocks.map((block) => ({ type: "prompt", alignment: block.alignment, ...block.extra, segments: block.segments }));
}

/**
 * Swaps the config's top-level "blocks" property for `blocks`, scoped
 * between ch:begin blocks/ch:end blocks — the layout counterpart of
 * upsertPaletteTable above, owning its own marked region so the two never
 * collide inside the same root object.
 */
function upsertBlocksArray(configPath: string, text: string, blocks: unknown[]): string {
  const eol = detectLineEnding(text);
  const { dedupedText, container } = dedupeRootProperty(configPath, text, "blocks");
  return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent("blocks", blocks, eol), eol, "blocks");
}

/** Backs up the config, then rewrites its "blocks" property — and only that property — from `layout`. */
function writeLayout(configPath: string, layout: Layout): void {
  copyFileSync(configPath, backupPathFor(configPath));
  const originalText = readFileSync(configPath, "utf8");
  const updatedText = upsertBlocksArray(configPath, originalText, blocksFromLayout(layout));
  writeFileSync(configPath, updatedText, "utf8");
}

/** Reads the active config's layout — the left and right-hand segment blocks `ch edit` operates on. */
export function readOhMyPoshLayout(configPath: string | undefined = defaultConfigPath()): Layout {
  return readLayout(requireConfigPath(configPath));
}

/** Writes `layout` back to the active config, backed up first. Not part of the adapter interface — editing the layout is `ch edit`'s job, never a step in the theming pipeline. */
export function writeOhMyPoshLayout(layout: Layout, configPath: string | undefined = defaultConfigPath()): void {
  writeLayout(requireConfigPath(configPath), layout);
}

/** Builds a brand-new segment of `type`, coloured entirely by role reference — never a literal hex. `backgroundRole` is genuinely optional: plenty of real segments set only a foreground and let the block's own styling supply the rest. */
export function buildLayoutSegment(type: SegmentType, foregroundRole: Role, backgroundRole?: Role): LayoutSegment {
  return {
    type,
    foreground: `${PALETTE_REF_PREFIX}${foregroundRole}`,
    ...(backgroundRole !== undefined ? { background: `${PALETTE_REF_PREFIX}${backgroundRole}` } : {}),
  };
}

/** A human-readable name for one block, used in every error this module throws about a segment index — e.g. `"left" block 1`, so a mistake is clear the moment a config has more than one block on a side. */
function blockLabel(alignment: LayoutBlockName, blockIndex: number): string {
  return `"${alignment}" block ${blockIndex}`;
}

/** Throws, naming the block, when `atIndex` cannot be inserted at — i.e. is not one of the block's own existing indices or the one right past its end (an append). */
function assertInsertIndex(atIndex: number, blockDescription: string, segmentCount: number): void {
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > segmentCount) {
    throw new Error(`index ${atIndex} is out of range for ${blockDescription}, which has ${segmentCount} segment(s)`);
  }
}

/** Throws, naming the block, when `atIndex` does not name one of the block's own existing segments. */
function assertExistingIndex(atIndex: number, blockDescription: string, segmentCount: number): void {
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex >= segmentCount) {
    throw new Error(`index ${atIndex} is out of range for ${blockDescription}, which has ${segmentCount} segment(s)`);
  }
}

/** The blocks sharing `alignment`, in document order — what a `blockIndex` argument counts against. */
function blocksForAlignment(layout: Layout, alignment: LayoutBlockName): readonly LayoutBlock[] {
  return layout.blocks.filter((block) => block.alignment === alignment);
}

/**
 * Every block on `alignment`'s own side, in document order — CHM-16's
 * "addressing them unambiguously": what a caller uses to decide whether a
 * `--block-index` needs to be asked for at all, since a side with exactly
 * one block never needs to name it.
 */
export function layoutBlocksOnSide(layout: Layout, alignment: LayoutBlockName): readonly LayoutBlock[] {
  return blocksForAlignment(layout, alignment);
}

/** Throws, naming the side and its block count, when `blockIndex` does not name one of `alignment`'s own existing blocks. */
function assertBlockIndex(layout: Layout, alignment: LayoutBlockName, blockIndex: number): LayoutBlock {
  const matchingBlocks = blocksForAlignment(layout, alignment);
  const targetBlock = matchingBlocks[blockIndex];
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || targetBlock === undefined) {
    throw new Error(`block index ${blockIndex} is out of range for the "${alignment}" side, which has ${matchingBlocks.length} block(s)`);
  }
  return targetBlock;
}

/**
 * Replaces the `blockIndex`-th block of `alignment`, in document order,
 * with `updatedBlock` — the one place a layout's blocks array is ever
 * rewritten, so every mutation below shares the same "find the nth
 * same-alignment block, leave everything else exactly where it was" logic.
 */
function withBlockAt(layout: Layout, alignment: LayoutBlockName, blockIndex: number, updatedBlock: LayoutBlock): Layout {
  let occurrenceIndex = -1;
  const blocks = layout.blocks.map((block) => {
    if (block.alignment !== alignment) return block;
    occurrenceIndex += 1;
    return occurrenceIndex === blockIndex ? updatedBlock : block;
  });
  return { blocks };
}

/**
 * The block at `blockIndex` among `alignment`'s own blocks — creating a
 * brand new, empty one and appending it to the layout when `blockIndex` is
 * exactly one past the last block that side already has. That is the only
 * way a side gains a block: a side with none yet (`blockIndex` 0) or an
 * existing side gaining an additional one (`blockIndex` equal to its
 * current count) — the same "index equal to length means append" contract
 * assertInsertIndex already uses for segments.
 */
function resolveBlockForWrite(layout: Layout, alignment: LayoutBlockName, blockIndex: number): { layout: Layout; block: LayoutBlock } {
  const matchingBlocks = blocksForAlignment(layout, alignment);
  if (blockIndex === matchingBlocks.length) {
    const newBlock: LayoutBlock = { alignment, segments: [], extra: {} };
    return { layout: { blocks: [...layout.blocks, newBlock] }, block: newBlock };
  }
  return { layout, block: assertBlockIndex(layout, alignment, blockIndex) };
}

/**
 * Inserts `segment` into the `blockIndex`-th block of `alignment` at
 * `atIndex`, defaulting to the end of that block — creating the block
 * itself first when `blockIndex` names a fresh one, see
 * resolveBlockForWrite. Pure — the caller is responsible for reading the
 * current layout first and writing the result back.
 */
export function addSegment(
  layout: Layout,
  alignment: LayoutBlockName,
  blockIndex: number,
  segment: LayoutSegment,
  atIndex?: number,
): Layout {
  assertSegmentRolesAreDefined(segment);
  const { layout: layoutWithBlock, block } = resolveBlockForWrite(layout, alignment, blockIndex);
  const resolvedAtIndex = atIndex ?? block.segments.length;
  assertInsertIndex(resolvedAtIndex, blockLabel(alignment, blockIndex), block.segments.length);
  const segments = [...block.segments.slice(0, resolvedAtIndex), segment, ...block.segments.slice(resolvedAtIndex)];
  return withBlockAt(layoutWithBlock, alignment, blockIndex, { ...block, segments });
}

/** Removes the segment at `atIndex` from the `blockIndex`-th block of `alignment`. Pure — see addSegment. */
export function removeSegment(layout: Layout, alignment: LayoutBlockName, blockIndex: number, atIndex: number): Layout {
  const block = assertBlockIndex(layout, alignment, blockIndex);
  assertExistingIndex(atIndex, blockLabel(alignment, blockIndex), block.segments.length);
  const segments = [...block.segments.slice(0, atIndex), ...block.segments.slice(atIndex + 1)];
  return withBlockAt(layout, alignment, blockIndex, { ...block, segments });
}

/** Moves the segment at `fromIndex` to `toIndex` within the `blockIndex`-th block of `alignment`, shifting the segments between them. Pure — see addSegment. */
export function reorderSegment(layout: Layout, alignment: LayoutBlockName, blockIndex: number, fromIndex: number, toIndex: number): Layout {
  const block = assertBlockIndex(layout, alignment, blockIndex);
  const label = blockLabel(alignment, blockIndex);
  assertExistingIndex(fromIndex, label, block.segments.length);
  assertExistingIndex(toIndex, label, block.segments.length);

  const segmentToMove = block.segments[fromIndex];
  if (segmentToMove === undefined) {
    throw new Error(`index ${fromIndex} is out of range for ${label}, which has ${block.segments.length} segment(s)`);
  }
  const withoutSegment = [...block.segments.slice(0, fromIndex), ...block.segments.slice(fromIndex + 1)];
  const segments = [...withoutSegment.slice(0, toIndex), segmentToMove, ...withoutSegment.slice(toIndex)];
  return withBlockAt(layout, alignment, blockIndex, { ...block, segments });
}

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
export function moveSegmentBetweenBlocks(
  layout: Layout,
  fromAlignment: LayoutBlockName,
  fromBlockIndex: number,
  fromIndex: number,
  toAlignment: LayoutBlockName,
  toBlockIndex: number,
  toIndex?: number,
): Layout {
  const fromBlock = assertBlockIndex(layout, fromAlignment, fromBlockIndex);
  const fromLabel = blockLabel(fromAlignment, fromBlockIndex);
  assertExistingIndex(fromIndex, fromLabel, fromBlock.segments.length);

  const segmentToMove = fromBlock.segments[fromIndex];
  if (segmentToMove === undefined) {
    throw new Error(`index ${fromIndex} is out of range for ${fromLabel}, which has ${fromBlock.segments.length} segment(s)`);
  }

  const isSameBlock = fromAlignment === toAlignment && fromBlockIndex === toBlockIndex;
  const { layout: layoutWithDestination, block: toBlock } = isSameBlock
    ? { layout, block: fromBlock }
    : resolveBlockForWrite(layout, toAlignment, toBlockIndex);

  const fromSegmentsWithoutMoved = [...fromBlock.segments.slice(0, fromIndex), ...fromBlock.segments.slice(fromIndex + 1)];
  const toSegmentsBeforeInsert = isSameBlock ? fromSegmentsWithoutMoved : toBlock.segments;
  const resolvedToIndex = toIndex ?? toSegmentsBeforeInsert.length;
  assertInsertIndex(resolvedToIndex, blockLabel(toAlignment, toBlockIndex), toSegmentsBeforeInsert.length);
  const toSegments = [...toSegmentsBeforeInsert.slice(0, resolvedToIndex), segmentToMove, ...toSegmentsBeforeInsert.slice(resolvedToIndex)];

  if (isSameBlock) {
    return withBlockAt(layout, fromAlignment, fromBlockIndex, { ...fromBlock, segments: toSegments });
  }

  const layoutWithoutSegment = withBlockAt(layoutWithDestination, fromAlignment, fromBlockIndex, {
    ...fromBlock,
    segments: fromSegmentsWithoutMoved,
  });
  return withBlockAt(layoutWithoutSegment, toAlignment, toBlockIndex, { ...toBlock, segments: toSegments });
}

/**
 * Restores the config and the profile from the backups written by the most
 * recent `apply`. Not part of the adapter interface — undo is a user
 * command, not a step in the theming pipeline — but it lives beside the
 * adapter because the backup files' locations and format are this file's
 * business.
 */
export function undoOhMyPosh(
  configPath: string | undefined = defaultConfigPath(),
  profilePath: string = defaultProfilePath(),
): void {
  const resolvedConfigPath = requireConfigPath(configPath);
  const configBackupPath = backupPathFor(resolvedConfigPath);
  if (!existsSync(configBackupPath)) {
    throw new Error(`no backup found at ${configBackupPath} — nothing to undo`);
  }
  copyFileSync(configBackupPath, resolvedConfigPath);

  const profileBackupPath = backupPathFor(profilePath);
  if (!existsSync(profileBackupPath)) {
    throw new Error(`no backup found at ${profileBackupPath} — nothing to undo`);
  }
  copyFileSync(profileBackupPath, profilePath);
}
