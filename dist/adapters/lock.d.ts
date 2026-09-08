import { z } from "zod";
declare const LockInfoSchema: z.ZodObject<{
    pid: z.ZodNumber;
    command: z.ZodString;
    acquiredAtMs: z.ZodNumber;
}, z.core.$strip>;
export type LockInfo = z.infer<typeof LockInfoSchema>;
/** Where Chameleon's single-writer lock lives — see platform.ts's stateDir. */
export declare function defaultLockPath(): string;
export type AcquireLockResult = {
    readonly status: "acquired";
    release(): void;
} | {
    readonly status: "held";
    readonly holder: LockInfo | undefined;
};
/**
 * Takes Chameleon's single-writer lock for `command`, so a second `chm`
 * cannot start writing while this one holds it. `holder` comes back
 * undefined only when the lock file exists but could not be read — still
 * held by someone, just not nameable.
 *
 * Re-entrant within the same process: a picker that already holds the lock
 * for its whole browsing session sees its own debounced preview writes
 * acquire it again immediately, and `release()` on that nested acquisition
 * is a no-op — only the session's own original `release()` may actually free
 * it. This is what lets the lock be "held across the picker's whole session,
 * not just each write" (CHM-56) while every write inside that session still
 * goes through the same acquire path as a one-shot command's own.
 *
 * A lock naming a pid that is no longer running is treated as free, not
 * held — a picker killed rather than exited leaves exactly this behind, and
 * the next `chm` must not need manual cleanup to recover from it.
 */
export declare function acquireLock(command: string, lockPath?: string): AcquireLockResult;
/**
 * The live process currently holding Chameleon's lock, or undefined when
 * nothing does — a dead pid's stale file is not reported, the same "gone
 * means free" rule acquireLock itself applies. Never creates, clears or
 * claims anything; `chm current` only wants to know whether a write is in
 * flight, never to act on the lock itself.
 */
export declare function currentLockHolder(lockPath?: string): LockInfo | undefined;
export {};
