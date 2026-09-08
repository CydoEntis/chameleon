/**
 * `chm doctor`'s own contrast check (CHM-79): measures the exact same
 * declared inventory theme-pack.ts's build-time gate runs over the 29
 * bundled packs (see palette/surfaces.ts), but against whichever config
 * files are actually sitting on this machine right now. The build-time gate
 * proves a pack ships legible; this proves it is *still* legible on a real
 * machine, after real hand-edits, real partial applies and real drift
 * (CHM-27) — a pack could ship every pair clearing its floor and a config a
 * user then edited by hand could still fail one of them. Read-only: nothing
 * here writes or repairs, it only measures and names what fails.
 */
import { type ContrastFailure } from "./palette/surfaces.js";
/**
 * One target's own share of `chm doctor`'s contrast findings. Undefined
 * means "nothing to report for this target" — not installed, its config
 * could not be read, or (windows-terminal) the currently-applied scheme is
 * not one this inventory can measure — never "clean": a target that is
 * actually clean reports an empty array, so the two are never confused.
 */
export interface DoctorContrastReport {
    readonly herdr: readonly ContrastFailure[] | undefined;
    readonly windowsTerminal: readonly ContrastFailure[] | undefined;
    /**
     * Oh My Posh has no per-pack inventory to measure against — its pairs
     * depend on whichever segments and backgrounds a user's own prompt
     * defines, not on a pack (see this ticket's own body). This reuses
     * repairSegmentForegrounds (CHM-40), the exact measurement `chm`'s own
     * apply already runs, rather than duplicating it — each entry names the
     * palette key that needed a repaired foreground to clear TEXT_MIN_RATIO
     * against its own segment background(s).
     */
    readonly ohMyPosh: readonly string[] | undefined;
}
/**
 * Runs CHM-79's own contrast gate against this machine's real config files —
 * `chm doctor`'s "does swapping a theme actually leave everything readable
 * and every highlight detectable" check, for whichever targets are
 * installed and themed right now.
 */
export declare function checkLiveContrastInventory(): DoctorContrastReport;
