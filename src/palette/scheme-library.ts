import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toPalette, type Palette } from "./palette.js";
import { parseScheme } from "./scheme.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Windows Terminal scheme JSON vendored from mbadolato/iTerm2-Color-Schemes
 * (MIT), pinned to a commit — see vendor/iterm2-color-schemes/SOURCE.txt.
 * Ships inside the package; Chameleon never fetches a scheme at runtime.
 */
const VENDORED_SCHEME_DIR = path.join(
  currentDir,
  "..",
  "..",
  "vendor",
  "iterm2-color-schemes",
  "windows-terminal",
);

/**
 * Reads and parses every vendored Windows Terminal scheme into a Palette.
 *
 * This is the one place src/palette/ touches the filesystem — the schemes
 * are read-only, shipped with the package, and never user-owned, so the
 * loader is exempt from the "no I/O in palette/" rule the rest of this
 * directory holds to.
 */
export function loadVendoredSchemes(): Palette[] {
  const schemeFileNames = readdirSync(VENDORED_SCHEME_DIR).filter((fileName) =>
    fileName.endsWith(".json"),
  );

  return schemeFileNames.map((fileName) => parseVendoredScheme(fileName));
}

function parseVendoredScheme(fileName: string): Palette {
  const filePath = path.join(VENDORED_SCHEME_DIR, fileName);
  const rawJson: unknown = JSON.parse(readFileSync(filePath, "utf8"));

  try {
    return toPalette(parseScheme(rawJson));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`vendored scheme "${fileName}" failed to parse: ${reason}`);
  }
}
