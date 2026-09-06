import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import type { Appearance } from "../palette/palette.js";
import { setUnmarkedTopLevelProperty } from "./marked-json-edit.js";
import { claudeCodeSettingsPath } from "./platform.js";

/** Suffix for the pre-apply copy of settings.json that `undoClaudeCode` restores from. */
const BACKUP_FILE_SUFFIX = ".chameleon-backup";

/**
 * Suffix for the marker recording that this adapter has already told the
 * user, once, that it found a pre-existing "statusLine" and left it alone —
 * see ensureStatusLineConfigured. Colocated with settings.json itself, the
 * same "beside the file it's about" choice BACKUP_FILE_SUFFIX makes, rather
 * than a row in Chameleon's own global state directory: the fact this marker
 * carries ("have I already said this about *this* settings.json") is scoped
 * to one settings.json, not to the machine.
 */
const STATUS_LINE_NOTICE_FILE_SUFFIX = ".chameleon-statusline-notice";

/** The two keys this adapter ever touches — see CHM-51's "edit only the theme key and leave every other byte alone", extended by CHM-68 to the one other key this adapter is ever allowed to set outright: statusLine, and only when it was never there at all. */
const THEME_KEY = "theme";
const STATUS_LINE_KEY = "statusLine";

/** The `chm statusline` invocation this adapter points a bare "statusLine" at — see CHM-68. Runs in a shell on every platform Claude Code ships for, and resolves on PATH the same way any other globally installed `chm` command already does, so there is no path to get wrong. */
const STATUSLINE_COMMAND = "chm statusline";
const STATUSLINE_CONFIG_VALUE = { type: "command", command: STATUSLINE_COMMAND } as const;

/** `chm <theme>`'s own one-time notice when settings.json already named a statusLine before Chameleon ever looked — CHM-68's own "said once, not on every apply." */
const STATUS_LINE_ALREADY_SET_NOTICE =
  "statusLine is already set in settings.json — left it as-is; delete that key yourself if you'd rather Chameleon set its own";

/**
 * Claude Code's own six shipped themes, confirmed by inspecting the binary —
 * see CHM-49's ticket body. The "-ansi" pair render straight from the
 * terminal's own 16 ANSI slots — precisely the slots Chameleon already
 * writes and repairs for contrast (CHM-32) — so setting one of these once
 * makes Claude Code render in whatever pack is active, exactly, with nothing
 * for this adapter to approximate the way Herdr's built-in fallback has to
 * (CHM-41). The "-daltonized" pair exist for colour-blind legibility and must
 * never be silently moved onto an ansi variant, whose colours were never
 * chosen with that in mind — see themeToWriteFor.
 */
const CLAUDE_CODE_ANSI_THEME_FOR: Readonly<Record<Appearance, string>> = {
  dark: "dark-ansi",
  light: "light-ansi",
};

const CLAUDE_CODE_DALTONIZED_THEME_FOR: Readonly<Record<Appearance, string>> = {
  dark: "dark-daltonized",
  light: "light-daltonized",
};

const CLAUDE_CODE_DALTONIZED_THEMES: ReadonlySet<string> = new Set(Object.values(CLAUDE_CODE_DALTONIZED_THEME_FOR));

/**
 * The theme value to write for `appearance`, given whatever theme the config
 * already carries. A user already on a daltonized theme keeps the daltonized
 * pair — only the light/dark half moves — since an ansi variant's colours are
 * not chosen for colour-blind legibility and switching them out from under
 * that choice would be exactly the silent discard CHM-49 warns against.
 * Anyone else — no theme set yet, or one of the plain/ansi four — gets the
 * ansi variant, which is what renders the active pack's own colours exactly.
 */
function themeToWriteFor(existingTheme: string | undefined, appearance: Appearance): string {
  if (existingTheme !== undefined && CLAUDE_CODE_DALTONIZED_THEMES.has(existingTheme)) {
    return CLAUDE_CODE_DALTONIZED_THEME_FOR[appearance];
  }
  return CLAUDE_CODE_ANSI_THEME_FOR[appearance];
}

/**
 * The slice of settings.json this adapter actually depends on. Everything
 * else in a real settings.json — permissions, hooks, statusLine,
 * enabledPlugins — is unvalidated and passed through untouched; this schema
 * exists only to catch a shape this adapter cannot safely edit, never to
 * police the rest of a user's config.
 */
const ClaudeCodeSettingsSchema = z
  .object({
    theme: z.string().optional(),
    // Never validated beyond "is it there at all" — this adapter only ever
    // needs to know whether the key is present, never its shape, since it
    // never edits an existing one (see ensureStatusLineConfigured).
    statusLine: z.unknown().optional(),
  })
  .catchall(z.unknown());

export type ClaudeCodeSettings = z.infer<typeof ClaudeCodeSettingsSchema>;

/**
 * Whether `settings`'s own theme already matches what applying `appearance`
 * would write — the same daltonized-aware mapping themeToWriteFor itself
 * uses, so a user who switched themes by hand (daltonized included) after
 * Chameleon last applied is exactly the drift CHM-27 exists to surface. This
 * is also how Chameleon tells "its own last write" from anything else: there
 * is no marker left in settings.json to look for (see CHM-51), so ownership
 * is a value comparison against whatever pack the active-pack state file
 * recorded, the same as every other target's own `*MatchesX` function.
 */
export function claudeCodeMatchesAppearance(settings: ClaudeCodeSettings, appearance: Appearance): boolean {
  return settings.theme === themeToWriteFor(settings.theme, appearance);
}

export interface ClaudeCodeAdapter {
  detect(): boolean;
  read(): ClaudeCodeSettings;
  /** The one-time "statusLine already set" notice (see ensureStatusLineConfigured) — undefined every other time, theme's own upsert included. */
  apply(appearance: Appearance): string | undefined;
  /** Always a notice naming the restart Claude Code needs — see reloadClaudeCode. */
  reload(): string | undefined;
}

function defaultSettingsPath(): string {
  return claudeCodeSettingsPath();
}

function backupPathFor(settingsPath: string): string {
  return `${settingsPath}${BACKUP_FILE_SUFFIX}`;
}

function statusLineNoticePathFor(settingsPath: string): string {
  return `${settingsPath}${STATUS_LINE_NOTICE_FILE_SUFFIX}`;
}

function detectClaudeCode(settingsPath: string): boolean {
  return existsSync(settingsPath);
}

/**
 * Parses settings.json — tolerating the comments and trailing commas a
 * hand-edited JSONC file carries — and validates just enough of its shape
 * for this adapter to trust. A config the user broke must say so by name,
 * never crash and never be silently overwritten.
 */
function readClaudeCodeSettings(settingsPath: string): ClaudeCodeSettings {
  const rawText = readFileSync(settingsPath, "utf8");
  const parsed: unknown = parseJsonc(rawText, [], { allowTrailingComma: true });
  const validated = ClaudeCodeSettingsSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`${settingsPath} is not a Claude Code settings file Chameleon understands: ${validated.error.message}`);
  }
  return validated.data;
}

/**
 * Whether `noticePath`'s marker already exists — i.e. this settings.json has
 * already been told, on some earlier apply, that its own pre-existing
 * statusLine was left alone. See ensureStatusLineConfigured.
 */
function hasShownStatusLineNotice(noticePath: string): boolean {
  return existsSync(noticePath);
}

/** Leaves an empty marker at `noticePath` — its presence is the whole fact, the same "mere presence" contract preview-state.ts's own marker carries. */
function markStatusLineNoticeShown(noticePath: string): void {
  writeFileSync(noticePath, "", "utf8");
}

/**
 * Sets `text`'s own "statusLine" to Chameleon's `chm statusline` (CHM-68),
 * but only when `existingSettings` carries no statusLine at all — the same
 * "never overwrite a script someone wrote" CLAUDE.md holds for every config
 * this project edits, extended here from colours to a command someone wrote
 * themselves. Returns the updated text alongside a notice, shown at most
 * once per settings.json (see hasShownStatusLineNotice), when a pre-existing
 * statusLine was found and left untouched — `chm <theme>` surfaces that
 * notice on whichever apply first notices it, and never repeats it after.
 * Nothing is ever said when this adapter set statusLine itself for the first
 * time: that already "just works", the same silence theme's own upsert gets.
 */
function ensureStatusLineConfigured(
  settingsPath: string,
  text: string,
  existingSettings: ClaudeCodeSettings,
  noticePath: string,
): { text: string; notice: string | undefined } {
  if (existingSettings.statusLine === undefined) {
    return { text: setUnmarkedTopLevelProperty(settingsPath, text, STATUS_LINE_KEY, STATUSLINE_CONFIG_VALUE), notice: undefined };
  }
  if (hasShownStatusLineNotice(noticePath)) {
    return { text, notice: undefined };
  }
  markStatusLineNoticeShown(noticePath);
  return { text, notice: STATUS_LINE_ALREADY_SET_NOTICE };
}

/**
 * Backs up settings.json, then sets "theme" to whichever of Claude Code's own
 * six values `appearance` maps to (see themeToWriteFor) and, when it is
 * entirely absent, "statusLine" to Chameleon's own `chm statusline`
 * (ensureStatusLineConfigured, CHM-68) — never touching permissions, hooks,
 * enabledPlugins or anything else in the file, and never wrapping either
 * edit in Chameleon's usual ch:begin/ch:end comment markers. Claude Code
 * parses settings.json as strict JSON: a marker comment anywhere in the file
 * made it discard the whole document rather than skip the one comment it did
 * not recognise — permissions, hooks, statusLine and enabledPlugins all
 * stopped being honoured along with it, silently, unless a user happened to
 * run `claude doctor` (CHM-51). See setUnmarkedTopLevelProperty, which does
 * the surgical in-place value swap both edits need instead, applied twice in
 * sequence so only one backup and one write cover both.
 */
function applyClaudeCodeTheme(settingsPath: string, appearance: Appearance): string | undefined {
  if (!existsSync(settingsPath)) {
    throw new Error(`no Claude Code settings.json found at ${settingsPath}`);
  }

  copyFileSync(settingsPath, backupPathFor(settingsPath));

  const originalText = readFileSync(settingsPath, "utf8");
  const existingSettings = readClaudeCodeSettings(settingsPath);
  const themeToWrite = themeToWriteFor(existingSettings.theme, appearance);

  const textWithTheme = setUnmarkedTopLevelProperty(settingsPath, originalText, THEME_KEY, themeToWrite);
  const { text: finalText, notice } = ensureStatusLineConfigured(settingsPath, textWithTheme, existingSettings, statusLineNoticePathFor(settingsPath));

  writeFileSync(settingsPath, finalText, "utf8");
  return notice;
}

/**
 * Claude Code reads settings.json once at startup; it has no file watcher of
 * its own — nothing here has an equivalent of Windows Terminal's own live
 * reload or Herdr's reload-config socket call to trigger. A change written
 * while a session is already running only reaches it on its next restart, so
 * this says that plainly every time rather than reporting a success the
 * running session cannot show — see CHM-45, where an unwired reload cost this
 * project four sessions of chasing the wrong thing.
 */
function reloadClaudeCode(): string {
  return "restart Claude Code to see it";
}

/**
 * Builds the Claude Code adapter. `settingsPath` defaults to the real
 * ~/.claude/settings.json and is only ever overridden by tests, which point
 * it at a fixture copy so nothing here touches a real config.
 */
export function createClaudeCodeAdapter(settingsPath: string = defaultSettingsPath()): ClaudeCodeAdapter {
  return {
    detect: () => detectClaudeCode(settingsPath),
    read: () => readClaudeCodeSettings(settingsPath),
    apply: (appearance) => applyClaudeCodeTheme(settingsPath, appearance),
    reload: () => reloadClaudeCode(),
  };
}

/**
 * Restores settings.json from the backup written by the most recent `apply`.
 * Not part of the adapter interface — undo is a user command, not a step in
 * the theming pipeline — but it lives beside the adapter because the backup
 * file's location and format are this file's business.
 */
export function undoClaudeCode(settingsPath: string = defaultSettingsPath()): void {
  const backupPath = backupPathFor(settingsPath);
  if (!existsSync(backupPath)) {
    throw new Error(`no backup found at ${backupPath} — nothing to undo`);
  }
  copyFileSync(backupPath, settingsPath);
}
