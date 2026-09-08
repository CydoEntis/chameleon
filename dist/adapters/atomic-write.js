import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
/**
 * Writes a file so that nothing watching it can ever observe it half-written.
 *
 * This matters because the files Chameleon edits are not inert: Windows
 * Terminal and Herdr both watch their own config and reload the moment it
 * changes, and Oh My Posh re-reads its config on every single prompt render.
 * A plain writeFileSync truncates the target and only then fills it, so a
 * watcher firing inside that window reads an empty or partial file, falls
 * back to its defaults, and repaints — the theme visibly blanks and then
 * comes back a moment later once the complete file lands. The picker made it
 * worst, writing every target again each time the highlight settled.
 *
 * The write therefore lands on a temporary path in the target's own
 * directory, and a single rename publishes it. Rename within one directory is
 * atomic on NTFS and on POSIX alike, so a watcher only ever sees the whole
 * old file or the whole new one, never a seam. A process killed before the
 * rename leaves the target untouched rather than truncated, which is the same
 * property CLAUDE.md's "must survive a crash mid-write" already rests on for
 * the original snapshot.
 *
 * The temporary name carries the pid so two Chameleon processes writing the
 * same target cannot collide on it — they still race for the rename, which
 * the lock in lock.ts is what actually serialises, but neither can corrupt
 * the other's staging file.
 *
 * Callers are responsible for the parent directory existing: the rename has
 * to happen inside it, so creating it here would only move the failure.
 */
export function writeFileAtomically(targetPath, contents) {
    const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
    try {
        writeFileSync(temporaryPath, contents, "utf8");
        renameSync(temporaryPath, targetPath);
    }
    catch (error) {
        // A failed write must not leave its staging file behind for the next
        // reader to trip over — the target itself is still whatever it was, which
        // is the whole point, but the temporary path is this function's to clean up.
        removeIfPresent(temporaryPath);
        throw error;
    }
}
function removeIfPresent(filePath) {
    if (existsSync(filePath))
        rmSync(filePath, { force: true });
}
//# sourceMappingURL=atomic-write.js.map