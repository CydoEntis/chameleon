import { type ThemePack } from "./theme-pack.js";
/**
 * Reads every bundled pack from themes/. This is the one place src/palette/
 * touches the filesystem outside of tests — the packs are read-only,
 * shipped with the package, and never user-owned, the same exemption
 * loadVendoredSchemes held before it moved to build-time-only tooling (see
 * tools/vendor-scheme-library.ts). Nothing on this path reads vendor/.
 */
export declare function loadCuratedThemePacks(): ThemePack[];
/** Where a loaded pack came from — what `ch list` marks each entry with. */
export type ThemePackOrigin = "bundled" | "user";
export interface LoadedThemePack {
    readonly pack: ThemePack;
    readonly origin: ThemePackOrigin;
}
/**
 * Combines the bundled library with whatever a user has dropped into their
 * own theme directory, keyed by slug — a user pack sharing a bundled pack's
 * slug wins, so anyone can override a shipped theme without editing the
 * package, and the overridden bundled entry never appears twice. Pure: both
 * lists are already loaded in memory, so this is plain merging, not another
 * read.
 */
export declare function mergeThemePacksBySlug(bundledPacks: readonly ThemePack[], userPacks: readonly ThemePack[]): LoadedThemePack[];
