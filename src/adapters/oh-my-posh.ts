import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseJsonc, type Node } from "jsonc-parser";
import { z } from "zod";
import { isKnownRole, type Role } from "../constants.js";
import { resolveRoleHexes } from "../palette/repair.js";
import type { Scheme } from "../palette/scheme.js";
import {
  buildPropertyBlockContent,
  dedupeConflict,
  detectLineEnding,
  findPropertyNode,
  parseJsonTree,
  upsertMarkedBlock,
} from "./marked-json-edit.js";

/** Suffix for the pre-apply copy of a config or profile file that `undoOhMyPosh` restores from. */
const BACKUP_FILE_SUFFIX = ".chameleon-backup";

/** Oh My Posh's own CLI binary name, resolved via PATH — see detectOhMyPosh. */
const OH_MY_POSH_BINARY_NAME = "oh-my-posh";

/** winget's package identifier for Oh My Posh, used to build the one-line install command `ch doctor` offers. */
export const OH_MY_POSH_WINGET_PACKAGE_ID = "JanDeDobbeleer.OhMyPosh";

/** Chameleon's own state directory, under the user's local app data — currently home to only the pointer file below. */
const STATE_DIR_NAME = "chameleon";

/** File name of the pointer `apply` writes and the profile's `Set-PoshContext` hook reads. */
const POINTER_FILE_NAME = "oh-my-posh-pointer.json";

/**
 * Every edit this adapter makes to the user's PowerShell profile is wrapped
 * in this pair — the JSON marker pair from marked-json-edit.ts is a `//`
 * comment, which PowerShell does not understand, so the profile gets its
 * own markers in PowerShell's own comment syntax.
 */
const PROFILE_MARKER_BEGIN = "# ch:begin";
const PROFILE_MARKER_END = "# ch:end";

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

const PointerSchema = z.object({
  configPath: z.string().min(1),
  updatedAtMs: z.number(),
});

export interface OhMyPoshAdapter {
  detect(): boolean;
  read(): OhMyPoshConfig;
  apply(scheme: Scheme): void;
  reload(): void;
}

/**
 * Oh My Posh's own `init pwsh` sets this in the environment of every shell
 * it initialises, pointed at whichever config that shell is running. `ch`
 * inherits it from its parent shell, the same way it would inherit any
 * other environment variable — there is no separate "active config" file to
 * read, the way Windows Terminal has settings.json.
 */
function defaultConfigPath(): string | undefined {
  return process.env["POSH_THEME"];
}

/**
 * Where a stock `pwsh` install keeps the current user's profile for every
 * host ($PROFILE, "CurrentUserAllHosts" would be Profile.ps1 without the
 * "Microsoft.PowerShell" prefix — Chameleon only ever targets the
 * per-host profile, since that is what oh-my-posh's own install
 * instructions wire up).
 */
function defaultProfilePath(): string {
  const userProfile = process.env["USERPROFILE"];
  if (!userProfile) {
    throw new Error("USERPROFILE is not set — cannot locate the PowerShell profile");
  }
  return path.join(userProfile, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
}

function defaultPointerPath(): string {
  const localAppData = process.env["LOCALAPPDATA"];
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set — cannot locate Chameleon's state directory");
  }
  return path.join(localAppData, STATE_DIR_NAME, POINTER_FILE_NAME);
}

function backupPathFor(targetPath: string): string {
  return `${targetPath}${BACKUP_FILE_SUFFIX}`;
}

/**
 * Oh My Posh is detected by its own installed binary, never by POSH_THEME.
 * POSH_THEME is set per-shell by `oh-my-posh init`, so a shell that has
 * never run init — a fresh git-bash, cmd, or a pwsh before its profile loads
 * — would otherwise report Oh My Posh as missing even when it is on PATH and
 * fully configured elsewhere. See CHM-15, which supersedes CHM-7 for
 * exactly this false negative.
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
function upsertPaletteTable(configPath: string, text: string, paletteTable: Record<Role, string>): string {
  const eol = detectLineEnding(text);
  const { dedupedText, container } = dedupeRootProperty(configPath, text, "palette");
  return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent("palette", paletteTable, eol), eol, "palette");
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
 * Upserts `ownedContent` between PROFILE_MARKER_BEGIN/END, replacing an
 * earlier Chameleon block in place when one exists, or appending a fresh
 * one at the end of the file when it does not. Appending — rather than
 * inserting at the top — is what makes the chaining in
 * buildSetPoshContextBlock correct: a `Set-PoshContext` the user defined
 * earlier in the file is still the one in scope when this block runs.
 */
function upsertProfileBlock(text: string, ownedContent: string, eol: string): string {
  const beginIndex = text.indexOf(PROFILE_MARKER_BEGIN);
  const block = `${PROFILE_MARKER_BEGIN}${eol}${ownedContent}${eol}${PROFILE_MARKER_END}${eol}`;

  if (beginIndex === -1) {
    if (text.length === 0) return block;
    const separator = text.endsWith(eol) ? eol : eol + eol;
    return `${text}${separator}${block}`;
  }

  const endIndex = text.indexOf(PROFILE_MARKER_END, beginIndex);
  if (endIndex === -1) {
    throw new Error("the profile has a ch:begin marker with no matching ch:end — refusing to guess where Chameleon's block ends");
  }
  const afterEnd = endIndex + PROFILE_MARKER_END.length;
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
 * Extends the profile's `Set-PoshContext` hook with Chameleon's own
 * pointer-check, chaining any hook the user already defined. Idempotent:
 * re-applying replaces Chameleon's own block in place rather than
 * re-chaining it every time.
 */
function upsertSetPoshContext(profilePath: string, pointerPath: string): void {
  backupBeforeEdit(profilePath);
  const originalText = readTextOrEmpty(profilePath);
  const eol = detectLineEnding(originalText || "\n");
  const updatedText = upsertProfileBlock(originalText, buildSetPoshContextBlock(pointerPath, eol), eol);
  writeFileSync(profilePath, updatedText, "utf8");
}

/** Points the pointer file at `configPath`, timestamped now — what the profile's `Set-PoshContext` hook diffs against to know a new theme has been applied. */
function writePointer(pointerPath: string, configPath: string): void {
  mkdirSync(path.dirname(pointerPath), { recursive: true });
  const pointer: z.infer<typeof PointerSchema> = { configPath, updatedAtMs: Date.now() };
  writeFileSync(pointerPath, JSON.stringify(pointer, null, 2), "utf8");
}

/**
 * Backs up the config and profile, swaps the config's palette table for
 * `scheme`'s resolved roles, extends the profile's `Set-PoshContext` hook,
 * and points the pointer file at the config so every open shell — this one
 * included — repaints on its next prompt.
 */
function applyOhMyPoshScheme(configPath: string | undefined, profilePath: string, pointerPath: string, scheme: Scheme): void {
  if (!configPath) {
    throw new Error("POSH_THEME is not set — no active Oh My Posh config to apply to");
  }
  if (!existsSync(configPath)) {
    throw new Error(`no Oh My Posh config found at ${configPath}`);
  }

  copyFileSync(configPath, backupPathFor(configPath));
  const originalText = readFileSync(configPath, "utf8");
  const updatedConfigText = upsertPaletteTable(configPath, originalText, resolveRoleHexes(scheme));
  writeFileSync(configPath, updatedConfigText, "utf8");

  upsertSetPoshContext(profilePath, pointerPath);
  writePointer(pointerPath, configPath);
}

/**
 * Nothing to trigger from this process: an already-open shell picks up the
 * new palette on its own next prompt render, through the `Set-PoshContext`
 * hook `apply` wires into the profile — see buildSetPoshContextBlock. A CLI
 * invocation cannot reach into another shell's process to force a repaint
 * any more than it could for the one that ran it.
 */
function reloadOhMyPosh(): void {
  // Intentional no-op — see the doc comment above.
}

/**
 * Builds the Oh My Posh adapter. `configPath` defaults to whatever
 * POSH_THEME names in the current environment; `profilePath` and
 * `pointerPath` default to their real locations and are only ever
 * overridden by tests, which point them at fixture copies so nothing here
 * touches a real profile or config.
 */
export function createOhMyPoshAdapter(
  configPath: string | undefined = defaultConfigPath(),
  profilePath: string = defaultProfilePath(),
  pointerPath: string = defaultPointerPath(),
): OhMyPoshAdapter {
  return {
    detect: () => detectOhMyPosh(),
    read: () => readOhMyPoshConfig(requireConfigPath(configPath)),
    apply: (scheme) => applyOhMyPoshScheme(configPath, profilePath, pointerPath, scheme),
    reload: () => reloadOhMyPosh(),
  };
}

function requireConfigPath(configPath: string | undefined): string {
  if (!configPath) {
    throw new Error("POSH_THEME is not set — no active Oh My Posh config to read");
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
 * The Oh My Posh segment types `ch edit add` offers — the handful that cover
 * what most prompts actually show, per Oh My Posh's own segment reference.
 * Not exhaustive: a config may carry other segment types already, and this
 * adapter still reads, reorders and moves those untouched — only adding a
 * brand new segment is restricted to a type from this list.
 */
export const SEGMENT_TYPES = ["path", "git", "os", "session", "shell", "root", "status", "time", "battery", "text"] as const;

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
 * Chameleon's own model of a config's segment layout: which segments sit in
 * the left and right blocks, and in what order. Never carries a colour
 * beyond a role reference, and never carries the palette table itself — see
 * CHM-8's "operate on the layout file only; never touch the palette."
 */
export interface Layout {
  readonly left: readonly LayoutSegment[];
  readonly right: readonly LayoutSegment[];
}

/** The role a segment property references, when it is a "p:role" string — undefined for anything else, including a plain hex a user wrote by hand before ever running `ch edit`. */
function roleReferencedBy(segmentPropertyValue: unknown): string | undefined {
  return typeof segmentPropertyValue === "string" && segmentPropertyValue.startsWith(PALETTE_REF_PREFIX)
    ? segmentPropertyValue.slice(PALETTE_REF_PREFIX.length)
    : undefined;
}

/**
 * Throws, naming the role, when `segment`'s foreground or background
 * references a role Chameleon does not know — see CHM-8's "a layout
 * referencing an undefined role is rejected with a message naming the
 * role."
 */
function assertSegmentRolesAreDefined(segment: LayoutSegment): void {
  for (const property of ["foreground", "background"] as const) {
    const referencedRole = roleReferencedBy(segment[property]);
    if (referencedRole !== undefined && !isKnownRole(referencedRole)) {
      throw new Error(`layout segment "${segment.type}" references undefined role "${referencedRole}"`);
    }
  }
}

function assertLayoutRolesAreDefined(layout: Layout): void {
  for (const segment of [...layout.left, ...layout.right]) assertSegmentRolesAreDefined(segment);
}

/**
 * The segments of the single block whose alignment is `alignment`, or an
 * empty list when the config has none yet. Throws when more than one block
 * shares that alignment — `ch edit` only understands a single block per
 * side, the same shape every example in Oh My Posh's own docs and this
 * project's fixture use.
 */
function segmentsForAlignment(configPath: string, blocks: readonly unknown[], alignment: LayoutBlockName): readonly LayoutSegment[] {
  const matchingBlocks = blocks.flatMap((block) => {
    const parsedBlock = LayoutBlockSchema.safeParse(block);
    return parsedBlock.success && parsedBlock.data.alignment === alignment ? [parsedBlock.data] : [];
  });

  if (matchingBlocks.length > 1) {
    throw new Error(`${configPath} has more than one "${alignment}" prompt block — ch edit only understands a single block per side`);
  }
  return matchingBlocks[0]?.segments ?? [];
}

/** Reads the config's "blocks" property into Chameleon's own left/right layout model, rejecting a segment that already references an undefined role before any edit is attempted. */
function readLayout(configPath: string): Layout {
  const config = readOhMyPoshConfig(configPath);
  const blocks = config.blocks ?? [];
  const layout: Layout = {
    left: segmentsForAlignment(configPath, blocks, "left"),
    right: segmentsForAlignment(configPath, blocks, "right"),
  };
  assertLayoutRolesAreDefined(layout);
  return layout;
}

/** Renders `layout` back into Oh My Posh's own "blocks" shape, omitting a side entirely once it has no segments left rather than writing an empty prompt block. */
function blocksFromLayout(layout: Layout): unknown[] {
  const blocks: unknown[] = [];
  if (layout.left.length > 0) blocks.push({ type: "prompt", alignment: "left", segments: layout.left });
  if (layout.right.length > 0) blocks.push({ type: "prompt", alignment: "right", segments: layout.right });
  return blocks;
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
  assertLayoutRolesAreDefined(layout);
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

/** Throws, naming the block, when `atIndex` cannot be inserted at — i.e. is not one of the block's own existing indices or the one right past its end (an append). */
function assertInsertIndex(atIndex: number, block: LayoutBlockName, segmentCount: number): void {
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > segmentCount) {
    throw new Error(`index ${atIndex} is out of range for the "${block}" block, which has ${segmentCount} segment(s)`);
  }
}

/** Throws, naming the block, when `atIndex` does not name one of the block's own existing segments. */
function assertExistingIndex(atIndex: number, block: LayoutBlockName, segmentCount: number): void {
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex >= segmentCount) {
    throw new Error(`index ${atIndex} is out of range for the "${block}" block, which has ${segmentCount} segment(s)`);
  }
}

function withSegments(layout: Layout, block: LayoutBlockName, segments: readonly LayoutSegment[]): Layout {
  return { ...layout, [block]: segments };
}

/** Inserts `segment` into `block` at `atIndex`, defaulting to the end. Pure — the caller is responsible for reading the current layout first and writing the result back. */
export function addSegment(layout: Layout, block: LayoutBlockName, segment: LayoutSegment, atIndex: number = layout[block].length): Layout {
  assertSegmentRolesAreDefined(segment);
  const segments = layout[block];
  assertInsertIndex(atIndex, block, segments.length);
  return withSegments(layout, block, [...segments.slice(0, atIndex), segment, ...segments.slice(atIndex)]);
}

/** Removes the segment at `atIndex` from `block`. Pure — see addSegment. */
export function removeSegment(layout: Layout, block: LayoutBlockName, atIndex: number): Layout {
  const segments = layout[block];
  assertExistingIndex(atIndex, block, segments.length);
  return withSegments(layout, block, [...segments.slice(0, atIndex), ...segments.slice(atIndex + 1)]);
}

/** Moves the segment at `fromIndex` to `toIndex` within the same block, shifting the segments between them. Pure — see addSegment. */
export function reorderSegment(layout: Layout, block: LayoutBlockName, fromIndex: number, toIndex: number): Layout {
  const segments = layout[block];
  assertExistingIndex(fromIndex, block, segments.length);
  assertExistingIndex(toIndex, block, segments.length);

  const segmentToMove = segments[fromIndex];
  if (segmentToMove === undefined) {
    throw new Error(`index ${fromIndex} is out of range for the "${block}" block, which has ${segments.length} segment(s)`);
  }
  const withoutSegment = [...segments.slice(0, fromIndex), ...segments.slice(fromIndex + 1)];
  return withSegments(layout, block, [...withoutSegment.slice(0, toIndex), segmentToMove, ...withoutSegment.slice(toIndex)]);
}

/**
 * Moves the segment at `fromIndex` in `fromBlock` to `toBlock`, at `toIndex`
 * (defaulting to the end of `toBlock`). This is what makes a segment cross
 * from the prompt into the status line, or back — the one operation neither
 * addSegment nor removeSegment can express alone, since a segment moving
 * blocks has to leave one array and land in the other atomically or a
 * caller could observe it in neither.
 */
export function moveSegmentBetweenBlocks(
  layout: Layout,
  fromBlock: LayoutBlockName,
  fromIndex: number,
  toBlock: LayoutBlockName,
  toIndex?: number,
): Layout {
  const fromSegments = layout[fromBlock];
  assertExistingIndex(fromIndex, fromBlock, fromSegments.length);

  const segmentToMove = fromSegments[fromIndex];
  if (segmentToMove === undefined) {
    throw new Error(`index ${fromIndex} is out of range for the "${fromBlock}" block, which has ${fromSegments.length} segment(s)`);
  }

  const toSegments = fromBlock === toBlock ? [...fromSegments.slice(0, fromIndex), ...fromSegments.slice(fromIndex + 1)] : layout[toBlock];
  const resolvedToIndex = toIndex ?? toSegments.length;
  assertInsertIndex(resolvedToIndex, toBlock, toSegments.length);

  const withoutSegment = withSegments(layout, fromBlock, [...fromSegments.slice(0, fromIndex), ...fromSegments.slice(fromIndex + 1)]);
  return withSegments(withoutSegment, toBlock, [
    ...toSegments.slice(0, resolvedToIndex),
    segmentToMove,
    ...toSegments.slice(resolvedToIndex),
  ]);
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
