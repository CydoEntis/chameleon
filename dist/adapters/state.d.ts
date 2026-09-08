import { z } from "zod";
declare const ActivePackStateSchema: z.ZodObject<{
    slug: z.ZodString;
    updatedAtMs: z.ZodNumber;
}, z.core.$strip>;
export type ActivePackState = z.infer<typeof ActivePackStateSchema>;
/** Where `ch` records which pack it last applied — see platform.ts's stateDir. */
export declare function defaultActivePackStatePath(): string;
/**
 * The pack `ch` last successfully applied, or undefined when nothing has
 * been applied yet, or the state file cannot be read — either way, "nothing
 * recorded" rather than a thrown error, since a missing or corrupted pointer
 * must never stop `ch current`, `ch next` or `ch dark`/`ch light` from doing
 * something sensible.
 */
export declare function readActivePackState(statePath?: string): ActivePackState | undefined;
/** Records `slug` as the pack `ch` most recently applied, timestamped now. */
export declare function writeActivePackState(slug: string, statePath?: string): void;
declare const StatuslineStateSchema: z.ZodObject<{
    isEnabled: z.ZodBoolean;
}, z.core.$strip>;
export type StatuslineState = z.infer<typeof StatuslineStateSchema>;
/** Where `ch` records whether it currently manages Claude Code's statusLine. */
export declare function defaultStatuslineStatePath(): string;
/**
 * Chameleon's own recorded choice for whether it manages the statusLine, or
 * undefined when no choice has ever been recorded — the case a machine's
 * first apply resolves for itself (see claude-code.ts's
 * ensureStatusLineConfigured). A file that exists but cannot be understood is
 * treated the same as missing, the same "report the fact, never throw"
 * contract readActivePackState already follows for its own state file.
 */
export declare function readStatuslineState(statePath?: string): StatuslineState | undefined;
/**
 * Records `isEnabled` as Chameleon's own choice for whether it manages the
 * statusLine — `chm statusline on`/`off`'s explicit request, or the decision
 * a machine's first apply makes for itself when nothing has been recorded
 * yet.
 */
export declare function writeStatuslineState(isEnabled: boolean, statePath?: string): void;
export {};
