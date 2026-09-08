import { z } from "zod";
declare const PreviewStateSchema: z.ZodObject<{
    originalSlug: z.ZodOptional<z.ZodString>;
    updatedAtMs: z.ZodNumber;
}, z.core.$strip>;
export type PreviewState = z.infer<typeof PreviewStateSchema>;
/** Where `ch` records that a theme preview is in flight — see platform.ts's stateDir. */
export declare function defaultPreviewStatePath(): string;
/**
 * The recorded preview state, or undefined when no preview is in flight, or
 * the marker cannot be read — either way, "nothing recorded" rather than a
 * thrown error, the same contract as state.ts's readActivePackState.
 */
export declare function readPreviewState(previewStatePath?: string): PreviewState | undefined;
/** Records that a preview has started, naming the pack (if any) to fall back to if it never gets a clean exit. */
export declare function writePreviewState(originalSlug: string | undefined, previewStatePath?: string): void;
/** Removes the marker, if one exists — a no-op otherwise, so every caller can call this unconditionally on every real, authoritative apply or undo. */
export declare function clearPreviewState(previewStatePath?: string): void;
export {};
