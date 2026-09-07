import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseJsonc, type Node } from "jsonc-parser";
import { z } from "zod";
import { toPalette, type Appearance } from "../palette/palette.js";
import type { Scheme } from "../palette/scheme.js";
import { isWindows } from "./platform.js";
import {
  buildArrayEntryBlockContent,
  buildPropertyBlockContent,
  dedupeConflict,
  detectLineEnding,
  findPropertyNode,
  parseJsonTree,
  removeNodeFromContainer,
  requireNode,
  upsertMarkedBlock,
} from "./marked-json-edit.js";

/**
 * Windows Terminal's package family name for the stable release channel.
 * Preview and unpackaged builds live elsewhere; supporting them is future
 * work, not this ticket's.
 */
const STABLE_PACKAGE_FAMILY_NAME = "Microsoft.WindowsTerminal_8wekyb3d8bbwe";

/** Suffix for the pre-apply copy of settings.json that `undoWindowsTerminal` restores from. */
const BACKUP_FILE_SUFFIX = ".chameleon-backup";

/**
 * Prefix Chameleon puts on the name of every scheme it writes into
 * schemes[] and points profiles.defaults.colorScheme at. Windows Terminal
 * will not let one of its own built-in scheme names be redefined: it
 * accepts the write, then silently forks the incoming scheme to "<name>
 * (modified N)", repoints colorScheme at the fork, and rewrites the whole
 * file through its own serialiser in the process — discarding the
 * ch:begin/ch:end markers this adapter relies on to find its own block
 * again. One bundled pack's own scheme name ("One Half Dark") collides with
 * a Windows Terminal built-in of the same name; nothing about a future
 * built-in, or a user's own hand-added scheme, guarantees no other bundled
 * pack ever will. Prefixing every name Chameleon writes makes that
 * collision impossible rather than merely unlikely today. See CHM-91.
 */
const CHAMELEON_SCHEME_NAME_PREFIX = "Chameleon: ";

/** The name Chameleon actually writes to schemes[] and colorScheme for a scheme named `schemeName` — see CHAMELEON_SCHEME_NAME_PREFIX. */
function windowsTerminalSchemeName(schemeName: string): string {
  return `${CHAMELEON_SCHEME_NAME_PREFIX}${schemeName}`;
}

/**
 * Matches the name Windows Terminal gives a scheme it forks when it will
 * not let a built-in of the same name be redefined — "One Half Dark
 * (modified 29)" forked from "One Half Dark" — capturing the name it was
 * forked from. Only ever produced by Windows Terminal itself, on a
 * settings.json this adapter wrote to before CHM-91's fix; nothing here
 * writes a name shaped like this anymore. See
 * removeDeadWindowsTerminalSchemeForks.
 */
const WINDOWS_TERMINAL_SCHEME_FORK_NAME_PATTERN = /^(.+) \(modified(?: \d+)?\)$/;

/** winget's package identifier for Windows Terminal (stable), used to build the one-line install command `ch doctor` offers. */
export const WINDOWS_TERMINAL_WINGET_PACKAGE_ID = "Microsoft.WindowsTerminal";

/**
 * The slice of Windows Terminal's settings.json this adapter actually
 * depends on. Everything else in a real settings.json (keybindings, profile
 * lists, …) is unvalidated and passed through untouched — this schema
 * exists only to catch the shapes this adapter cannot safely edit, never to
 * police the rest of a user's config.
 *
 * `font.face` and `fontFace` are both modelled because both ship in the
 * wild: current Windows Terminal writes the nested `font: { face }`, but a
 * settings.json a user hand-edited — or one Windows Terminal wrote before
 * this shape existed — may still carry the flat `fontFace`. See
 * selectedFontFace, which decides between them the same way Windows
 * Terminal itself does.
 */
const WindowsTerminalSettingsSchema = z
  .object({
    schemes: z.array(z.unknown()).optional(),
    profiles: z
      .object({
        defaults: z
          .object({
            font: z.object({ face: z.string().optional() }).catchall(z.unknown()).optional(),
            fontFace: z.string().optional(),
          })
          .catchall(z.unknown())
          .optional(),
      })
      .catchall(z.unknown())
      .optional(),
    theme: z.unknown().optional(),
  })
  .catchall(z.unknown());

export type WindowsTerminalSettings = z.infer<typeof WindowsTerminalSettingsSchema>;

/**
 * The Nerd Font face Windows Terminal will actually render with, honouring
 * whichever shape `settings` carries. When both the nested `font.face` and
 * the legacy flat `fontFace` are present, the nested value wins — that is
 * what Windows Terminal itself honours. See CHM-15.
 */
export function selectedFontFace(settings: WindowsTerminalSettings): string | undefined {
  const defaults = settings.profiles?.defaults;
  return defaults?.font?.face ?? defaults?.fontFace;
}

/**
 * Whether `settings`'s own colour scheme selection already matches `scheme`
 * — the same value applyWindowsTerminalScheme itself writes via
 * upsertDefaultColorScheme (windowsTerminalSchemeName(scheme.name), not
 * scheme.name itself — see CHAMELEON_SCHEME_NAME_PREFIX), so a mismatch
 * means this target has drifted from whatever pack `ch` last recorded as
 * active. See CHM-27.
 */
export function windowsTerminalMatchesScheme(settings: WindowsTerminalSettings, scheme: Scheme): boolean {
  return settings.profiles?.defaults?.["colorScheme"] === windowsTerminalSchemeName(scheme.name);
}

export interface WindowsTerminalAdapter {
  detect(): boolean;
  read(): WindowsTerminalSettings;
  apply(scheme: Scheme): void;
  reload(): string | undefined;
}

/**
 * Where Windows Terminal (stable) keeps settings.json, under the user's
 * package LocalState directory — undefined on every platform but Windows,
 * where the app itself does not exist, so `detect()` can report "not found"
 * cleanly instead of throwing on a LOCALAPPDATA read that would never
 * resolve to anything real. See CHM-25.
 */
export function defaultWindowsTerminalSettingsPath(): string | undefined {
  if (!isWindows()) return undefined;
  const localAppData = process.env["LOCALAPPDATA"];
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set — cannot locate Windows Terminal's settings.json");
  }
  return path.join(localAppData, "Packages", STABLE_PACKAGE_FAMILY_NAME, "LocalState", "settings.json");
}

function requireSettingsPath(settingsPath: string | undefined): string {
  if (!settingsPath) {
    throw new Error("Windows Terminal is not available on this platform — there is no settings.json to edit");
  }
  return settingsPath;
}

function backupPathFor(settingsPath: string): string {
  return `${settingsPath}${BACKUP_FILE_SUFFIX}`;
}

/** The array element inside `schemesArray` whose own "name" equals `schemeName`, or undefined. */
function findSchemeEntryNode(schemesArray: Node, schemeName: string): Node | undefined {
  return schemesArray.children?.find(
    (entry) => entry.type === "object" && findPropertyNode(entry, "name")?.children?.[1]?.value === schemeName,
  );
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
  const schemesNode = requireNode(settingsPath, parseJsonTree(settingsPath, text), ["schemes"], "array", 'a "schemes" array');

  const dedupedText = dedupeConflict(text, schemesNode, findSchemeEntryNode(schemesNode, scheme.name), "scheme");
  const container = requireNode(settingsPath, parseJsonTree(settingsPath, dedupedText), ["schemes"], "array", 'a "schemes" array');
  return upsertMarkedBlock(dedupedText, container, buildArrayEntryBlockContent(scheme, eol), eol, "scheme");
}

/**
 * Points profiles.defaults.colorScheme at `schemeName`. A pre-existing
 * colorScheme — the common case, since Windows Terminal's own theme picker
 * writes one — is removed first, so the result always resolves to exactly
 * one colorScheme key: Chameleon's.
 */
function upsertDefaultColorScheme(settingsPath: string, text: string, schemeName: string): string {
  const eol = detectLineEnding(text);
  const defaultsNode = requireNode(
    settingsPath,
    parseJsonTree(settingsPath, text),
    ["profiles", "defaults"],
    "object",
    'a "profiles.defaults" object',
  );

  const dedupedText = dedupeConflict(text, defaultsNode, findPropertyNode(defaultsNode, "colorScheme"), "colorScheme");
  const container = requireNode(
    settingsPath,
    parseJsonTree(settingsPath, dedupedText),
    ["profiles", "defaults"],
    "object",
    'a "profiles.defaults" object',
  );
  return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent("colorScheme", schemeName, eol), eol, "colorScheme");
}

/**
 * Sets the top-level theme to the scheme's own appearance. A pre-existing
 * theme — anyone who has touched Windows Terminal's own theme picker has
 * one — is removed first, so the result always resolves to exactly one
 * theme key: Chameleon's.
 */
function upsertTopLevelTheme(settingsPath: string, text: string, appearance: Appearance): string {
  const eol = detectLineEnding(text);
  const root = parseJsonTree(settingsPath, text);
  if (root.type !== "object") {
    throw new Error(`${settingsPath}'s root is not a JSON object`);
  }

  const dedupedText = dedupeConflict(text, root, findPropertyNode(root, "theme"), "theme");
  const container = parseJsonTree(settingsPath, dedupedText);
  if (container.type !== "object") {
    throw new Error(`${settingsPath}'s root is not a JSON object`);
  }
  return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent("theme", appearance, eol), eol, "theme");
}

/**
 * Which shape of the font setting `defaultsNode` already uses — nested
 * `font: { face }` (current Windows Terminal) or flat `fontFace` (legacy).
 * Neither present defaults to nested, since that is what a fresh Windows
 * Terminal install writes — see the ticket's diagnosis of CHM-7, which
 * always wrote the flat shape and left a nested settings.json with two
 * competing font settings.
 */
function existingFontShape(defaultsNode: Node): "nested" | "flat" {
  const fontNode = findPropertyNode(defaultsNode, "font");
  if (fontNode?.children?.[1]?.type === "object") return "nested";
  if (findPropertyNode(defaultsNode, "fontFace")) return "flat";
  return "nested";
}

/**
 * Points profiles.defaults at `fontFace`, writing into whichever shape the
 * file already uses so a selection never leaves two competing font
 * settings. The nested case merges into the existing `font` object rather
 * than replacing it outright, so a sibling like `size` survives untouched —
 * only `face` is Chameleon's to change.
 */
function upsertSelectedFont(settingsPath: string, text: string, fontFace: string): string {
  const eol = detectLineEnding(text);
  const defaultsNode = requireNode(
    settingsPath,
    parseJsonTree(settingsPath, text),
    ["profiles", "defaults"],
    "object",
    'a "profiles.defaults" object',
  );

  if (existingFontShape(defaultsNode) === "flat") {
    const dedupedText = dedupeConflict(text, defaultsNode, findPropertyNode(defaultsNode, "fontFace"), "fontFace");
    const container = requireNode(
      settingsPath,
      parseJsonTree(settingsPath, dedupedText),
      ["profiles", "defaults"],
      "object",
      'a "profiles.defaults" object',
    );
    return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent("fontFace", fontFace, eol), eol, "fontFace");
  }

  const existingFont = readWindowsTerminalSettings(settingsPath).profiles?.defaults?.font ?? {};
  const dedupedText = dedupeConflict(text, defaultsNode, findPropertyNode(defaultsNode, "font"), "font");
  const container = requireNode(
    settingsPath,
    parseJsonTree(settingsPath, dedupedText),
    ["profiles", "defaults"],
    "object",
    'a "profiles.defaults" object',
  );
  return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent("font", { ...existingFont, face: fontFace }, eol), eol, "font");
}

function detectWindowsTerminal(settingsPath: string | undefined): boolean {
  return settingsPath !== undefined && existsSync(settingsPath);
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
 * Backs up the current settings.json, then upserts `scheme` — under
 * windowsTerminalSchemeName(scheme.name), never scheme.name itself, so
 * Windows Terminal never mistakes it for one of its own built-ins and forks
 * it (CHM-91) — into schemes[], points profiles.defaults.colorScheme at it,
 * and sets the top-level theme to the scheme's own appearance — all three
 * edits scoped between ch:begin/ch:end, everything else in the file
 * untouched.
 */
function applyWindowsTerminalScheme(settingsPath: string, scheme: Scheme): void {
  if (!existsSync(settingsPath)) {
    throw new Error(`no Windows Terminal settings.json found at ${settingsPath}`);
  }

  copyFileSync(settingsPath, backupPathFor(settingsPath));

  const originalText = readFileSync(settingsPath, "utf8");
  const appearance = toPalette(scheme).appearance;
  const namedScheme: Scheme = { ...scheme, name: windowsTerminalSchemeName(scheme.name) };

  const withScheme = upsertSchemesEntry(settingsPath, originalText, namedScheme);
  const withColorScheme = upsertDefaultColorScheme(settingsPath, withScheme, namedScheme.name);
  const withTheme = upsertTopLevelTheme(settingsPath, withColorScheme, appearance);

  writeFileSync(settingsPath, withTheme, "utf8");
}

/**
 * Windows Terminal watches its own settings.json and reloads live the
 * moment it changes, so there is nothing left for Chameleon to trigger —
 * this exists only because the adapter interface requires it. Returns
 * undefined, never a detail: unlike Herdr (CHM-45), there is no "nothing
 * running to tell" case here worth surfacing.
 */
function reloadWindowsTerminal(): string | undefined {
  // Intentional no-op — see the doc comment above.
  return undefined;
}

/**
 * Builds the Windows Terminal adapter. `settingsPath` defaults to the real
 * stable-channel location — undefined on every platform but Windows, where
 * Windows Terminal cannot exist — and is only ever overridden by tests,
 * which point it at a fixture copy so nothing here touches a real
 * settings.json.
 */
export function createWindowsTerminalAdapter(settingsPath: string | undefined = defaultWindowsTerminalSettingsPath()): WindowsTerminalAdapter {
  return {
    detect: () => detectWindowsTerminal(settingsPath),
    read: () => readWindowsTerminalSettings(requireSettingsPath(settingsPath)),
    apply: (scheme) => applyWindowsTerminalScheme(requireSettingsPath(settingsPath), scheme),
    reload: () => reloadWindowsTerminal(),
  };
}

/**
 * Backs up settings.json, then points profiles.defaults at `fontFace` —
 * updating whichever shape the file already uses. Not part of the adapter
 * interface — selecting a font is `ch doctor`'s job, offered when a Nerd
 * Font is installed but not selected, never a step in the theming pipeline
 * — but it lives beside the adapter because settings.json's shape is this
 * file's business.
 */
export function selectWindowsTerminalFont(fontFace: string, settingsPath: string | undefined = defaultWindowsTerminalSettingsPath()): void {
  const resolvedSettingsPath = requireSettingsPath(settingsPath);
  if (!existsSync(resolvedSettingsPath)) {
    throw new Error(`no Windows Terminal settings.json found at ${resolvedSettingsPath}`);
  }

  copyFileSync(resolvedSettingsPath, backupPathFor(resolvedSettingsPath));

  const originalText = readFileSync(resolvedSettingsPath, "utf8");
  const updatedText = upsertSelectedFont(resolvedSettingsPath, originalText, fontFace);

  writeFileSync(resolvedSettingsPath, updatedText, "utf8");
}

/**
 * Restores settings.json from the backup written by the most recent
 * `apply`. Not part of the adapter interface — undo is a user command, not
 * a step in the theming pipeline — but it lives beside the adapter because
 * the backup file's location and format are this file's business.
 */
export function undoWindowsTerminal(settingsPath: string | undefined = defaultWindowsTerminalSettingsPath()): void {
  const resolvedSettingsPath = requireSettingsPath(settingsPath);
  const backupPath = backupPathFor(resolvedSettingsPath);
  if (!existsSync(backupPath)) {
    throw new Error(`no backup found at ${backupPath} — nothing to undo`);
  }
  copyFileSync(backupPath, resolvedSettingsPath);
}

/** Every `name` string schemes[] entries actually carry, in document order — entries missing a readable name are silently skipped rather than a reason to fail the whole scan. */
function schemeEntryNames(schemesNode: Node): string[] {
  return (schemesNode.children ?? [])
    .map((entry) => (entry.type === "object" ? findPropertyNode(entry, "name")?.children?.[1]?.value : undefined))
    .filter((name): name is string => typeof name === "string");
}

/**
 * Every schemes[] entry name that is a dead Windows Terminal fork left
 * behind by CHM-91: shaped like a fork (WINDOWS_TERMINAL_SCHEME_FORK_NAME_PATTERN)
 * *and* the name it was forked from still exists as another entry in the
 * same array — which is only ever true of a fork Windows Terminal itself
 * created, never a scheme a user happened to name with "(modified)" in it,
 * since that name would not also match anything else present. `activeSchemeName`
 * — whatever profiles.defaults.colorScheme currently names — is excluded
 * even when it is shaped like a fork: this function only ever decides what
 * is dead, and the entry actually selected right now is never that, no
 * matter how it got there.
 */
function deadWindowsTerminalSchemeForkNames(schemesNode: Node, activeSchemeName: unknown): string[] {
  const entryNames = schemeEntryNames(schemesNode);
  const entryNameSet = new Set(entryNames);
  return entryNames.filter((name) => {
    if (name === activeSchemeName) return false;
    const forkedFromName = WINDOWS_TERMINAL_SCHEME_FORK_NAME_PATTERN.exec(name)?.[1];
    return forkedFromName !== undefined && entryNameSet.has(forkedFromName);
  });
}

/** Removes the schemes[] entry named exactly `schemeName`, or returns `text` unchanged when no entry carries that name. */
function removeSchemeEntryByName(settingsPath: string, text: string, schemeName: string): string {
  const schemesNode = requireNode(settingsPath, parseJsonTree(settingsPath, text), ["schemes"], "array", 'a "schemes" array');
  const entryNode = findSchemeEntryNode(schemesNode, schemeName);
  if (!entryNode) return text;
  return removeNodeFromContainer(text, schemesNode, entryNode);
}

/**
 * `chm clean`'s Windows Terminal step: removes every dead scheme fork
 * CHM-91 left behind — one "<name> (modified N)" entry in schemes[] per
 * apply of a pack whose scheme name collided with a Windows Terminal
 * built-in, before this ticket's fix stopped Windows Terminal from ever
 * creating one. Backs up first, the same as every other write this adapter
 * makes, and only writes at all when there is something to remove — a
 * settings.json with no dead forks is left byte-for-byte untouched, not
 * merely round-tripped. Whichever entry profiles.defaults.colorScheme
 * currently names is never removed, even if it happens to be shaped like a
 * fork (see deadWindowsTerminalSchemeForkNames) — this only ever cleans up
 * what nothing points at anymore. Returns how many entries were removed.
 */
export function removeDeadWindowsTerminalSchemeForks(settingsPath: string | undefined = defaultWindowsTerminalSettingsPath()): number {
  const resolvedSettingsPath = requireSettingsPath(settingsPath);
  if (!existsSync(resolvedSettingsPath)) {
    throw new Error(`no Windows Terminal settings.json found at ${resolvedSettingsPath}`);
  }

  const activeSchemeName = readWindowsTerminalSettings(resolvedSettingsPath).profiles?.defaults?.["colorScheme"];
  const originalText = readFileSync(resolvedSettingsPath, "utf8");
  const schemesNode = requireNode(resolvedSettingsPath, parseJsonTree(resolvedSettingsPath, originalText), ["schemes"], "array", 'a "schemes" array');
  const deadForkNames = deadWindowsTerminalSchemeForkNames(schemesNode, activeSchemeName);
  if (deadForkNames.length === 0) return 0;

  copyFileSync(resolvedSettingsPath, backupPathFor(resolvedSettingsPath));
  const updatedText = deadForkNames.reduce(
    (text, forkName) => removeSchemeEntryByName(resolvedSettingsPath, text, forkName),
    originalText,
  );
  writeFileSync(resolvedSettingsPath, updatedText, "utf8");

  return deadForkNames.length;
}
