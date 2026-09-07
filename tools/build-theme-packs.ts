import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ANSI_SLOT_NAMES } from "../src/palette/ansi.js";
import { contrastRatio } from "../src/palette/color.js";
import { buildThemePack, type PackAttribution, type ThemePack } from "../src/palette/theme-pack.js";
import type { Appearance } from "../src/palette/palette.js";
import type { Scheme } from "../src/palette/scheme.js";
import { readBambooScheme, readCyberdreamScheme, readPaperColorScheme, readTangoTangoScheme } from "./external-scheme-sources.js";
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

/** Pinned to vendor/papercolor-terminal-app/SOURCE.txt — see that file for why a port supplies these two packs, and what verifies it against upstream. */
const PAPERCOLOR_ATTRIBUTION: PackAttribution = {
  source: "tomotargz/papercolor-terminal-app",
  sourceUrl: "https://github.com/tomotargz/papercolor-terminal-app",
  commit: "3b7a1c9ecc0642d355a2d73ba899a1ac2d18a0c7",
  license: "MIT",
};

/** Pinned to vendor/tangotango/SOURCE.txt — see that file for which four values come from here and which come from the Tango scheme. */
const TANGOTANGO_ATTRIBUTION: PackAttribution = {
  source: "juba/color-theme-tangotango",
  sourceUrl: "https://github.com/juba/color-theme-tangotango",
  commit: "6202d4a19ac1def1b2596f1906c4524dd7303563",
  license: "GPL-3.0-or-later",
};

/** Pinned to vendor/cyberdream-nvim/SOURCE.txt — the theme author's own Alacritty export, so no cross-check against another source is needed. */
const CYBERDREAM_ATTRIBUTION: PackAttribution = {
  source: "scottmckendry/cyberdream.nvim",
  sourceUrl: "https://github.com/scottmckendry/cyberdream.nvim",
  commit: "39e1fda12c0704e01029b286a4c7e77e33a0c5cd",
  license: "MIT",
};

/** Pinned to vendor/bamboo-nvim/SOURCE.txt — see that file on why GitHub reports NOASSERTION for a verbatim MIT licence. */
const BAMBOO_ATTRIBUTION: PackAttribution = {
  source: "ribru17/bamboo.nvim",
  sourceUrl: "https://github.com/ribru17/bamboo.nvim",
  commit: "1309bc88bffcf1bedc3e84e7fa9004de93da774a",
  license: "MIT",
};

/** What every pack declares about itself, whatever supplied its colours. */
interface PackEntry {
  readonly family: string;
  /** The variant this ticket's build must produce — cross-checked against the source scheme's own measured appearance, so a wrong entry here fails the build instead of shipping a mislabeled pack. */
  readonly appearance: Appearance;
  /**
   * Ships verbatim instead of the family+appearance slug toSlug would derive
   * — for a standalone family with no light/dark sibling, where the default
   * "-dark" suffix is redundant (CHM-62's jellybeans, shades-of-purple), or
   * where the derived slug would collide with an already-shipped pack's
   * (CHM-62's ayu-dark-deep, which would otherwise derive to "ayu-dark" and
   * collide with the existing Ayu Mirage pack).
   */
  readonly slug?: string;
  /**
   * Overrides the vendored scheme's own "name" field for the shipped pack's
   * display name — for Ayu.json, whose upstream name is the bare "Ayu",
   * ambiguous next to the already-shipped "Ayu Mirage" and "Ayu Light"
   * (CHM-62).
   */
  readonly displayName?: string;
}

/** A pack built from the vendored iTerm2 collection, named by its file there. */
interface CuratedEntry extends PackEntry {
  readonly fileName: string;
}

/**
 * A pack built from one of the two sources outside that collection, which
 * carry their own reader and their own provenance. See
 * tools/external-scheme-sources.ts for why these exist and what verifies
 * them; the attribution travels with the entry so no pack can ever be
 * credited to a collection it did not come from.
 */
interface ExternalEntry extends PackEntry {
  readonly readScheme: () => Scheme;
  readonly attribution: PackAttribution;
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
  // CHM-62: three more dark-only additions, all already in the vendored
  // collection. Ayu Dark (Ayu.json) is a genuinely different scheme from the
  // already-shipped ayu-dark (Ayu Mirage.json) and ayu-light — see the slug
  // and displayName overrides above for how the two stay distinguishable.
  { fileName: "Jellybeans.json", family: "Jellybeans", appearance: "dark", slug: "jellybeans" },
  { fileName: "Shades Of Purple.json", family: "Shades Of Purple", appearance: "dark", slug: "shades-of-purple" },
  { fileName: "Ayu.json", family: "Ayu", appearance: "dark", slug: "ayu-dark-deep", displayName: "Ayu Dark" },
  // Eight more two-appearance families, all already in the vendored
  // collection. Each was measured through buildThemePack before being listed
  // here rather than picked by reputation: Horizon Bright, Poimandres White,
  // Noctis Lux and Tomorrow all build, but land muted within about one point
  // of body, which clears the floor's letter while failing what muted is for
  // — so they are deliberately absent. Atom One Light is absent for a harder
  // reason: its green and cyan slots are the same colour (#3f953a), so two
  // statusline meters collapse onto one value and buildThemePack rejects it.
  { fileName: "Flexoki Dark.json", family: "Flexoki", appearance: "dark" },
  { fileName: "Flexoki Light.json", family: "Flexoki", appearance: "light" },
  { fileName: "Melange Dark.json", family: "Melange", appearance: "dark" },
  { fileName: "Melange Light.json", family: "Melange", appearance: "light" },
  { fileName: "Zenbones Dark.json", family: "Zenbones", appearance: "dark" },
  { fileName: "Zenbones Light.json", family: "Zenbones", appearance: "light" },
  { fileName: "Seoulbones Dark.json", family: "Seoulbones", appearance: "dark" },
  { fileName: "Seoulbones Light.json", family: "Seoulbones", appearance: "light" },
  // Nightfox's own light sibling is named Dawnfox rather than "Nightfox
  // Light", so the pack keeps that name and only the slug carries the family
  // — the same split between name and slug ayu-dark-deep already relies on.
  { fileName: "Nightfox.json", family: "Nightfox", appearance: "dark" },
  { fileName: "Dawnfox.json", family: "Nightfox", appearance: "light" },
  // Fourteen dark-only additions. Each takes an explicit slug for the reason
  // jellybeans and shades-of-purple do: with no light sibling to distinguish
  // them from, the derived "-dark" suffix says nothing.
  // Iceberg ships dark-only: Iceberg Light builds, but recolouring chips
  // with it lands c-badge-text on its resolved error background at 1.97,
  // under CHM-37's own ANSI_MIN_RATIO, and CHM-40's repair cannot reach even
  // the best a single shared foreground could manage there. Carbonfox and
  // Oxocarbon are absent for a related reason: both are deliberately minimal
  // palettes, and both collapse chips's 47 keys to 33 distinct colours where
  // CHM-37 requires 34. All three fail guards that protect a user's own
  // prompt, so they are left out rather than the guards loosened.
  { fileName: "Iceberg Dark.json", family: "Iceberg", appearance: "dark", slug: "iceberg" },
  // Modus Vivendi ships without its light sibling, and Selenized not at all.
  // Modus Operandi and iceberg-light both land CHM-40's repair below the best
  // a single shared foreground could reach against their own segment
  // backgrounds — repairForegroundAgainstBackgrounds picks the better of two
  // directions, which is what it documents, but on these the optimum sits
  // between them. Selenized Dark misses CHM-80's subtext0-on-row floor by
  // 0.078, past the 0.06 band that test holds its own exceptions to, and a
  // light-only family is not a shape anything here supports.
  { fileName: "Modus Vivendi.json", family: "Modus Vivendi", appearance: "dark", slug: "modus-vivendi" },
  { fileName: "Vesper.json", family: "Vesper", appearance: "dark", slug: "vesper" },
  { fileName: "Terafox.json", family: "Terafox", appearance: "dark", slug: "terafox" },
  { fileName: "Embark.json", family: "Embark", appearance: "dark", slug: "embark" },
  { fileName: "Cobalt2.json", family: "Cobalt2", appearance: "dark", slug: "cobalt2" },
  { fileName: "Synthwave.json", family: "Synthwave", appearance: "dark", slug: "synthwave" },
  { fileName: "Snazzy.json", family: "Snazzy", appearance: "dark", slug: "snazzy" },
  { fileName: "Challenger Deep.json", family: "Challenger Deep", appearance: "dark", slug: "challenger-deep" },
  { fileName: "Doom One.json", family: "Doom One", appearance: "dark", slug: "doom-one" },
  { fileName: "Everblush.json", family: "Everblush", appearance: "dark", slug: "everblush" },
  { fileName: "Sonokai.json", family: "Sonokai", appearance: "dark", slug: "sonokai" },
  { fileName: "Moonfly.json", family: "Moonfly", appearance: "dark", slug: "moonfly" },
  { fileName: "Aura Dark.json", family: "Aura", appearance: "dark", slug: "aura" },
];

/**
 * The two families absent from the vendored collection, each read from its
 * own pinned source. PaperColor ships both appearances; TangoTango is
 * dark-only, and takes an explicit slug for the same reason Jellybeans does
 * — it has no light sibling to distinguish it from.
 */
const EXTERNAL_SCHEMES: readonly ExternalEntry[] = [
  {
    readScheme: () => readPaperColorScheme("dark"),
    family: "PaperColor",
    appearance: "dark",
    attribution: PAPERCOLOR_ATTRIBUTION,
  },
  {
    readScheme: () => readPaperColorScheme("light"),
    family: "PaperColor",
    appearance: "light",
    attribution: PAPERCOLOR_ATTRIBUTION,
  },
  {
    readScheme: readTangoTangoScheme,
    family: "TangoTango",
    appearance: "dark",
    slug: "tangotango",
    attribution: TANGOTANGO_ATTRIBUTION,
  },
  // Cyberdream and Bamboo each publish their own Alacritty export, so both
  // read through the one reader and neither needs the verification pass
  // PaperColor does. Each ships a third variant alongside its light/dark
  // pair — a second dark take whose derived slug would collide with the
  // first, so it names its own.
  {
    readScheme: () => readCyberdreamScheme("cyberdream.toml", "Cyberdream"),
    family: "Cyberdream",
    appearance: "dark",
    attribution: CYBERDREAM_ATTRIBUTION,
  },
  {
    readScheme: () => readCyberdreamScheme("cyberdream-light.toml", "Cyberdream Light"),
    family: "Cyberdream",
    appearance: "light",
    attribution: CYBERDREAM_ATTRIBUTION,
  },
  {
    readScheme: () => readCyberdreamScheme("cyberdream-muted.toml", "Cyberdream Muted"),
    family: "Cyberdream",
    appearance: "dark",
    slug: "cyberdream-muted",
    attribution: CYBERDREAM_ATTRIBUTION,
  },
  {
    readScheme: () => readBambooScheme("bamboo.toml", "Bamboo"),
    family: "Bamboo",
    appearance: "dark",
    attribution: BAMBOO_ATTRIBUTION,
  },
  {
    readScheme: () => readBambooScheme("bamboo_light.toml", "Bamboo Light"),
    family: "Bamboo",
    appearance: "light",
    attribution: BAMBOO_ATTRIBUTION,
  },
  {
    readScheme: () => readBambooScheme("bamboo_multiplex.toml", "Bamboo Multiplex"),
    family: "Bamboo",
    appearance: "dark",
    slug: "bamboo-multiplex",
    attribution: BAMBOO_ATTRIBUTION,
  },
];

/**
 * Seventeen two-appearance families plus nineteen dark-only ones. The original
 * twelve pairs and five dark-only are CHM-6's "What" and CHM-62; the five
 * pairs and fourteen dark-only after them were each measured through
 * buildThemePack before being curated, not chosen by reputation — see the
 * note in CURATED_SCHEMES on the ones that were measured and rejected.
 */
const EXPECTED_CURATED_COUNT = 53;

/** PaperColor light + dark, TangoTango, and three variants each of Cyberdream and Bamboo — the nine built from outside the vendored collection. */
const EXPECTED_EXTERNAL_COUNT = 9;

/** A built pack alongside the source scheme it was built from — describeAnsiRepairs needs both, to diff shipped against upstream. */
interface BuiltPack {
  readonly scheme: Scheme;
  readonly pack: ThemePack;
}

function buildPackFor(scheme: Scheme, entry: PackEntry, attribution: PackAttribution): BuiltPack {
  const schemeToBuild = entry.displayName !== undefined ? { ...scheme, name: entry.displayName } : scheme;
  const pack = buildThemePack(schemeToBuild, entry.family, attribution, entry.slug);

  if (pack.manifest.appearance !== entry.appearance) {
    throw new Error(
      `"${scheme.name}" measures as ${pack.manifest.appearance}, but its table entry declares it ${entry.appearance}`,
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

  const externalFamilies = EXTERNAL_SCHEMES.map((entry) => entry.family);
  const externalLines = EXTERNAL_SCHEMES.filter(
    (entry, index) => externalFamilies.indexOf(entry.family) === index,
  )
    .map(
      (entry) =>
        `- **${entry.family}** — [${entry.attribution.source}](${entry.attribution.sourceUrl}) ` +
        `(${entry.attribution.license}), pinned to commit \`${entry.attribution.commit}\``,
    )
    .join("\n");

  return `# Attribution

Most packs under themes/ are adapted from a scheme in
[${ATTRIBUTION.source}](${ATTRIBUTION.sourceUrl}) (${ATTRIBUTION.license}), pinned to
commit \`${ATTRIBUTION.commit}\`. Copyright in each individual theme belongs to its
own author; see LICENSE in this directory for the upstream collection's licence.

Colours here are not byte-for-byte the upstream scheme — Chameleon's contrast
engine (src/palette/) measures every role against its own floor and repairs
whatever fails before a pack ships. See CLAUDE.md, "Never ship a colour that
fails its contrast floor".

## Sources outside that collection

Four families are not in it and come from their own pinned sources. Each pack's
own manifest carries the attribution it was built from, so nothing here is
credited to a collection it did not come from.

${externalLines}

The PaperColor packs are decoded from a Terminal.app port rather than from
NLKNguyen's Vim theme, which has no usable ANSI mapping of its own. The port
is not taken on trust: every one of its 16 slots is checked against the
vendored PaperColor.vim's own \`color00\`..\`color15\` at build time. See
vendor/papercolor-theme/SOURCE.txt and vendor/papercolor-terminal-app/SOURCE.txt.

The TangoTango pack takes its normal 8 ANSI slots and its background,
foreground, cursor and selection from juba's Emacs theme, which is
**GPL-3.0-or-later** where Chameleon itself is MIT — those bare colour values
are the whole of what is used from it. Its bright 8, which the Emacs theme does
not define, come from "Builtin Tango Dark" in the MIT collection above. See
vendor/tangotango/SOURCE.txt.

The Cyberdream and Bamboo packs are read from each theme's own Alacritty
export, published by the theme itself rather than by a third party. That is
why neither needs the kind of verification pass PaperColor does: the export
*is* upstream, and its 16 ANSI slots are authoritative and correctly named.
Alacritty carries no cursor colour unless a theme sets one and neither does,
so the cursor is seeded from foreground; Bamboo sets no selection colour
either, so that is seeded from its background and resolved from the accent.
See vendor/cyberdream-nvim/SOURCE.txt and vendor/bamboo-nvim/SOURCE.txt.

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
 * human actually looks at these 29 packs together. Read from herdr's own
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
 * One line per pack whose Windows Terminal `foreground` moved away from the
 * scheme's own authored value — CHM-33's "the amount each pack moved should
 * be reported rather than applied silently". `foreground` only ever departs
 * from the scheme's own when resolveSelectionAndBody nudged body further
 * from ground to open up room for a selection clearing body-on-selection
 * (see selection.ts's own doc comment on widenedBodyLuminance), so a line
 * here for a pack is that nudge made inspectable, not a second repair pass.
 * Omitted for a pack whose foreground never moved, the overwhelming
 * majority — see describeAnsiRepairs above for why this reads from the
 * shipped payload rather than recomputing it.
 */
function describeBodyNudge({ scheme, pack }: BuiltPack): string | undefined {
  const shippedForeground = pack.payloads["windows-terminal"].foreground;
  if (shippedForeground === scheme.foreground) return undefined;

  const groundHex = pack.payloads["windows-terminal"].background;
  const ratioBefore = contrastRatio(scheme.foreground, groundHex).toFixed(2);
  const ratioAfter = contrastRatio(shippedForeground, groundHex).toFixed(2);
  return `  ${pack.manifest.slug.padEnd(24)} body moved ${scheme.foreground} -> ${shippedForeground} for body-on-selection (vs ground ${ratioBefore} -> ${ratioAfter})`;
}

/**
 * Generates the twelve curated theme families (light + dark) plus the five
 * dark-only additions — Dracula, Monokai, Jellybeans, Shades Of Purple and
 * Ayu Dark (CHM-6, CHM-62) — under themes/. Run with `npm run
 * generate:themes`; the output is committed, not built on every install, so
 * `themes/` ships as static data and nothing on the `ch` startup path needs
 * the 606-scheme vendor library this reads from.
 */
function main(): void {
  if (CURATED_SCHEMES.length !== EXPECTED_CURATED_COUNT) {
    throw new Error(`expected ${EXPECTED_CURATED_COUNT} curated schemes, the table has ${CURATED_SCHEMES.length}`);
  }
  if (EXTERNAL_SCHEMES.length !== EXPECTED_EXTERNAL_COUNT) {
    throw new Error(`expected ${EXPECTED_EXTERNAL_COUNT} external schemes, the table has ${EXTERNAL_SCHEMES.length}`);
  }

  const built = [
    ...CURATED_SCHEMES.map((entry) => buildPackFor(readVendoredScheme(entry.fileName), entry, ATTRIBUTION)),
    ...EXTERNAL_SCHEMES.map((entry) => buildPackFor(entry.readScheme(), entry, entry.attribution)),
  ];
  const packs = built.map((entry) => entry.pack);

  const slugs = packs.map((pack) => pack.manifest.slug);
  if (new Set(slugs).size !== slugs.length) {
    throw new Error(`curated packs do not have unique slugs: ${slugs.join(", ")}`);
  }

  writeThemesDir(packs);
  process.stdout.write(`wrote ${packs.length} theme packs to ${path.relative(process.cwd(), THEMES_DIR)}\n`);
  process.stdout.write(`${packs.map(describeSelectionTradeoff).join("\n")}\n`);
  process.stdout.write(`${built.map(describeAnsiRepairs).join("\n")}\n`);

  const bodyNudgeLines = built.map(describeBodyNudge).filter((line): line is string => line !== undefined);
  if (bodyNudgeLines.length > 0) {
    process.stdout.write(`${bodyNudgeLines.join("\n")}\n`);
  }
}

main();
