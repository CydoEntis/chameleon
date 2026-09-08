import { type ThemePack } from "../palette/theme-pack.js";
/** Where `ch` looks for user-dropped packs: `<chameleon state dir>/themes/<pack>/pack.json` — see platform.ts's stateDir. */
export declare function defaultUserThemePackDir(): string;
export interface UserThemePackLoadResult {
    readonly packs: readonly ThemePack[];
    readonly warnings: readonly string[];
}
/**
 * Reads every pack a user has dropped into their own theme directory — one
 * sub-directory per pack, each holding a pack.json naming the scheme it
 * adapts. Every pack is run through buildThemePack, the exact pipeline the
 * bundled packs are generated with, so a dropped-in theme clears the same
 * contrast floors a bundled one does — see CLAUDE.md, "User packs are held
 * to the same contrast floors as bundled ones."
 *
 * A missing directory means no user packs exist yet, not an error — this is
 * read on every `ch` invocation, including the first one, before anyone has
 * dropped anything in.
 */
export declare function loadUserThemePacks(themeDir?: string): UserThemePackLoadResult;
