import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { stateDir } from "./platform.js";

/**
 * File name of the marker the picker writes the moment it opens and clears
 * the moment a real command (`applyThemePack`/`undoAppliedPack`) settles what
 * every target should show — see CHM-55. Its mere presence is the fact that
 * matters: a preview is either still running in some pane, or the process
 * that opened it never got the chance to clean up after itself (Ctrl-C
 * bypassing the picker's own handler is covered already; a closed terminal or
 * a crash is not).
 */
const PREVIEW_STATE_FILE_NAME = "preview-in-flight.json";

const PreviewStateSchema = z.object({
  /** The pack that was active before the picker opened, or undefined when nothing had ever been applied — what resyncInterruptedPreview falls back to. */
  originalSlug: z.string().min(1).optional(),
  updatedAtMs: z.number(),
});

export type PreviewState = z.infer<typeof PreviewStateSchema>;

/** Where `ch` records that a theme preview is in flight — see platform.ts's stateDir. */
export function defaultPreviewStatePath(): string {
  return path.join(stateDir(), PREVIEW_STATE_FILE_NAME);
}

/**
 * The recorded preview state, or undefined when no preview is in flight, or
 * the marker cannot be read — either way, "nothing recorded" rather than a
 * thrown error, the same contract as state.ts's readActivePackState.
 */
export function readPreviewState(previewStatePath: string = defaultPreviewStatePath()): PreviewState | undefined {
  if (!existsSync(previewStatePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(previewStatePath, "utf8"));
    const validated = PreviewStateSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

/** Records that a preview has started, naming the pack (if any) to fall back to if it never gets a clean exit. */
export function writePreviewState(originalSlug: string | undefined, previewStatePath: string = defaultPreviewStatePath()): void {
  mkdirSync(path.dirname(previewStatePath), { recursive: true });
  const state: PreviewState = originalSlug === undefined ? { updatedAtMs: Date.now() } : { originalSlug, updatedAtMs: Date.now() };
  writeFileSync(previewStatePath, JSON.stringify(state, null, 2), "utf8");
}

/** Removes the marker, if one exists — a no-op otherwise, so every caller can call this unconditionally on every real, authoritative apply or undo. */
export function clearPreviewState(previewStatePath: string = defaultPreviewStatePath()): void {
  if (!existsSync(previewStatePath)) return;
  rmSync(previewStatePath, { force: true });
}
