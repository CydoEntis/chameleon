import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import { ROLES } from "../constants.js";
import { toPalette } from "../palette/palette.js";
import { assignRolesByContrast } from "../palette/roles.js";
import { repairFailingRoles, type ResolvedPalette } from "../palette/repair.js";
import type { Scheme } from "../palette/scheme.js";
import {
  CRLF,
  dedupeConflict,
  detectLineEnding,
  findNodeAtLocation,
  findPropertyNode,
  INSERTED_BLOCK_INDENT,
  parseJsoncTree,
  upsertMarkedBlock,
} from "./marked-json-edit.js";

/** Suffix for the pre-apply copy of a file this adapter edits, that `undoOhMyPosh` restores from. */
const BACKUP_FILE_SUFFIX = ".chameleon-backup";

/**
 * Every edit this adapter makes to the PowerShell profile is wrapped in
 * this pair — the profile is plain text, not JSON, so it gets its own
 * marker comment syntax rather than reusing marked-json-edit's `//` one.
 */
const PROFILE_MARKER_BEGIN = "# ch:begin";
const PROFILE_MARKER_END = "# ch:end";

/**
 * The variable name of the function this block preserves the user's
 * pre-existing `Set-PoshContext` under, and the pointer-path variable it
 * reads. Named once here so the generated PowerShell and the tests that
 * assert on it never drift apart.
 */
const CAPTURED_USER_FUNCTION_NAME = "__ChameleonUserPoshContext";
const POINTER_PATH_VARIABLE_NAME = "__ChameleonPoshPointerPath";
const LAST_APPLIED_AT_VARIABLE_NAME = "__ChameleonPoshLastAppliedAt";

/**
 * The slice of an Oh My Posh config this adapter actually depends on.
 * Everything else — segment definitions, block layout, icon settings, … —
 * is unvalidated and passed through untouched. `palette` is the only part
 * this adapter ever writes.
 */
const OhMyPoshConfigSchema = z
  .object({
    palette: z.record(z.string(), z.string()).optional(),
    blocks: z.array(z.unknown()).optional(),
  })
  .catchall(z.unknown());

export type OhMyPoshConfig = z.infer<typeof OhMyPoshConfigSchema>;

export interface OhMyPoshAdapter {
  detect(): boolean;
  read(): OhMyPoshConfig;
  apply(scheme: Scheme): void;
  reload(): void;
}

/**
 * Oh My Posh exports the active config's path into every shell it
 * initialises. Trusting this over a guessed default is what lets Chameleon
 * find the config a user is actually running, rather than one of several
 * they may have lying around.
 */
function defaultConfigPath(): string | undefined {
  return process.env["POSH_THEME"];
}

/** Where Chameleon records which config it last applied, and when — read by the Set-PoshContext hook installed in the user's profile. */
function defaultPointerPath(): string {
  const localAppData = process.env["LOCALAPPDATA"];
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set — cannot locate Chameleon's Oh My Posh pointer file");
  }
  return path.join(localAppData, "chameleon", "oh-my-posh-pointer.json");
}

/**
 * PowerShell alone knows its own profile path — it depends on the PowerShell
 * edition (Desktop vs Core) and host, and hardcoding either guess would be
 * wrong for the other. Asking `pwsh` is the only way this is ever correct,
 * so it is only ever called for the real default; tests always pass an
 * explicit path and never reach this.
 */
function defaultProfilePath(): string {
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "$PROFILE"], { encoding: "utf8" });
  const profilePath = result.stdout.trim();
  if (result.status !== 0 || profilePath.length === 0) {
    throw new Error("could not determine the PowerShell profile path — is pwsh on PATH?");
  }
  return profilePath;
}

function backupPathFor(targetPath: string): string {
  return `${targetPath}${BACKUP_FILE_SUFFIX}`;
}

function requireConfigPath(configPath: string | undefined): string {
  if (!configPath) {
    throw new Error("no active Oh My Posh config found — is $POSH_THEME set?");
  }
  return configPath;
}

function detectOhMyPosh(configPath: string | undefined): boolean {
  return configPath !== undefined && existsSync(configPath);
}

/**
 * Parses an Oh My Posh config — tolerating the comments and trailing commas
 * a hand-edited JSONC file carries — and validates just enough of its shape
 * for this adapter to trust. A config the user broke must say so by name,
 * never crash and never be silently overwritten.
 */
function readOhMyPoshConfig(configPath: string): OhMyPoshConfig {
  const rawText = readFileSync(configPath, "utf8");
  const parsed: unknown = parseJsonc(rawText, [], { allowTrailingComma: true });
  const validated = OhMyPoshConfigSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`${configPath} is not an Oh My Posh config file Chameleon understands: ${validated.error.message}`);
  }
  return validated.data;
}

/**
 * Inserts `"key": {}` as a new property on `text`'s root object, first
 * child, matching whatever comma the pre-existing first child now needs.
 * Only ever used to seed a `palette` key on a config that predates the
 * feature — most vendored Oh My Posh configs already carry one.
 */
function insertEmptyObjectProperty(configPath: string, text: string, key: string, eol: string): string {
  const root = parseJsoncTree(configPath, text);
  if (root.type !== "object") {
    throw new Error(`${configPath}'s root is not a JSON object`);
  }
  const hasExistingChildren = (root.children?.length ?? 0) > 0;
  const separator = hasExistingChildren ? "," : "";
  const insertion = `${eol}${INSERTED_BLOCK_INDENT}${JSON.stringify(key)}: {}${separator}`;
  return text.slice(0, root.offset + 1) + insertion + text.slice(root.offset + 1);
}

/** The config's top-level `palette` object, creating an empty one first if the config predates the feature. */
function ensurePaletteContainer(configPath: string, text: string, eol: string): string {
  const existing = findNodeAtLocation(parseJsoncTree(configPath, text), ["palette"]);
  if (existing && existing.type === "object") return text;
  if (existing) {
    throw new Error(`${configPath}'s "palette" is not a JSON object`);
  }
  return insertEmptyObjectProperty(configPath, text, "palette", eol);
}

/**
 * Removes a plain, pre-existing entry under each of Chameleon's own role
 * names before writing them — a user who hand-built a palette with a key
 * literally named "accent" would otherwise end up with two, and JSON
 * resolves last-wins, silently keeping their old value over Chameleon's.
 * A palette Chameleon already owns (its content starts with the marker) is
 * left alone, same as every other dedupe in this project.
 */
function dedupeConflictingPaletteKeys(configPath: string, text: string): string {
  let result = text;
  for (const role of ROLES) {
    const container = findNodeAtLocation(parseJsoncTree(configPath, result), ["palette"]);
    if (!container || container.type !== "object") break;
    result = dedupeConflict(result, container, findPropertyNode(container, role));
  }
  return result;
}

/** Renders the resolved palette as the role-keyed lines Chameleon owns inside the `palette` object — `"accent": "#89b4fa"` per role, so segments elsewhere can reference it as `p:accent`. */
function buildPaletteBlockContent(resolvedPalette: ResolvedPalette, eol: string): string {
  return ROLES.map(
    (role) => `${INSERTED_BLOCK_INDENT}${JSON.stringify(role)}: ${JSON.stringify(resolvedPalette[role].hex)}`,
  ).join(`,${eol}`);
}

/**
 * Upserts Chameleon's six role entries into the config's `palette` object.
 * This is the only part of the config this adapter ever edits — `blocks`
 * and everything else are never touched, which is what leaves the segment
 * list byte-identical across a theme swap: every segment already resolves
 * its colour through `p:<role>`, so retinting is just swapping what those
 * names point at.
 */
function upsertPaletteEntries(configPath: string, text: string, resolvedPalette: ResolvedPalette): string {
  const eol = detectLineEnding(text);
  const withContainer = ensurePaletteContainer(configPath, text, eol);
  const dedupedText = dedupeConflictingPaletteKeys(configPath, withContainer);
  const container = findNodeAtLocation(parseJsoncTree(configPath, dedupedText), ["palette"]);
  if (!container || container.type !== "object") {
    throw new Error(`${configPath} is missing a "palette" object`);
  }
  return upsertMarkedBlock(dedupedText, container, buildPaletteBlockContent(resolvedPalette, eol), eol);
}

/** A PowerShell single-quoted string literal for `value` — `'` doubled, nothing else escaped, since single-quoted strings do not expand variables. */
function toPowerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The body Chameleon owns inside the profile's marker block. It captures
 * whatever `Set-PoshContext` the user's own profile already defined above
 * this point — under a different name, never by editing the user's own
 * lines — then redefines `Set-PoshContext` to call that capture first and
 * its own pointer check after. Oh My Posh calls `Set-PoshContext` once per
 * prompt render, so this is what lets an already-open shell notice a swap
 * without being told: the moment the pointer's timestamp moves, the next
 * prompt re-runs `oh-my-posh init` against the (possibly unchanged) config
 * path, which re-reads the file and picks up the new palette values.
 */
function buildSetPoshContextBlockContent(pointerPath: string): string {
  const pointerPathLiteral = toPowerShellSingleQuotedLiteral(pointerPath);
  return [
    "if (Get-Command Set-PoshContext -ErrorAction SilentlyContinue) {",
    `    \${function:global:${CAPTURED_USER_FUNCTION_NAME}} = \${function:Set-PoshContext}`,
    "}",
    "",
    `$global:${POINTER_PATH_VARIABLE_NAME} = ${pointerPathLiteral}`,
    `$global:${LAST_APPLIED_AT_VARIABLE_NAME} = $null`,
    "",
    "function global:Set-PoshContext {",
    `    if (Get-Command ${CAPTURED_USER_FUNCTION_NAME} -ErrorAction SilentlyContinue) {`,
    `        ${CAPTURED_USER_FUNCTION_NAME}`,
    "    }",
    "",
    `    if (Test-Path -LiteralPath $global:${POINTER_PATH_VARIABLE_NAME}) {`,
    `        $chameleonPointer = Get-Content -LiteralPath $global:${POINTER_PATH_VARIABLE_NAME} -Raw | ConvertFrom-Json`,
    `        if ($chameleonPointer.appliedAt -ne $global:${LAST_APPLIED_AT_VARIABLE_NAME}) {`,
    `            $global:${LAST_APPLIED_AT_VARIABLE_NAME} = $chameleonPointer.appliedAt`,
    "            oh-my-posh init pwsh --config $chameleonPointer.configPath | Invoke-Expression",
    "        }",
    "    }",
    "}",
  ].join("\n");
}

/**
 * Replaces Chameleon's own marker span in `text` with a freshly built one,
 * or appends it — on its own blank line — if this is the first apply.
 * Everything outside the span, including a user-authored `Set-PoshContext`
 * earlier in the file, is never read for content and never rewritten.
 */
function upsertProfileBlock(text: string, ownedContent: string, eol: string): string {
  const block = `${PROFILE_MARKER_BEGIN}${eol}${ownedContent}${eol}${PROFILE_MARKER_END}`;
  const beginIndex = text.indexOf(PROFILE_MARKER_BEGIN);

  if (beginIndex === -1) {
    const separator = text.length === 0 ? "" : text.endsWith(eol) ? eol : `${eol}${eol}`;
    return `${text}${separator}${block}${eol}`;
  }

  const endIndex = text.indexOf(PROFILE_MARKER_END, beginIndex);
  if (endIndex === -1) {
    throw new Error("profile has a ch:begin marker with no matching ch:end — cannot safely edit it");
  }
  return text.slice(0, beginIndex) + block + text.slice(endIndex + PROFILE_MARKER_END.length);
}

/**
 * Backs up the profile (if one exists yet — a fresh PowerShell install has
 * none) and upserts Chameleon's Set-PoshContext block into it, creating the
 * profile and its parent directory when neither exists.
 */
function applySetPoshContext(profilePath: string, pointerPath: string): void {
  const profileExists = existsSync(profilePath);
  const originalText = profileExists ? readFileSync(profilePath, "utf8") : "";
  if (profileExists) {
    copyFileSync(profilePath, backupPathFor(profilePath));
  }

  const eol = originalText.length > 0 ? detectLineEnding(originalText) : CRLF;
  const updatedText = upsertProfileBlock(originalText, buildSetPoshContextBlockContent(pointerPath), eol);

  mkdirSync(path.dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, updatedText, "utf8");
}

/**
 * Records which config Chameleon last applied, and when. This file is
 * entirely Chameleon's own — nothing in it is user-authored — so unlike
 * every config this adapter edits, it needs no backup: there is no prior
 * state for a user to lose.
 */
function writePointerFile(pointerPath: string, configPath: string): void {
  mkdirSync(path.dirname(pointerPath), { recursive: true });
  const pointer = { configPath, appliedAt: new Date().toISOString() };
  writeFileSync(pointerPath, JSON.stringify(pointer, null, 2), "utf8");
}

/**
 * Backs up the config, swaps its palette lookup table for `scheme`'s
 * resolved roles, then writes the pointer file and (re)installs the
 * Set-PoshContext hook that makes an already-open shell notice on its own
 * next prompt.
 */
function applyOhMyPoshScheme(configPath: string, pointerPath: string, profilePath: string, scheme: Scheme): void {
  if (!existsSync(configPath)) {
    throw new Error(`no Oh My Posh config found at ${configPath}`);
  }

  copyFileSync(configPath, backupPathFor(configPath));

  const originalText = readFileSync(configPath, "utf8");
  const resolvedPalette = repairFailingRoles(assignRolesByContrast(toPalette(scheme))).palette;
  const updatedText = upsertPaletteEntries(configPath, originalText, resolvedPalette);
  writeFileSync(configPath, updatedText, "utf8");

  writePointerFile(pointerPath, configPath);
  applySetPoshContext(profilePath, pointerPath);
}

/**
 * Nothing to trigger here — the pointer file written during `apply` is what
 * an already-running shell's own Set-PoshContext hook notices, on its own,
 * the next time Oh My Posh renders a prompt. See applySetPoshContext.
 */
function reloadOhMyPosh(): void {
  // Intentional no-op — see the doc comment above.
}

/**
 * Builds the Oh My Posh adapter. `configPath` defaults to the config Oh My
 * Posh itself reports as active; `pointerPath` and `profilePath` default to
 * their real locations and are only ever overridden by tests, which point
 * them at fixture copies so nothing here touches a real profile.
 */
export function createOhMyPoshAdapter(
  configPath: string | undefined = defaultConfigPath(),
  pointerPath: string = defaultPointerPath(),
  profilePath: string = defaultProfilePath(),
): OhMyPoshAdapter {
  return {
    detect: () => detectOhMyPosh(configPath),
    read: () => readOhMyPoshConfig(requireConfigPath(configPath)),
    apply: (scheme) => applyOhMyPoshScheme(requireConfigPath(configPath), pointerPath, profilePath, scheme),
    reload: () => reloadOhMyPosh(),
  };
}

function restoreBackup(targetPath: string): void {
  const backupPath = backupPathFor(targetPath);
  if (!existsSync(backupPath)) {
    throw new Error(`no backup found at ${backupPath} — nothing to undo`);
  }
  copyFileSync(backupPath, targetPath);
}

/**
 * Undoes a write to a file that `apply` may have created rather than
 * edited — a fresh PowerShell install has no profile yet, so
 * `applySetPoshContext` writes none in that case, and there is nothing to
 * restore from. The correct undo of a creation is removing what Chameleon
 * created, not failing because there was never a "before".
 */
function restoreOrRemoveIfCreated(targetPath: string): void {
  const backupPath = backupPathFor(targetPath);
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, targetPath);
    return;
  }
  if (existsSync(targetPath)) {
    rmSync(targetPath);
  }
}

/**
 * Restores the config and the profile to their pre-apply state. Not part of
 * the adapter interface — undo is a user command, not a step in the theming
 * pipeline — but it lives beside the adapter because the backups' locations
 * are this file's business. The config always has a backup (apply refuses
 * to run without one already existing); the profile may not, so it undoes
 * by removal instead when there was never a prior version.
 */
export function undoOhMyPosh(
  configPath: string | undefined = defaultConfigPath(),
  profilePath: string = defaultProfilePath(),
): void {
  restoreBackup(requireConfigPath(configPath));
  restoreOrRemoveIfCreated(profilePath);
}
