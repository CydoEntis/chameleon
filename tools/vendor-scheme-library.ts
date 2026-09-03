import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { toPalette, type Palette } from "../src/palette/palette.js";
import { parseScheme, type Scheme } from "../src/palette/scheme.js";

/**
 * Windows Terminal scheme JSON vendored from mbadolato/iTerm2-Color-Schemes
 * (MIT), pinned to a commit — see vendor/iterm2-color-schemes/SOURCE.txt.
 * Build-time only: the 606 schemes here are the input tools/build-theme-packs.ts
 * turns into the twelve curated packs under themes/. vendor/ is not listed
 * in package.json's "files" and never ships — nothing on the `ch` startup
 * path reads it. See src/palette/theme-pack-library.ts for the runtime
 * loader that reads the generated packs instead.
 */
// Resolved from process.cwd(), not import.meta.url: this file only ever runs
// compiled by tsconfig.tools.json (see package.json's "generate:themes"),
// invoked from the repo root, and its build output directory depth is an
// implementation detail of that tsconfig — not something a vendor path
// should have to track.
const VENDORED_SCHEME_DIR = path.join(
  process.cwd(),
  "vendor",
  "iterm2-color-schemes",
  "windows-terminal",
);

/** Reads and parses every vendored Windows Terminal scheme file name into its raw Scheme, keyed by file name. */
export function readVendoredScheme(fileName: string): Scheme {
  const filePath = path.join(VENDORED_SCHEME_DIR, fileName);
  const rawJson: unknown = JSON.parse(readFileSync(filePath, "utf8"));

  try {
    return parseScheme(rawJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`vendored scheme "${fileName}" failed to parse: ${reason}`);
  }
}

/** Every vendored scheme's own JSON file name, unfiltered. */
export function listVendoredSchemeFileNames(): string[] {
  return readdirSync(VENDORED_SCHEME_DIR).filter((fileName) => fileName.endsWith(".json"));
}

/**
 * Reads and parses every vendored Windows Terminal scheme into a Palette.
 * Kept for the build-time tooling that wants the whole library measured —
 * tools/build-theme-packs.ts itself only needs the curated 26 and reads
 * those directly with readVendoredScheme.
 */
export function loadVendoredSchemes(): Palette[] {
  return listVendoredSchemeFileNames().map((fileName) => toPalette(readVendoredScheme(fileName)));
}
