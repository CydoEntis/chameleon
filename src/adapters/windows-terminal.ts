import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findNodeAtLocation, parse as parseJsonc, parseTree, type Node } from "jsonc-parser";
import { z } from "zod";
import { toPalette, type Appearance } from "../palette/palette.js";
import type { Scheme } from "../palette/scheme.js";

/**
 * Windows Terminal's package family name for the stable release channel.
 * Preview and unpackaged builds live elsewhere; supporting them is future
 * work, not this ticket's — see the summary this adapter shipped with.
 */
const STABLE_PACKAGE_FAMILY_NAME = "Microsoft.WindowsTerminal_8wekyb3d8bbwe";

/** Every edit this adapter makes is wrapped in this pair, so a rerun can find and replace its own work, and a human can see at a glance what Chameleon owns. */
const MARKER_BEGIN = "// ch:begin";
const MARKER_END = "// ch:end";

/** Indentation given to a freshly inserted marked block. Cosmetic only — JSON does not care, and this does not try to match a file's own indent style. */
const INSERTED_BLOCK_INDENT = "    ";

/** Suffix for the pre-apply copy of settings.json that `undoWindowsTerminal` restores from. */
const BACKUP_FILE_SUFFIX = ".chameleon-backup";

/**
 * The slice of Windows Terminal's settings.json this adapter actually
 * depends on. Everything else in a real settings.json (fonts, keybindings,
 * profile lists, …) is unvalidated and passed through untouched — this
 * schema exists only to catch the shapes this adapter cannot safely edit,
 * never to police the rest of a user's config.
 */
const WindowsTerminalSettingsSchema = z
  .object({
    schemes: z.array(z.unknown()).optional(),
    profiles: z
      .object({ defaults: z.record(z.string(), z.unknown()).optional() })
      .catchall(z.unknown())
      .optional(),
    theme: z.unknown().optional(),
  })
  .catchall(z.unknown());

export type WindowsTerminalSettings = z.infer<typeof WindowsTerminalSettingsSchema>;

export interface WindowsTerminalAdapter {
  detect(): boolean;
  read(): WindowsTerminalSettings;
  apply(scheme: Scheme): void;
  reload(): void;
}

/** Where Windows Terminal (stable) keeps settings.json, under the user's package LocalState directory. */
function defaultSettingsPath(): string {
  const localAppData = process.env["LOCALAPPDATA"];
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set — cannot locate Windows Terminal's settings.json");
  }
  return path.join(localAppData, "Packages", STABLE_PACKAGE_FAMILY_NAME, "LocalState", "settings.json");
}

function backupPathFor(settingsPath: string): string {
  return `${settingsPath}${BACKUP_FILE_SUFFIX}`;
}

function parseSettingsTree(settingsPath: string, text: string): Node {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  if (!tree) {
    throw new Error(`${settingsPath} could not be parsed as JSON`);
  }
  return tree;
}

/**
 * Renders a Scheme as the multi-line JSON literal Windows Terminal expects
 * inside schemes[], indented so it reads as one entry among siblings rather
 * than flush against the array's own indent level.
 */
function buildSchemeBlockContent(scheme: Scheme): string {
  return JSON.stringify(scheme, null, 2)
    .split("\n")
    .map((line) => `${INSERTED_BLOCK_INDENT}${line}`)
    .join("\n");
}

function buildPropertyBlockContent(key: string, value: string): string {
  return `${INSERTED_BLOCK_INDENT}${JSON.stringify(key)}: ${JSON.stringify(value)}`;
}

/**
 * Inserts `ownedContent` just inside `container`'s opening bracket, wrapped
 * in ch:begin/ch:end. If Chameleon's own marked block is already the first
 * thing in the container — from an earlier apply — only that block is
 * replaced; everything else in the file, including a user's own comments
 * and key order, never moves. This is what makes upserting a scheme and
 * applying the same theme twice idempotent: the same input always produces
 * the same marked block, and nothing outside it is ever touched.
 *
 * A trailing comma is added only when there is real content left after the
 * block — an empty schemes[] or a defaults{} with nothing else in it must
 * not gain a dangling comma before the closing bracket.
 */
function upsertMarkedBlock(text: string, container: Node, ownedContent: string): string {
  const containerStart = container.offset + 1;
  const containerEnd = container.offset + container.length - 1;
  const hasExistingBlock = text.slice(containerStart, containerEnd).trimStart().startsWith(MARKER_BEGIN);

  // Replacing an existing block removes it, the whitespace we left before
  // it, and the one newline we left after it — all three are ours to
  // redraw — so this never leaves a stray blank line behind from one apply
  // to the next.
  const markerEndOffset = hasExistingBlock ? text.indexOf(MARKER_END, containerStart) : -1;
  const rightAfterMarkerEnd = markerEndOffset + MARKER_END.length;
  const afterBlockOffset = hasExistingBlock
    ? rightAfterMarkerEnd + (text[rightAfterMarkerEnd] === "\n" ? 1 : 0)
    : containerStart;

  const hasContentAfterBlock = text.slice(afterBlockOffset, containerEnd).trim().length > 0;
  const separator = hasContentAfterBlock ? "," : "";
  // MARKER_END is always followed by a newline of our own — `//` is a line
  // comment, so without one it would silently swallow whatever the original
  // file put right after the container's opening bracket.
  const replacement = `\n${INSERTED_BLOCK_INDENT}${MARKER_BEGIN}\n${ownedContent}${separator}\n${INSERTED_BLOCK_INDENT}${MARKER_END}\n`;

  return text.slice(0, containerStart) + replacement + text.slice(afterBlockOffset);
}

/**
 * Upserts Chameleon's own scheme entry into schemes[]. Chameleon owns
 * exactly one entry there — the marked block — so switching which scheme is
 * applied replaces its content rather than accumulating an entry per theme
 * ever applied.
 */
function upsertSchemesEntry(settingsPath: string, text: string, scheme: Scheme): string {
  const schemesNode = findNodeAtLocation(parseSettingsTree(settingsPath, text), ["schemes"]);
  if (!schemesNode || schemesNode.type !== "array") {
    throw new Error(`${settingsPath} is missing a "schemes" array`);
  }
  return upsertMarkedBlock(text, schemesNode, buildSchemeBlockContent(scheme));
}

function upsertDefaultColorScheme(settingsPath: string, text: string, schemeName: string): string {
  const defaultsNode = findNodeAtLocation(parseSettingsTree(settingsPath, text), ["profiles", "defaults"]);
  if (!defaultsNode || defaultsNode.type !== "object") {
    throw new Error(`${settingsPath} is missing a "profiles.defaults" object`);
  }
  return upsertMarkedBlock(text, defaultsNode, buildPropertyBlockContent("colorScheme", schemeName));
}

function upsertTopLevelTheme(settingsPath: string, text: string, appearance: Appearance): string {
  const root = parseSettingsTree(settingsPath, text);
  if (root.type !== "object") {
    throw new Error(`${settingsPath}'s root is not a JSON object`);
  }
  return upsertMarkedBlock(text, root, buildPropertyBlockContent("theme", appearance));
}

function detectWindowsTerminal(settingsPath: string): boolean {
  return existsSync(settingsPath);
}

/**
 * Parses settings.json — tolerating the comments and trailing commas a
 * hand-edited JSONC file carries — and validates just enough of its shape
 * for this adapter to trust. A config the user broke must say so by name,
 * never crash and never be silently overwritten.
 */
function readWindowsTerminalSettings(settingsPath: string): WindowsTerminalSettings {
  const rawText = readFileSync(settingsPath, "utf8");
  const parsed: unknown = parseJsonc(rawText, [], { allowTrailingComma: true });
  const validated = WindowsTerminalSettingsSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`${settingsPath} is not a Windows Terminal settings file Chameleon understands: ${validated.error.message}`);
  }
  return validated.data;
}

/**
 * Backs up the current settings.json, then upserts `scheme` into schemes[],
 * points profiles.defaults.colorScheme at it, and sets the top-level theme
 * to the scheme's own appearance — all three edits scoped between
 * ch:begin/ch:end, everything else in the file untouched.
 */
function applyWindowsTerminalScheme(settingsPath: string, scheme: Scheme): void {
  if (!existsSync(settingsPath)) {
    throw new Error(`no Windows Terminal settings.json found at ${settingsPath}`);
  }

  copyFileSync(settingsPath, backupPathFor(settingsPath));

  const originalText = readFileSync(settingsPath, "utf8");
  const appearance = toPalette(scheme).appearance;

  const withScheme = upsertSchemesEntry(settingsPath, originalText, scheme);
  const withColorScheme = upsertDefaultColorScheme(settingsPath, withScheme, scheme.name);
  const withTheme = upsertTopLevelTheme(settingsPath, withColorScheme, appearance);

  writeFileSync(settingsPath, withTheme, "utf8");
}

/**
 * Windows Terminal watches its own settings.json and reloads live the
 * moment it changes, so there is nothing left for Chameleon to trigger —
 * this exists only because the adapter interface requires it.
 */
function reloadWindowsTerminal(): void {
  // Intentional no-op — see the doc comment above.
}

/**
 * Builds the Windows Terminal adapter. `settingsPath` defaults to the real
 * stable-channel location and is only ever overridden by tests, which point
 * it at a fixture copy so nothing here touches a real settings.json.
 */
export function createWindowsTerminalAdapter(
  settingsPath: string = defaultSettingsPath(),
): WindowsTerminalAdapter {
  return {
    detect: () => detectWindowsTerminal(settingsPath),
    read: () => readWindowsTerminalSettings(settingsPath),
    apply: (scheme) => applyWindowsTerminalScheme(settingsPath, scheme),
    reload: () => reloadWindowsTerminal(),
  };
}

/**
 * Restores settings.json from the backup written by the most recent
 * `apply`. Not part of the adapter interface — undo is a user command, not
 * a step in the theming pipeline — but it lives beside the adapter because
 * the backup file's location and format are this file's business.
 */
export function undoWindowsTerminal(settingsPath: string = defaultSettingsPath()): void {
  const backupPath = backupPathFor(settingsPath);
  if (!existsSync(backupPath)) {
    throw new Error(`no backup found at ${backupPath} — nothing to undo`);
  }
  copyFileSync(backupPath, settingsPath);
}
