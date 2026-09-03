import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import type { Role } from "../constants.js";
import { toPalette } from "../palette/palette.js";
import { repairFailingRoles } from "../palette/repair.js";
import { assignRolesByContrast } from "../palette/roles.js";
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
 * Chameleon's six roles, resolved from `scheme` and reduced to the flat
 * name-to-hex table Oh My Posh's own `palette` block expects. Segments
 * reference these by name — `p:accent`, `p:muted` — so this table is the
 * only thing that ever needs to change when the active theme changes.
 */
function paletteTableFor(scheme: Scheme): Record<Role, string> {
  const { ground, body, accent, muted, success, error } = repairFailingRoles(assignRolesByContrast(toPalette(scheme))).palette;
  return {
    ground: ground.hex,
    body: body.hex,
    accent: accent.hex,
    muted: muted.hex,
    success: success.hex,
    error: error.hex,
  };
}

function detectOhMyPosh(configPath: string | undefined): boolean {
  return configPath !== undefined && existsSync(configPath);
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
 * Swaps the config's top-level "palette" lookup table for `paletteTable`,
 * scoped between ch:begin/ch:end. Never touches "blocks" — the segment
 * list — which is what keeps a theme swap byte-identical there: every
 * segment already resolves its colour through a `p:` reference, so a new
 * palette table alone is enough to repaint it.
 */
function upsertPaletteTable(configPath: string, text: string, paletteTable: Record<Role, string>): string {
  const eol = detectLineEnding(text);
  const root = parseJsonTree(configPath, text);
  if (root.type !== "object") {
    throw new Error(`${configPath}'s root is not a JSON object`);
  }

  const dedupedText = dedupeConflict(text, root, findPropertyNode(root, "palette"));
  const container = parseJsonTree(configPath, dedupedText);
  if (container.type !== "object") {
    throw new Error(`${configPath}'s root is not a JSON object`);
  }
  return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent("palette", paletteTable, eol), eol);
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
  const updatedConfigText = upsertPaletteTable(configPath, originalText, paletteTableFor(scheme));
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
    detect: () => detectOhMyPosh(configPath),
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
