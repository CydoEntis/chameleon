import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPromptLayoutIsSafe, PromptPackManifestSchema } from "../src/palette/prompt-pack.js";

// Resolved from process.cwd(), not import.meta.url — this script only ever
// runs compiled, invoked from the repo root via `npm run lint:prompts` (see
// tools/build-theme-packs.ts for the same convention).
const PROMPTS_DIR = path.join(process.cwd(), "prompts");

const PromptPackIndexSchema = z.array(PromptPackManifestSchema);

/**
 * The build-time gate CHM-46 asks for: "A bad layout must not be able to
 * ship." Runs the same pure lint (src/palette/prompt-pack.ts) the runtime
 * loader re-checks on every start (prompt-pack-library.ts), but here a
 * failure stops the build outright rather than surfacing at `ch` startup —
 * see CLAUDE.md's "A build-time lint rejects any segment whose
 * foreground/background pair is not ground-paired, and any literal hex
 * anywhere in a bundled layout."
 */
function main(): void {
  const indexRaw: unknown = JSON.parse(readFileSync(path.join(PROMPTS_DIR, "index.json"), "utf8"));
  const index = PromptPackIndexSchema.parse(indexRaw);

  const slugs = index.map((manifest) => manifest.slug);
  if (new Set(slugs).size !== slugs.length) {
    throw new Error(`prompt pack manifests do not have unique slugs: ${slugs.join(", ")}`);
  }

  for (const manifest of index) {
    const fileName = `${manifest.slug}.omp.json`;
    const layoutText = readFileSync(path.join(PROMPTS_DIR, fileName), "utf8");
    assertPromptLayoutIsSafe(layoutText, fileName);
  }

  process.stdout.write(`${index.length} prompt pack(s) under prompts/ are safe to ship\n`);
}

main();
