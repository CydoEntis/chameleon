import { z } from "zod";
import type { Scheme } from "../palette/scheme.js";
/** winget's package identifier for Windows Terminal (stable), used to build the one-line install command `ch doctor` offers. */
export declare const WINDOWS_TERMINAL_WINGET_PACKAGE_ID = "Microsoft.WindowsTerminal";
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
declare const WindowsTerminalSettingsSchema: z.ZodObject<{
    schemes: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    profiles: z.ZodOptional<z.ZodObject<{
        defaults: z.ZodOptional<z.ZodObject<{
            font: z.ZodOptional<z.ZodObject<{
                face: z.ZodOptional<z.ZodString>;
            }, z.core.$catchall<z.ZodUnknown>>>;
            fontFace: z.ZodOptional<z.ZodString>;
        }, z.core.$catchall<z.ZodUnknown>>>;
    }, z.core.$catchall<z.ZodUnknown>>>;
    theme: z.ZodOptional<z.ZodUnknown>;
}, z.core.$catchall<z.ZodUnknown>>;
export type WindowsTerminalSettings = z.infer<typeof WindowsTerminalSettingsSchema>;
/**
 * The Nerd Font face Windows Terminal will actually render with, honouring
 * whichever shape `settings` carries. When both the nested `font.face` and
 * the legacy flat `fontFace` are present, the nested value wins — that is
 * what Windows Terminal itself honours. See CHM-15.
 */
export declare function selectedFontFace(settings: WindowsTerminalSettings): string | undefined;
/**
 * Whether `settings`'s own colour scheme selection already matches `scheme`
 * — the same value applyWindowsTerminalScheme itself writes via
 * upsertDefaultColorScheme (windowsTerminalSchemeName(scheme.name), not
 * scheme.name itself — see CHAMELEON_SCHEME_NAME_PREFIX), so a mismatch
 * means this target has drifted from whatever pack `ch` last recorded as
 * active. See CHM-27.
 */
export declare function windowsTerminalMatchesScheme(settings: WindowsTerminalSettings, scheme: Scheme): boolean;
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
export declare function defaultWindowsTerminalSettingsPath(): string | undefined;
/**
 * Builds the Windows Terminal adapter. `settingsPath` defaults to the real
 * stable-channel location — undefined on every platform but Windows, where
 * Windows Terminal cannot exist — and is only ever overridden by tests,
 * which point it at a fixture copy so nothing here touches a real
 * settings.json.
 */
export declare function createWindowsTerminalAdapter(settingsPath?: string | undefined): WindowsTerminalAdapter;
/**
 * Backs up settings.json, then points profiles.defaults at `fontFace` —
 * updating whichever shape the file already uses. Not part of the adapter
 * interface — selecting a font is `ch doctor`'s job, offered when a Nerd
 * Font is installed but not selected, never a step in the theming pipeline
 * — but it lives beside the adapter because settings.json's shape is this
 * file's business.
 */
export declare function selectWindowsTerminalFont(fontFace: string, settingsPath?: string | undefined): void;
/**
 * Restores settings.json from the backup written by the most recent
 * `apply`. Not part of the adapter interface — undo is a user command, not
 * a step in the theming pipeline — but it lives beside the adapter because
 * the backup file's location and format are this file's business.
 */
export declare function undoWindowsTerminal(settingsPath?: string | undefined): void;
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
export declare function removeDeadWindowsTerminalSchemeForks(settingsPath?: string | undefined): number;
export {};
