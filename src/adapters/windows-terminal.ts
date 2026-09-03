import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createScanner, findNodeAtLocation, parse as parseJsonc, parseTree, type Node } from "jsonc-parser";
import { z } from "zod";
import { toPalette, type Appearance } from "../palette/palette.js";
import type { Scheme } from "../palette/scheme.js";

/**
 * Windows Terminal's package family name for the stable release channel.
 * Preview and unpackaged builds live elsewhere; supporting them is future
 * work, not this ticket's.
 */
const STABLE_PACKAGE_FAMILY_NAME = "Microsoft.WindowsTerminal_8wekyb3d8bbwe";

/**
 * Every edit this adapter makes is wrapped in this pair, so a rerun can find
 * and replace its own work, and a human can see at a glance what Chameleon
 * owns.
 */
const MARKER_BEGIN = "// ch:begin";
const MARKER_END = "// ch:end";

/**
 * Indentation given to a freshly inserted marked block. Cosmetic only —
 * JSON does not care, and this does not try to match a file's own indent
 * style.
 */
const INSERTED_BLOCK_INDENT = "    ";

/** Suffix for the pre-apply copy of settings.json that `undoWindowsTerminal` restores from. */
const BACKUP_FILE_SUFFIX = ".chameleon-backup";

const CRLF = "\r\n";
const LF = "\n";

/**
 * jsonc-parser's `SyntaxKind.CommaToken`. `SyntaxKind` is a `const enum`,
 * which this project's `verbatimModuleSyntax` forbids importing — it can
 * only be inlined by a compiler that sees the enum's own declaration, and
 * ambient `.d.ts` types do not qualify. The numeric value is fixed by
 * jsonc-parser's public API, not a tuning knob.
 */
const COMMA_TOKEN = 5;

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

/**
 * The line ending already dominant in `text`. Windows Terminal writes CRLF
 * — the only platform it runs on — but a user's editor may have normalised
 * a file to LF. Every line this adapter writes must match whichever the
 * file already uses: CHM-3 shipped with this hardcoded to "\n", which
 * stripped the carriage return from the line it spliced into a CRLF file.
 */
function detectLineEnding(text: string): string {
  return text.includes(CRLF) ? CRLF : LF;
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
function buildSchemeBlockContent(scheme: Scheme, eol: string): string {
  return JSON.stringify(scheme, null, 2)
    .split(LF)
    .map((line) => `${INSERTED_BLOCK_INDENT}${line}`)
    .join(eol);
}

function buildPropertyBlockContent(key: string, value: string): string {
  return `${INSERTED_BLOCK_INDENT}${JSON.stringify(key)}: ${JSON.stringify(value)}`;
}

/** The `property` node — key, colon and value — for `key` directly inside `container`, or undefined if it carries no such key. */
function findPropertyNode(container: Node, key: string): Node | undefined {
  return container.children?.find(
    (child) => child.type === "property" && child.children?.[0]?.value === key,
  );
}

/** The array element inside `schemesArray` whose own "name" equals `schemeName`, or undefined. */
function findSchemeEntryNode(schemesArray: Node, schemeName: string): Node | undefined {
  return schemesArray.children?.find(
    (entry) => entry.type === "object" && findPropertyNode(entry, "name")?.children?.[1]?.value === schemeName,
  );
}

/**
 * Whether `container`'s own content already starts with Chameleon's marker
 * — i.e. the last apply's marked block is already the first thing inside
 * this container, rather than a plain key the user wrote.
 */
function containerOwnsMarkedBlock(text: string, container: Node): boolean {
  const start = container.offset + 1;
  const end = container.offset + container.length - 1;
  return text.slice(start, end).trimStart().startsWith(MARKER_BEGIN);
}

/**
 * The offset of the next comma token after `offset`, skipping whitespace
 * and comments — or null when the next real token is not a comma, i.e.
 * `offset` sits right before the container's closing bracket.
 */
function commaOffsetAfter(text: string, offset: number): number | null {
  const scanner = createScanner(text, true);
  scanner.setPosition(offset);
  return scanner.scan() === COMMA_TOKEN ? scanner.getTokenOffset() : null;
}

/** The offset right after the newline nearest at-or-before `offset` — i.e. where `offset`'s own line begins. */
function lineStartOffset(text: string, offset: number): number {
  const precedingNewline = text.lastIndexOf(LF, offset - 1);
  return precedingNewline === -1 ? 0 : precedingNewline + 1;
}

/** The offset right after the newline nearest at-or-after `offset` — i.e. where `offset`'s own line ends, newline included. */
function lineEndOffsetInclusive(text: string, offset: number): number {
  const followingNewline = text.indexOf(LF, offset);
  return followingNewline === -1 ? text.length : followingNewline + 1;
}

/**
 * Removes `node` — a property of an object or an element of an array — from
 * `text`, along with exactly the one comma separating it from its
 * siblings. Only the span `node` and that one comma occupy is touched, so a
 * neighbour's own indentation and any comment attached to it survive
 * untouched: a naive removal that reformats whatever happens to sit next to
 * the edit is the same class of bug that shipped CHM-3 broken.
 */
function removeNodeFromContainer(text: string, container: Node, node: Node): string {
  const siblings = container.children ?? [];
  const index = siblings.indexOf(node);
  const previousSibling = index > 0 ? siblings[index - 1] : undefined;

  // Deleting whole lines — from the start of `node`'s own first line
  // through the end of its own last line — is what keeps a sibling's
  // trailing same-line comment out of the blast radius: that comment
  // reads, lexically, as trivia in the *next* sibling's leading gap, not
  // as part of the sibling it actually annotates.
  const withoutNode =
    text.slice(0, lineStartOffset(text, node.offset)) + text.slice(lineEndOffsetInclusive(text, node.offset + node.length));

  if (commaOffsetAfter(text, node.offset + node.length) !== null || !previousSibling) {
    // Either a sibling still follows `node` (its own comma left with its
    // own line, nothing else needs touching), or `node` had no previous
    // sibling to leave a dangling comma behind.
    return withoutNode;
  }

  // `node` was the container's last child: the previous sibling's own
  // trailing comma is now dangling before the closing bracket and has to
  // go too — but nothing else on that sibling's line does.
  const leadingComma = commaOffsetAfter(withoutNode, previousSibling.offset + previousSibling.length);
  if (leadingComma === null) {
    return withoutNode;
  }
  return withoutNode.slice(0, leadingComma) + withoutNode.slice(leadingComma + 1);
}

/**
 * Removes `conflict` from `container` when it is a plain entry the user
 * already had — not Chameleon's own marked block. A container Chameleon
 * already owns is left alone: a rerun means "replace my own block", never
 * "hunt for a duplicate". This is what makes applying to a file that
 * already carries a `theme` or `colorScheme` leave exactly one of each,
 * instead of the silent no-op CHM-3's attempt 1 shipped — JSON resolves
 * last-wins, and the user's untouched original always came last.
 */
function dedupeConflict(text: string, container: Node, conflict: Node | undefined): string {
  if (!conflict || containerOwnsMarkedBlock(text, container)) {
    return text;
  }
  return removeNodeFromContainer(text, container, conflict);
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
function upsertMarkedBlock(text: string, container: Node, ownedContent: string, eol: string): string {
  const containerStart = container.offset + 1;
  const containerEnd = container.offset + container.length - 1;
  const hasExistingBlock = containerOwnsMarkedBlock(text, container);

  // Replacing an existing block removes it, the whitespace we left before
  // it, and the one line ending we left after it — all three are ours to
  // redraw — so this never leaves a stray blank line behind from one apply
  // to the next.
  const markerEndOffset = hasExistingBlock ? text.indexOf(MARKER_END, containerStart) : -1;
  const rightAfterMarkerEnd = markerEndOffset + MARKER_END.length;
  const afterBlockOffset = hasExistingBlock
    ? rightAfterMarkerEnd + (text.startsWith(eol, rightAfterMarkerEnd) ? eol.length : 0)
    : containerStart;

  const hasContentAfterBlock = text.slice(afterBlockOffset, containerEnd).trim().length > 0;
  const separator = hasContentAfterBlock ? "," : "";
  // MARKER_END is always followed by a line ending of our own — `//` is a
  // line comment, so without one it would silently swallow whatever the
  // original file put right after the container's opening bracket.
  const replacement = `${eol}${INSERTED_BLOCK_INDENT}${MARKER_BEGIN}${eol}${ownedContent}${separator}${eol}${INSERTED_BLOCK_INDENT}${MARKER_END}${eol}`;

  return text.slice(0, containerStart) + replacement + text.slice(afterBlockOffset);
}

/**
 * Upserts Chameleon's own scheme entry into schemes[]. Chameleon owns
 * exactly one entry there — the marked block — so switching which scheme is
 * applied replaces its content rather than accumulating an entry per theme
 * ever applied. A plain entry the user already had under the same name is
 * removed first, so re-applying a scheme already present in schemes[] never
 * duplicates it.
 */
function upsertSchemesEntry(settingsPath: string, text: string, scheme: Scheme): string {
  const eol = detectLineEnding(text);
  const schemesNode = findNodeAtLocation(parseSettingsTree(settingsPath, text), ["schemes"]);
  if (!schemesNode || schemesNode.type !== "array") {
    throw new Error(`${settingsPath} is missing a "schemes" array`);
  }

  const dedupedText = dedupeConflict(text, schemesNode, findSchemeEntryNode(schemesNode, scheme.name));
  const container = findNodeAtLocation(parseSettingsTree(settingsPath, dedupedText), ["schemes"]);
  if (!container || container.type !== "array") {
    throw new Error(`${settingsPath} is missing a "schemes" array`);
  }
  return upsertMarkedBlock(dedupedText, container, buildSchemeBlockContent(scheme, eol), eol);
}

/**
 * Points profiles.defaults.colorScheme at `schemeName`. A pre-existing
 * colorScheme — the common case, since Windows Terminal's own theme picker
 * writes one — is removed first, so the result always resolves to exactly
 * one colorScheme key: Chameleon's.
 */
function upsertDefaultColorScheme(settingsPath: string, text: string, schemeName: string): string {
  const eol = detectLineEnding(text);
  const defaultsNode = findNodeAtLocation(parseSettingsTree(settingsPath, text), ["profiles", "defaults"]);
  if (!defaultsNode || defaultsNode.type !== "object") {
    throw new Error(`${settingsPath} is missing a "profiles.defaults" object`);
  }

  const dedupedText = dedupeConflict(text, defaultsNode, findPropertyNode(defaultsNode, "colorScheme"));
  const container = findNodeAtLocation(parseSettingsTree(settingsPath, dedupedText), ["profiles", "defaults"]);
  if (!container || container.type !== "object") {
    throw new Error(`${settingsPath} is missing a "profiles.defaults" object`);
  }
  return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent("colorScheme", schemeName), eol);
}

/**
 * Sets the top-level theme to the scheme's own appearance. A pre-existing
 * theme — anyone who has touched Windows Terminal's own theme picker has
 * one — is removed first, so the result always resolves to exactly one
 * theme key: Chameleon's.
 */
function upsertTopLevelTheme(settingsPath: string, text: string, appearance: Appearance): string {
  const eol = detectLineEnding(text);
  const root = parseSettingsTree(settingsPath, text);
  if (root.type !== "object") {
    throw new Error(`${settingsPath}'s root is not a JSON object`);
  }

  const dedupedText = dedupeConflict(text, root, findPropertyNode(root, "theme"));
  const container = parseSettingsTree(settingsPath, dedupedText);
  if (container.type !== "object") {
    throw new Error(`${settingsPath}'s root is not a JSON object`);
  }
  return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent("theme", appearance), eol);
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
    throw new Error(
      `${settingsPath} is not a Windows Terminal settings file Chameleon understands: ${validated.error.message}`,
    );
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
export function createWindowsTerminalAdapter(settingsPath: string = defaultSettingsPath()): WindowsTerminalAdapter {
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
