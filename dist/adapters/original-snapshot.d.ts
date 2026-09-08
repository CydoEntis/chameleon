import { z } from "zod";
import { type Shell } from "./platform.js";
declare const OriginalSnapshotSchema: z.ZodObject<{
    capturedAtMs: z.ZodNumber;
    windowsTerminal: z.ZodOptional<z.ZodObject<{
        settingsPath: z.ZodString;
        settingsText: z.ZodString;
    }, z.core.$strip>>;
    ohMyPosh: z.ZodOptional<z.ZodObject<{
        profilePath: z.ZodString;
        profileText: z.ZodString;
        didProfileExist: z.ZodBoolean;
        discoveredConfig: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            text: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    herdr: z.ZodOptional<z.ZodObject<{
        configPath: z.ZodString;
        configText: z.ZodString;
    }, z.core.$strip>>;
    claudeCode: z.ZodOptional<z.ZodObject<{
        settingsPath: z.ZodString;
        settingsText: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type OriginalSnapshot = z.infer<typeof OriginalSnapshotSchema>;
export declare function defaultOriginalSnapshotPath(): string;
/**
 * The snapshot already on disk, or undefined only when `snapshotPath` does
 * not exist at all — never for a file that exists but cannot be understood.
 * That distinction matters more here than for state.ts's own active-pack
 * pointer: this file is the one safety net CLAUDE.md's "eat one user's
 * config and the tool is dead" rests on, so a snapshot that exists but is
 * unreadable must say so loudly and stop, never be treated as "nothing was
 * ever captured" — reading that as "missing" would let a later apply
 * recapture over it, permanently losing whatever the real original was.
 */
export declare function readOriginalSnapshot(snapshotPath?: string): OriginalSnapshot | undefined;
/**
 * The real path/shell resolution `captureOriginalSnapshotIfMissing` uses for
 * each target, exactly like every adapter's own `createXAdapter(path = real
 * default)` — bundled into one object here, rather than one default
 * parameter per target, because a test overriding one of these almost always
 * needs to override several at once, and a real caller (`chm`'s own apply
 * pipeline) never overrides any of them.
 */
export interface OriginalSnapshotCapturePaths {
    readonly windowsTerminalSettingsPath?: string | undefined;
    readonly ohMyPoshDetected?: boolean;
    readonly ohMyPoshShell?: Shell;
    readonly ohMyPoshProfilePath?: string;
    readonly herdrConfigPath?: string | undefined;
    readonly claudeCodeSettingsPath?: string;
}
/**
 * Captures every surface Chameleon is about to theme, exactly as it stands
 * right now, unless a snapshot has already been captured — checked by plain
 * existence of `snapshotPath`, never by whether it parses. That is the one
 * guard CLAUDE.md's "never overwritten by a later apply" rests on: a
 * snapshot that exists but is somehow corrupt must still block a recapture,
 * because recapturing now would record Chameleon's *own* already-applied
 * colours as "the original" and destroy the one thing this file exists to
 * protect. A target that is not installed, or has nothing configured yet, is
 * simply left out of the snapshot (its section stays undefined) rather than
 * failing the capture for the targets that *are* there. A machine with
 * nothing configured at all produces a snapshot with every section
 * undefined — still written once, so a target installed later never
 * retroactively gets "captured" from a state Chameleon itself already
 * changed.
 *
 * Must run before any target is written to — see index.ts's applyThemePack,
 * the only real caller — so every one of the four captures above always
 * reads a file Chameleon has not touched yet. `capturePaths` is only ever
 * overridden by tests, which point every target at a fixture copy so nothing
 * here touches a real config; `chm` itself always reads the real ones.
 */
export declare function captureOriginalSnapshotIfMissing(snapshotPath?: string, capturePaths?: OriginalSnapshotCapturePaths): void;
/** Writes Windows Terminal's settings.json back exactly as snapshotted. Returns whether there was anything recorded to restore. */
export declare function restoreWindowsTerminalFromSnapshot(snapshot: OriginalSnapshot): boolean;
/**
 * Restores the shell profile to exactly what it was before Chameleon ever
 * wrote an init line into it — deleting it outright when it did not exist at
 * all beforehand, rather than leaving a file behind holding an empty string
 * — and, when one was discoverable, the config `oh-my-posh init` named at the
 * time, so the profile's own (restored) init line and the config it points
 * at agree again. Returns whether there was anything recorded to restore.
 */
export declare function restoreOhMyPoshFromSnapshot(snapshot: OriginalSnapshot): boolean;
/** Writes Herdr's config.toml back exactly as snapshotted. Returns whether there was anything recorded to restore. */
export declare function restoreHerdrFromSnapshot(snapshot: OriginalSnapshot): boolean;
/** Writes Claude Code's settings.json back exactly as snapshotted — theme and statusLine both, since both are captured as part of the same raw file. Returns whether there was anything recorded to restore. */
export declare function restoreClaudeCodeFromSnapshot(snapshot: OriginalSnapshot): boolean;
export {};
