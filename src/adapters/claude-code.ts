import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import type { Appearance } from "../palette/palette.js";
import { setUnmarkedTopLevelProperty } from "./marked-json-edit.js";
import { claudeCodeSettingsPath } from "./platform.js";
import { defaultStatuslineStatePath, readStatuslineState, writeStatuslineState } from "./state.js";

/** Suffix for the pre-apply copy of settings.json that `undoClaudeCode` restores from. */
const BACKUP_FILE_SUFFIX = ".chameleon-backup";

/**
 * The two keys this adapter ever touches — see CHM-51's "edit only the theme
 * key and leave every other byte alone", extended by CHM-68 to statusLine.
 * "theme" is unconditional on every apply, the same as it always has been.
 * "statusLine" is not, any more: CHM-71's "Chameleon owns statusLine
 * outright" is itself superseded by CHM-86 — a lifecycle a user can turn off
 * and back on (state.ts's statusline state) now decides whether an apply
 * touches this key at all, see ensureStatusLineConfigured. `chm original`
 * remains the one command that gives either key's pre-Chameleon value back,
 * whatever the lifecycle currently says.
 */
const THEME_KEY = "theme";
const STATUS_LINE_KEY = "statusLine";

/** The `chm statusline` invocation this adapter points a bare "statusLine" at — see CHM-68. Runs in a shell on every platform Claude Code ships for, and resolves on PATH the same way any other globally installed `chm` command already does, so there is no path to get wrong. */
const STATUSLINE_COMMAND = "chm statusline";
const STATUSLINE_CONFIG_VALUE = { type: "command", command: STATUSLINE_COMMAND } as const;

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
    // needs to know whether the key is present, to decide a machine's first
    // apply (see ensureStatusLineConfigured), never its shape.
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
  /**
   * A notice worth telling the user, or undefined when apply's own
   * "applied" headline already says everything there is to say — see
   * ensureStatusLineConfigured. The one case this carries something: a
   * machine's very first apply, when it finds a statusLine already there
   * and leaves it alone rather than install over it (CHM-86).
   */
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
 * The plain-language notice `ensureStatusLineConfigured` returns the one time
 * a machine's first apply finds a statusLine already there — CHM-86's own
 * acceptance criterion, "says plainly that Chameleon's was not installed over
 * it." Named once here so the apply-time notice and `chm doctor`'s own report
 * (see describeStatusLine) can never drift apart in wording.
 */
const KEPT_EXISTING_STATUS_LINE_NOTICE =
  "kept your existing statusLine instead of installing Chameleon's own — run `chm statusline on` to switch to it";

/**
 * Sets `text`'s own "statusLine" to Chameleon's `chm statusline`, or leaves it
 * exactly as `text` already has it — decided by Chameleon's own recorded
 * lifecycle choice (state.ts's statusline state), never unconditionally the
 * way CHM-71 left it. CHM-86 supersedes that: a user who ran `chm statusline
 * off` must have every apply after it, a theme switch included, leave the key
 * alone.
 *
 * `readStatuslineState` coming back undefined means no choice has ever been
 * recorded — true only on a machine's very first apply — and this is where
 * that choice gets made and persisted for every apply after it: installing
 * over nothing when `existingStatusLine` is absent (CHM-86's own "without
 * being asked"), or leaving an existing one alone and saying so plainly
 * (KEPT_EXISTING_STATUS_LINE_NOTICE) when it is not. Once a choice exists,
 * this never revisits it on its own — only `chm statusline on`/`off`
 * (enableClaudeCodeStatusLine/disableClaudeCodeStatusLine) change it again.
 */
function ensureStatusLineConfigured(
  settingsPath: string,
  text: string,
  existingStatusLine: unknown,
  statuslineStatePath: string,
): { text: string; notice: string | undefined } {
  const recordedState = readStatuslineState(statuslineStatePath);

  if (recordedState === undefined) {
    const isFirstApplyWithNoExistingStatusLine = existingStatusLine === undefined;
    writeStatuslineState(isFirstApplyWithNoExistingStatusLine, statuslineStatePath);
    if (!isFirstApplyWithNoExistingStatusLine) {
      return { text, notice: KEPT_EXISTING_STATUS_LINE_NOTICE };
    }
  } else if (!recordedState.isEnabled) {
    return { text, notice: undefined };
  }

  return { text: setUnmarkedTopLevelProperty(settingsPath, text, STATUS_LINE_KEY, STATUSLINE_CONFIG_VALUE), notice: undefined };
}

/**
 * Backs up settings.json, then sets "theme" to whichever of Claude Code's own
 * six values `appearance` maps to (see themeToWriteFor) and, when Chameleon's
 * own lifecycle choice says to, "statusLine" to Chameleon's own `chm
 * statusline` (ensureStatusLineConfigured) — never touching permissions,
 * hooks, enabledPlugins or anything else in the file, and never wrapping
 * either edit in Chameleon's usual ch:begin/ch:end comment markers. Claude
 * Code parses settings.json as strict JSON: a marker comment
 * anywhere in the file made it discard the whole document rather than skip
 * the one comment it did not recognise — permissions, hooks, statusLine and
 * enabledPlugins all stopped being honoured along with it, silently, unless a
 * user happened to run `claude doctor` (CHM-51). See setUnmarkedTopLevelProperty,
 * which does the surgical in-place value swap both edits need instead,
 * applied twice in sequence so only one backup and one write cover both.
 */
function applyClaudeCodeTheme(settingsPath: string, appearance: Appearance, statuslineStatePath: string): string | undefined {
  if (!existsSync(settingsPath)) {
    throw new Error(`no Claude Code settings.json found at ${settingsPath}`);
  }

  copyFileSync(settingsPath, backupPathFor(settingsPath));

  const originalText = readFileSync(settingsPath, "utf8");
  const existingSettings = readClaudeCodeSettings(settingsPath);
  const themeToWrite = themeToWriteFor(existingSettings.theme, appearance);

  const textWithTheme = setUnmarkedTopLevelProperty(settingsPath, originalText, THEME_KEY, themeToWrite);
  const { text: finalText, notice } = ensureStatusLineConfigured(settingsPath, textWithTheme, existingSettings.statusLine, statuslineStatePath);

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
 * ~/.claude/settings.json and `statuslineStatePath` to Chameleon's own real
 * statusline lifecycle record (state.ts) — both are only ever overridden by
 * tests, which point them at fixture/scratch copies so nothing here touches a
 * real config or a real machine's recorded choice.
 */
export function createClaudeCodeAdapter(
  settingsPath: string = defaultSettingsPath(),
  statuslineStatePath: string = defaultStatuslineStatePath(),
): ClaudeCodeAdapter {
  return {
    detect: () => detectClaudeCode(settingsPath),
    read: () => readClaudeCodeSettings(settingsPath),
    apply: (appearance) => applyClaudeCodeTheme(settingsPath, appearance, statuslineStatePath),
    reload: () => reloadClaudeCode(),
  };
}

/**
 * Whether Chameleon currently manages Claude Code's statusLine — true when
 * nothing has ever decided otherwise (CHM-86's own "on by default"), so a
 * fresh machine that has never applied a theme, and never run `chm statusline
 * on`/`off`, still reports the default the next apply will act on.
 */
export function isClaudeCodeStatusLineEnabled(statuslineStatePath: string = defaultStatuslineStatePath()): boolean {
  return readStatuslineState(statuslineStatePath)?.isEnabled ?? true;
}

/**
 * The one shape describeStatusLine actually needs to read out of an
 * otherwise-`unknown` statusLine value — never validated any further than
 * this, since anything shaped like a command is nameable by its own command
 * string regardless of what else it carries.
 */
const StatusLineCommandShapeSchema = z.object({ command: z.unknown() }).catchall(z.unknown());

/**
 * Plain-English name for whatever settings.json's own "statusLine" currently
 * holds — `chm doctor`'s own "names which statusline is in use" (CHM-86).
 * Chameleon's own command string is the only shape this names outright;
 * anything else is described by its own command, or as "a custom statusLine"
 * for a shape that is not even a command Claude Code would run.
 */
export function describeStatusLine(statusLine: unknown): string {
  if (statusLine === undefined) return "none configured";

  const parsed = StatusLineCommandShapeSchema.safeParse(statusLine);
  if (!parsed.success) return "a custom statusLine";

  const { command } = parsed.data;
  return command === STATUSLINE_COMMAND ? `Chameleon's own (${STATUSLINE_COMMAND})` : `a custom command (${String(command)})`;
}

/**
 * `chm statusline on` (CHM-86): records Chameleon's own choice to manage the
 * statusLine, and — because this is an explicit request, unlike the more
 * cautious first-apply decision ensureStatusLineConfigured makes for itself —
 * writes it immediately, replacing whatever is configured right now. Backs up
 * settings.json first, the same as every other write this adapter makes, so
 * `chm undo` can still give it back. Returns a notice naming the one case
 * there is nothing to write yet: Claude Code has no settings.json at all,
 * so the choice is recorded for whenever it does.
 */
export function enableClaudeCodeStatusLine(
  settingsPath: string = defaultSettingsPath(),
  statuslineStatePath: string = defaultStatuslineStatePath(),
): string | undefined {
  writeStatuslineState(true, statuslineStatePath);
  if (!existsSync(settingsPath)) {
    return "no Claude Code settings.json found yet — the choice is recorded for when there is";
  }

  copyFileSync(settingsPath, backupPathFor(settingsPath));
  const originalText = readFileSync(settingsPath, "utf8");
  const updatedText = setUnmarkedTopLevelProperty(settingsPath, originalText, STATUS_LINE_KEY, STATUSLINE_CONFIG_VALUE);
  writeFileSync(settingsPath, updatedText, "utf8");
  return undefined;
}

/**
 * `chm statusline off` (CHM-86): records Chameleon's own choice to stop
 * managing the statusLine, so every apply after this — a theme switch
 * included — leaves the key exactly as it finds it (see
 * ensureStatusLineConfigured). Never touches settings.json itself: turning it
 * off is a promise about future applies, not a request to change what is
 * configured right now.
 */
export function disableClaudeCodeStatusLine(statuslineStatePath: string = defaultStatuslineStatePath()): void {
  writeStatuslineState(false, statuslineStatePath);
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
