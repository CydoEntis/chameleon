import { z } from "zod";
import type { Appearance } from "../palette/palette.js";
/**
 * The slice of settings.json this adapter actually depends on. Everything
 * else in a real settings.json — permissions, hooks, statusLine,
 * enabledPlugins — is unvalidated and passed through untouched; this schema
 * exists only to catch a shape this adapter cannot safely edit, never to
 * police the rest of a user's config.
 */
declare const ClaudeCodeSettingsSchema: z.ZodObject<{
    theme: z.ZodOptional<z.ZodString>;
    statusLine: z.ZodOptional<z.ZodUnknown>;
}, z.core.$catchall<z.ZodUnknown>>;
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
export declare function claudeCodeMatchesAppearance(settings: ClaudeCodeSettings, appearance: Appearance): boolean;
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
/**
 * Builds the Claude Code adapter. `settingsPath` defaults to the real
 * ~/.claude/settings.json and `statuslineStatePath` to Chameleon's own real
 * statusline lifecycle record (state.ts) — both are only ever overridden by
 * tests, which point them at fixture/scratch copies so nothing here touches a
 * real config or a real machine's recorded choice.
 */
export declare function createClaudeCodeAdapter(settingsPath?: string, statuslineStatePath?: string): ClaudeCodeAdapter;
/**
 * Whether Chameleon currently manages Claude Code's statusLine — true when
 * nothing has ever decided otherwise (CHM-86's own "on by default"), so a
 * fresh machine that has never applied a theme, and never run `chm statusline
 * on`/`off`, still reports the default the next apply will act on.
 */
export declare function isClaudeCodeStatusLineEnabled(statuslineStatePath?: string): boolean;
/**
 * Plain-English name for whatever settings.json's own "statusLine" currently
 * holds — `chm doctor`'s own "names which statusline is in use" (CHM-86).
 * Chameleon's own command string is the only shape this names outright;
 * anything else is described by its own command, or as "a custom statusLine"
 * for a shape that is not even a command Claude Code would run.
 */
export declare function describeStatusLine(statusLine: unknown): string;
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
export declare function enableClaudeCodeStatusLine(settingsPath?: string, statuslineStatePath?: string): string | undefined;
/**
 * `chm statusline off` (CHM-86): records Chameleon's own choice to stop
 * managing the statusLine, so every apply after this — a theme switch
 * included — leaves the key exactly as it finds it (see
 * ensureStatusLineConfigured). Never touches settings.json itself: turning it
 * off is a promise about future applies, not a request to change what is
 * configured right now.
 */
export declare function disableClaudeCodeStatusLine(statuslineStatePath?: string): void;
/**
 * Restores settings.json from the backup written by the most recent `apply`.
 * Not part of the adapter interface — undo is a user command, not a step in
 * the theming pipeline — but it lives beside the adapter because the backup
 * file's location and format are this file's business.
 */
export declare function undoClaudeCode(settingsPath?: string): void;
export {};
