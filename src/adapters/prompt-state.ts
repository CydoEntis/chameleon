import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { stateDir } from "./platform.js";

/** File name of the pointer `ch prompt <name>`/`ch prompt mine` both read and write. */
const PROMPT_STATE_FILE_NAME = "prompt-state.json";

const PromptStateSchema = z.object({
  /**
   * The user's own Oh My Posh config path, recorded once — at the very
   * first bundled-layout switch, never again — so `ch prompt mine` can find
   * its way back after several switches, not only the first. See CHM-47:
   * "Record the user's original config path before the first switch, so
   * 'mine' is always recoverable even after several changes."
   */
  originalConfigPath: z.string().min(1),
  /** The bundled layout's own slug, or undefined when `ch prompt mine` most recently put the user's own config back. */
  activeSlug: z.string().min(1).optional(),
  updatedAtMs: z.number(),
});

export type PromptState = z.infer<typeof PromptStateSchema>;

/** Where `ch` records the prompt-layout switch state — see platform.ts's stateDir. */
export function defaultPromptStatePath(): string {
  return path.join(stateDir(), PROMPT_STATE_FILE_NAME);
}

/**
 * The recorded prompt-switch state, or undefined when no bundled layout has
 * ever been applied, or the state file cannot be read — either way, "nothing
 * recorded" rather than a thrown error, the same contract as
 * state.ts's readActivePackState.
 */
export function readPromptState(statePath: string = defaultPromptStatePath()): PromptState | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    const validated = PromptStateSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

/** Records `state` verbatim, timestamped by its own `updatedAtMs` — the caller decides whether `originalConfigPath` is a fresh recording or one carried forward from an earlier switch. */
export function writePromptState(state: PromptState, statePath: string = defaultPromptStatePath()): void {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}
