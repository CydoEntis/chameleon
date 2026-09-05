import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ANSI_SLOT_NAMES } from "../src/palette/ansi.js";
import { contrastRatio } from "../src/palette/color.js";
import { buildThemePack, type PackAttribution, type ThemePack } from "../src/palette/theme-pack.js";
import type { Appearance } from "../src/palette/palette.js";
import type { Scheme } from "../src/palette/scheme.js";
import { readVendoredScheme } from "./vendor-scheme-library.js";

// Resolved from process.cwd(), not import.meta.url — see the comment on
// VENDORED_SCHEME_DIR in vendor-scheme-library.ts: this script only ever
// runs compiled, invoked from the repo root via `npm run generate:themes`.
const THEMES_DIR = path.join(process.cwd(), "themes");
const VENDOR_LICENSE_PATH = path.join(process.cwd(), "vendor", "iterm2-color-schemes", "LICENSE");

/** Pinned to the same commit vendor/iterm2-color-schemes/SOURCE.txt names — see that file to update. */
const ATTRIBUTION: PackAttribution = {
  source: "mbadolato/iTerm2-Color-Schemes",
  sourceUrl: "https://github.com/mbadolato/iTerm2-Color-Schemes",
  commit: "752a9c079396cc9939b86e893578ed81e80c140f",
  license: "MIT",
};

interface CuratedEntry {
  readonly fileName: string;
  readonly family: string;
  /** The variant this ticket's build must produce — cross-checked against the source scheme's own measured appearance, so a wrong entry here fails the build instead of shipping a mislabeled pack. */
  readonly appearance: Appearance;
}

/**
 * The twelve families (light + dark) plus Dracula and Monokai (dark only) —
 * see CHM-6. Each entry names the single vendored file this project treats
 * as that family's canonical variant; where a family ships several (Ayu,
 * Nord, Gruvbox, Kanagawa, Everforest all have more than one dark or light
 * take upstream) the flagship / most-cited variant is picked, not the
 * first alphabetically.
 */
const CURATED_SCHEMES: readonly CuratedEntry[] = [
  { fileName: "GitHub Dark Default.json", family: "GitHub", appearance: "dark" },
  { fileName: "GitHub Light Default.json", family: "GitHub", appearance: "light" },
  { fileName: "One Half Dark.json", family: "One Half", appearance: "dark" },
  { fileName: "One Half Light.json", family: "One Half", appearance: "light" },
  { fileName: "Ayu Mirage.json", family: "Ayu", appearance: "dark" },
  { fileName: "Ayu Light.json", family: "Ayu", appearance: "light" },
  { fileName: "Night Owl.json", family: "Night Owl", appearance: "dark" },
  { fileName: "Night Owlish Light.json", family: "Night Owl", appearance: "light" },
  { fileName: "TokyoNight Night.json", family: "Tokyo Night", appearance: "dark" },
  { fileName: "TokyoNight Day.json", family: "Tokyo Night", appearance: "light" },
  { fileName: "Catppuccin Mocha.json", family: "Catppuccin", appearance: "dark" },
  { fileName: "Catppuccin Latte.json", family: "Catppuccin", appearance: "light" },
  { fileName: "Nord.json", family: "Nord", appearance: "dark" },
  { fileName: "Nord Light.json", family: "Nord", appearance: "light" },
  { fileName: "Gruvbox Dark.json", family: "Gruvbox", appearance: "dark" },
  { fileName: "Gruvbox Light.json", family: "Gruvbox", appearance: "light" },
  { fileName: "Rose Pine.json", family: "Rosé Pine", appearance: "dark" },
  { fileName: "Rose Pine Dawn.json", family: "Rosé Pine", appearance: "light" },
  { fileName: "iTerm2 Solarized Dark.json", family: "Solarized", appearance: "dark" },
  { fileName: "iTerm2 Solarized Light.json", family: "Solarized", appearance: "light" },
  { fileName: "Kanagawa Wave.json", family: "Kanagawa", appearance: "dark" },
  { fileName: "Kanagawa Lotus.json", family: "Kanagawa", appearance: "light" },
  { fileName: "Everforest Dark Med.json", family: "Everforest", appearance: "dark" },
  { fileName: "Everforest Light Med.json", family: "Everforest", appearance: "light" },
  { fileName: "Dracula.json", family: "Dracula", appearance: "dark" },
  { fileName: "Monokai Classic.json", family: "Monokai", appearance: "dark" },
];

/** The twelve two-appearance families plus Dracula and Monokai — see CHM-6's "What". */
const EXPECTED_PACK_COUNT = 26;

/** A built pack alongside the source scheme it was built from — describeAnsiRepairs needs both, to diff shipped against upstream. */
interface BuiltPack {
  readonly scheme: Scheme;
  readonly pack: ThemePack;
}

function buildPackFor(entry: CuratedEntry): BuiltPack {
  const scheme = readVendoredScheme(entry.fileName);
  const pack = buildThemePack(scheme, entry.family, ATTRIBUTION);

  if (pack.manifest.appearance !== entry.appearance) {
    throw new Error(
      `"${entry.fileName}" measures as ${pack.manifest.appearance}, but the curated table declares it ${entry.appearance}`,
    );
  }

  return { scheme, pack };
}

/** themes/index.json — the curated list a future `ch` first run reads, without every pack's full colour payload. */
function buildIndex(packs: readonly ThemePack[]): unknown {
  return packs.map((pack) => ({
    slug: pack.manifest.slug,
    name: pack.manifest.name,
    family: pack.manifest.family,
    appearance: pack.manifest.appearance,
  }));
}

function buildAttributionDoc(packs: readonly ThemePack[]): string {
  const families = [...new Set(packs.map((pack) => pack.manifest.family))].sort((familyA, familyB) =>
    familyA.localeCompare(familyB),
  );
  const familyLines = families.map((family) => `- ${family}`).join("\n");

  return `# Attribution

Every pack under themes/ is adapted from a scheme in
[${ATTRIBUTION.source}](${ATTRIBUTION.sourceUrl}) (${ATTRIBUTION.license}), pinned to
commit \`${ATTRIBUTION.commit}\`. Copyright in each individual theme belongs to its
own author; see LICENSE in this directory for the upstream collection's licence.

Colours here are not byte-for-byte the upstream scheme — Chameleon's contrast
engine (src/palette/) measures every role against its own floor and repairs
whatever fails before a pack ships. See CLAUDE.md, "Never ship a colour that
fails its contrast floor".

## Families

${familyLines}
`;
}

function writeThemesDir(packs: readonly ThemePack[]): void {
  rmSync(THEMES_DIR, { recursive: true, force: true });
  mkdirSync(THEMES_DIR, { recursive: true });

  for (const pack of packs) {
    const packPath = path.join(THEMES_DIR, `${pack.manifest.slug}.json`);
    writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  }

  writeFileSync(path.join(THEMES_DIR, "index.json"), `${JSON.stringify(buildIndex(packs), null, 2)}\n`, "utf8");
  writeFileSync(path.join(THEMES_DIR, "ATTRIBUTION.md"), buildAttributionDoc(packs), "utf8");
  copyFileSync(VENDOR_LICENSE_PATH, path.join(THEMES_DIR, "LICENSE"));
}

/**
 * One line per pack naming the selection trade-off resolveSelectionAndBody
 * made for it — CHM-30's "report the achieved pair per pack so the
 * trade-off is inspectable rather than hidden", printed at the one point a
 * human actually looks at these 26 packs together. Read from herdr's own
 * payload, the one CHM-30 wires selection into, rather than recomputed —
 * so this can never report something other than what actually shipped.
 */
function describeSelectionTradeoff(pack: ThemePack): string {
  const { ground, body, selection_bg: selectionHex } = pack.payloads.herdr;
  const selectionVsGround = contrastRatio(selectionHex, ground).toFixed(2);
  const bodyOnSelection = contrastRatio(body, selectionHex).toFixed(2);
  return `  ${pack.manifest.slug.padEnd(24)} selection-vs-ground ${selectionVsGround}  body-on-selection ${bodyOnSelection}`;
}

/**
 * One line per pack naming which ANSI slots CHM-32's floor repair touched —
 * "report which slots were repaired per pack, so the change is inspectable
 * rather than silent" (CHM-32), the same contract describeSelectionTradeoff
 * follows for the selection trade-off above. Diffed against the pack's own
 * source scheme rather than recomputed, so this can never report something
 * other than what actually shipped.
 */
function describeAnsiRepairs({ scheme, pack }: BuiltPack): string {
  const shippedScheme = pack.payloads["windows-terminal"];
  const repairedSlots = ANSI_SLOT_NAMES.filter((slotName) => shippedScheme[slotName] !== scheme[slotName]);
  const summary = repairedSlots.length > 0 ? repairedSlots.join(", ") : "none";
  return `  ${pack.manifest.slug.padEnd(24)} ANSI slots repaired: ${summary}`;
}

/**
 * Generates the twelve curated theme families (light + dark) plus Dracula
 * and Monokai (dark only) under themes/ — see CHM-6. Run with
 * `npm run generate:themes`; the output is committed, not built on every
 * install, so `themes/` ships as static data and nothing on the `ch`
 * startup path needs the 606-scheme vendor library this reads from.
 */
function main(): void {
  if (CURATED_SCHEMES.length !== EXPECTED_PACK_COUNT) {
    throw new Error(`expected ${EXPECTED_PACK_COUNT} curated schemes, the table has ${CURATED_SCHEMES.length}`);
  }

  const built = CURATED_SCHEMES.map(buildPackFor);
  const packs = built.map((entry) => entry.pack);

  const slugs = packs.map((pack) => pack.manifest.slug);
  if (new Set(slugs).size !== slugs.length) {
    throw new Error(`curated packs do not have unique slugs: ${slugs.join(", ")}`);
  }

  writeThemesDir(packs);
  process.stdout.write(`wrote ${packs.length} theme packs to ${path.relative(process.cwd(), THEMES_DIR)}\n`);
  process.stdout.write(`${packs.map(describeSelectionTradeoff).join("\n")}\n`);
  process.stdout.write(`${built.map(describeAnsiRepairs).join("\n")}\n`);
}

main();
