import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseJsonc, type Node } from "jsonc-parser";
import { z } from "zod";
import { toPalette, type Appearance } from "../palette/palette.js";
import type { Scheme } from "../palette/scheme.js";
import {
  buildArrayEntryBlockContent,
  buildPropertyBlockContent,
  dedupeConflict,
  detectLineEnding,
  findPropertyNode,
  parseJsonTree,
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
 * profiles.defaults' own flat key for the terminal's font family — the
 * setting `ch doctor` names when a Nerd Font is installed but never picked,
 * see CLAUDE.md, "Catches a Nerd Font that is installed but not selected,
 * and names the exact setting to change." Windows Terminal's newer schema
 * also accepts a nested `font.face`, but every real settings.json this
 * adapter has seen — including a fresh default profile — still writes the
 * flat key, so that is the one Chameleon reads and edits.
 */
const FONT_FACE_SETTING_KEY = "fontFace";

/** profiles.defaults' own key for the active colour scheme's name — the setting every `apply` points at the scheme just themed. */
const COLOR_SCHEME_SETTING_KEY = "colorScheme";

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

  const dedupedText = dedupeConflict(text, schemesNode, findSchemeEntryNode(schemesNode, scheme.name));
  const container = requireNode(settingsPath, parseJsonTree(settingsPath, dedupedText), ["schemes"], "array", 'a "schemes" array');
  return upsertMarkedBlock(dedupedText, container, buildArrayEntryBlockContent(scheme, eol), eol);
}

/**
 * Points profiles.defaults[key] at `value`. A pre-existing key of the same
 * name — the common case, since Windows Terminal's own theme picker writes
 * a colorScheme and ships a default fontFace — is removed first, so the
 * result always resolves to exactly one key of that name: Chameleon's.
 * Shared by colorScheme (set on every `apply`) and fontFace (set only by
 * `ch doctor`'s fix for a Nerd Font that is installed but not selected).
 */
function upsertDefaultsProperty(settingsPath: string, text: string, key: string, value: unknown): string {
  const eol = detectLineEnding(text);
  const defaultsNode = requireNode(
    settingsPath,
    parseJsonTree(settingsPath, text),
    ["profiles", "defaults"],
    "object",
    'a "profiles.defaults" object',
  );

  const dedupedText = dedupeConflict(text, defaultsNode, findPropertyNode(defaultsNode, key));
  const container = requireNode(
    settingsPath,
    parseJsonTree(settingsPath, dedupedText),
    ["profiles", "defaults"],
    "object",
    'a "profiles.defaults" object',
  );
  return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent(key, value, eol), eol);
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

  const dedupedText = dedupeConflict(text, root, findPropertyNode(root, "theme"));
  const container = parseJsonTree(settingsPath, dedupedText);
  if (container.type !== "object") {
    throw new Error(`${settingsPath}'s root is not a JSON object`);
  }
  return upsertMarkedBlock(dedupedText, container, buildPropertyBlockContent("theme", appearance, eol), eol);
}

function detectWindowsTerminal(settingsPath: string): boolean {
  return existsSync(settingsPath);
}

/**
 * The font family name Windows Terminal will actually render with, read
 * from already-parsed settings — undefined when the user has never set one
 * (profiles.defaults falls back to Windows Terminal's own bundled font).
 */
export function selectedFontFace(settings: WindowsTerminalSettings): string | undefined {
  const value = settings.profiles?.defaults?.[FONT_FACE_SETTING_KEY];
  return typeof value === "string" ? value : undefined;
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
  const withColorScheme = upsertDefaultsProperty(settingsPath, withScheme, COLOR_SCHEME_SETTING_KEY, scheme.name);
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
 * Backs up settings.json, then sets profiles.defaults.fontFace to
 * `fontFace` — the fix `ch doctor` offers for a Nerd Font that is installed
 * but never selected. Not part of the adapter interface — this is a
 * `ch doctor` fix, not a step in the theming pipeline — but it lives beside
 * the adapter because settings.json's shape and markers are this file's
 * business. Shares `undoWindowsTerminal`'s own backup file, so undoing this
 * edit works the same way undoing an `apply` does.
 */
export function setDefaultFontFace(fontFace: string, settingsPath: string = defaultSettingsPath()): void {
  if (!existsSync(settingsPath)) {
    throw new Error(`no Windows Terminal settings.json found at ${settingsPath}`);
  }

  copyFileSync(settingsPath, backupPathFor(settingsPath));

  const originalText = readFileSync(settingsPath, "utf8");
  const updatedText = upsertDefaultsProperty(settingsPath, originalText, FONT_FACE_SETTING_KEY, fontFace);
  writeFileSync(settingsPath, updatedText, "utf8");
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
