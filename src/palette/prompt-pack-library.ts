import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertPromptLayoutIsSafe, parsePromptLayout, PromptPackManifestSchema, type PromptLayout, type PromptPackManifest } from "./prompt-pack.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The bundled prompt packs, committed under prompts/ the same way themes/
 * holds the bundled theme packs — see CLAUDE.md's "Layout". Listed in
 * package.json's "files" so it ships on every install.
 */
const PROMPT_PACK_DIR = path.join(currentDir, "..", "..", "prompts");

const PromptPackIndexSchema = z.array(PromptPackManifestSchema);

/** One bundled prompt pack, fully loaded: its manifest and the layout it names. */
export interface BundledPromptPack {
  readonly manifest: PromptPackManifest;
  readonly layout: PromptLayout;
}

/** `manifest`'s own layout file name — CHM-46's "How": a prompt pack is a `.omp.json` plus a small manifest, the two halves this loads back together by slug. */
function layoutFileNameFor(manifest: PromptPackManifest): string {
  return `${manifest.slug}.omp.json`;
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
export function loadBundledPromptPacks(): BundledPromptPack[] {
  const indexRaw: unknown = JSON.parse(readFileSync(path.join(PROMPT_PACK_DIR, "index.json"), "utf8"));
  const index = PromptPackIndexSchema.parse(indexRaw);

  return index.map((manifest) => {
    const fileName = layoutFileNameFor(manifest);
    const layoutText = readFileSync(path.join(PROMPT_PACK_DIR, fileName), "utf8");
    assertPromptLayoutIsSafe(layoutText, fileName);
    return { manifest, layout: parsePromptLayout(JSON.parse(layoutText), fileName) };
  });
}
