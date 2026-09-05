import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { stateDir } from "./platform.js";

/**
 * Chameleon's single-writer lock (CHM-56). Two `chm` processes have no idea
 * the other exists — a long-lived picker holds the theme that was active
 * when it opened and restores it on exit, silently undoing a real `chm
 * <theme>` applied by a second process while it was up. This is the one file
 * both a picker's whole browsing session and a one-shot apply/undo take
 * before writing a single target, so only one of them is ever actually
 * writing at a time.
 */
const LOCK_FILE_NAME = "lock.json";

const LockInfoSchema = z.object({
  pid: z.number().int().positive(),
  /** What the lock is for, in the same words `chm` would print for it — "chm themes", "chm dracula-dark" — so a process that cannot take the lock can name exactly what is holding it. */
  command: z.string().min(1),
  acquiredAtMs: z.number(),
});

export type LockInfo = z.infer<typeof LockInfoSchema>;

/** Where Chameleon's single-writer lock lives — see platform.ts's stateDir. */
export function defaultLockPath(): string {
  return path.join(stateDir(), LOCK_FILE_NAME);
}

/**
 * Whether `pid` still names a live process — the one signal that tells a
 * lock apart from one left behind by a picker that was killed rather than
 * exited cleanly (CHM-56's "a stale lock must never wedge the tool"). Signal
 * 0 sends nothing; it only asks the OS whether the process exists. EPERM
 * means it exists but is owned by someone else — still alive, just not
 * ours to signal — so only "no such process" reads as gone.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock file's own contents, or undefined when there is none or it cannot be parsed — either way, "nothing recorded" rather than a thrown error, since a corrupted lock file must read as free, not wedge every `chm` after it. */
function readLockInfo(lockPath: string): LockInfo | undefined {
  if (!existsSync(lockPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    const validated = LockInfoSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

/** Creates `lockPath` only when it does not already exist — the one primitive that lets two processes racing to acquire the lock never both believe they won. */
function writeLockExclusive(lockPath: string, info: LockInfo): boolean {
  try {
    writeFileSync(lockPath, JSON.stringify(info, null, 2), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Removes `lockPath`, but only when it still names this process — never a lock some other process has since taken over. */
function releaseLockIfOwnedByThisProcess(lockPath: string): void {
  const holder = readLockInfo(lockPath);
  if (holder?.pid !== process.pid) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone — nothing left to release.
  }
}

export type AcquireLockResult =
  | { readonly status: "acquired"; release(): void }
  | { readonly status: "held"; readonly holder: LockInfo | undefined };

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
export function acquireLock(command: string, lockPath: string = defaultLockPath()): AcquireLockResult {
  mkdirSync(path.dirname(lockPath), { recursive: true });

  const existingHolder = readLockInfo(lockPath);
  if (existingHolder?.pid === process.pid) {
    return { status: "acquired", release: () => {} };
  }
  if (existingHolder !== undefined && isProcessAlive(existingHolder.pid)) {
    return { status: "held", holder: existingHolder };
  }

  // Nothing holds it, or the pid it names is gone — clear any stale file
  // (unlinkSync on one that never existed is caught and ignored) and claim it.
  try {
    unlinkSync(lockPath);
  } catch {
    // There was no lock file to clear.
  }
  const info: LockInfo = { pid: process.pid, command, acquiredAtMs: Date.now() };
  if (writeLockExclusive(lockPath, info)) {
    return { status: "acquired", release: () => releaseLockIfOwnedByThisProcess(lockPath) };
  }
  // Lost the race to reclaim it — report whoever just won it.
  return { status: "held", holder: readLockInfo(lockPath) };
}

/**
 * The live process currently holding Chameleon's lock, or undefined when
 * nothing does — a dead pid's stale file is not reported, the same "gone
 * means free" rule acquireLock itself applies. Never creates, clears or
 * claims anything; `chm current` only wants to know whether a write is in
 * flight, never to act on the lock itself.
 */
export function currentLockHolder(lockPath: string = defaultLockPath()): LockInfo | undefined {
  const holder = readLockInfo(lockPath);
  return holder !== undefined && isProcessAlive(holder.pid) ? holder : undefined;
}
