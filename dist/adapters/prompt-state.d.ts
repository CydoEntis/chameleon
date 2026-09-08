import { z } from "zod";
declare const PromptStateSchema: z.ZodObject<{
    originalConfigPath: z.ZodString;
    activeSlug: z.ZodOptional<z.ZodString>;
    updatedAtMs: z.ZodNumber;
}, z.core.$strip>;
export type PromptState = z.infer<typeof PromptStateSchema>;
/** Where `ch` records the prompt-layout switch state — see platform.ts's stateDir. */
export declare function defaultPromptStatePath(): string;
/**
 * The recorded prompt-switch state, or undefined when no bundled layout has
 * ever been applied, or the state file cannot be read — either way, "nothing
 * recorded" rather than a thrown error, the same contract as
 * state.ts's readActivePackState.
 */
export declare function readPromptState(statePath?: string): PromptState | undefined;
/** Records `state` verbatim, timestamped by its own `updatedAtMs` — the caller decides whether `originalConfigPath` is a fresh recording or one carried forward from an earlier switch. */
export declare function writePromptState(state: PromptState, statePath?: string): void;
export {};
