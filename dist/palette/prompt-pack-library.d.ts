import { type PromptLayout, type PromptPackManifest } from "./prompt-pack.js";
/** One bundled prompt pack, fully loaded: its manifest and the layout it names. */
export interface BundledPromptPack {
    readonly manifest: PromptPackManifest;
    readonly layout: PromptLayout;
}
/**
 * Reads every bundled prompt pack from prompts/index.json and the
 * `.omp.json` layout each entry names. Re-runs the same lint the build-time
 * check already ran (see tools/lint-prompt-packs.ts) — the packs under
 * prompts/ are generated and committed by this project, never user-edited,
 * but they still cross a file-system boundary into the running CLI, so a
 * corrupted or hand-edited file fails here with a named reason rather than
 * shipping a colour or a pairing CLAUDE.md's authoring rule forbids. This is
 * the one place src/palette/ touches the filesystem outside of tests — see
 * theme-pack-library.ts's loadCuratedThemePacks for the same, pre-existing
 * exemption: the packs are read-only, shipped with the package, and never
 * user-owned.
 */
export declare function loadBundledPromptPacks(): BundledPromptPack[];
