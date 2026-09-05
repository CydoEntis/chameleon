import { describe, expect, it } from "vitest";
import { MUTED_MIN_RATIO, ROLES, SELECTION_MIN_RATIO, TEXT_MIN_RATIO } from "../../src/constants.js";
import { contrastRatio } from "../../src/palette/color.js";
import { loadCuratedThemePacks, mergeThemePacksBySlug } from "../../src/palette/theme-pack-library.js";
import { buildThemePack } from "../../src/palette/theme-pack.js";
import { readVendoredScheme } from "../../tools/vendor-scheme-library.js";

// The twelve families in CHM-6, each light and dark, plus Dracula and
// Monokai (dark only) — see CLAUDE.md's "What".
const EXPECTED_PACK_COUNT = 26;
const EXPECTED_DARK_ONLY_FAMILIES = ["Dracula", "Monokai"];

/**
 * The 14 of 26 curated packs whose own body sits far enough from ground
 * that a selection colour can clear both of CHM-26's floors at once —
 * SELECTION_MIN_RATIO against ground and TEXT_MIN_RATIO against body. The
 * two floors are multiplicative (a colour between ground and body must be
 * SELECTION_MIN_RATIO times as far from one and TEXT_MIN_RATIO times as far
 * from the other, at once), so clearing both needs roughly
 * SELECTION_MIN_RATIO × TEXT_MIN_RATIO of contrast between body and ground
 * to begin with — see repairSelection's own doc comment in
 * src/palette/repair.ts. The other 12 (solarized-dark measures 4.75 there,
 * deliberately, as part of its own low-contrast design) still get
 * selection's ground-visibility floor — every pack does, unconditionally —
 * but cannot also keep body legible on top of it without a second body
 * colour this project does not have.
 */
const SLUGS_WHERE_SELECTION_KEEPS_BODY_LEGIBLE = [
  "github-dark", "github-light", "one-half-dark", "one-half-light",
  "night-owl-dark", "night-owl-light", "tokyo-night-dark", "catppuccin-dark",
  "gruvbox-dark", "gruvbox-light", "rose-pine-dark", "kanagawa-dark",
  "dracula-dark", "monokai-dark",
];

/** The roles whose floor against ground is not TEXT_MIN_RATIO — mirrors ROLE_FLOOR_OVERRIDES in src/palette/theme-pack.ts. A lookup rather than a chain of ternaries, per code-standards.md. */
const ROLE_FLOOR_OVERRIDES: Readonly<Partial<Record<(typeof ROLES)[number], number>>> = {
  muted: MUTED_MIN_RATIO,
  selection: SELECTION_MIN_RATIO,
};

describe("loadCuratedThemePacks", () => {
  it("loads exactly the curated 26 — the front row, not the full ~600-scheme library", () => {
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBe(EXPECTED_PACK_COUNT);
  });

  it("gives every pack a unique slug", () => {
    const slugs = loadCuratedThemePacks().map((pack) => pack.manifest.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("ships a payload for every target on every pack", () => {
    const packs = loadCuratedThemePacks();
    for (const pack of packs) {
      expect(pack.payloads["windows-terminal"]).toBeDefined();
      expect(pack.payloads["oh-my-posh"]).toBeDefined();
      expect(pack.payloads.herdr).toBeDefined();
    }
  });

  it("ships attribution and an MIT licence on every pack", () => {
    const packs = loadCuratedThemePacks();
    for (const pack of packs) {
      expect(pack.manifest.attribution.license).toBe("MIT");
      expect(pack.manifest.attribution.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("clears every role's own floor against ground on every pack", () => {
    const packs = loadCuratedThemePacks();
    for (const pack of packs) {
      const roleHexes = pack.payloads["oh-my-posh"];
      const groundHex = roleHexes.ground;
      for (const role of ROLES) {
        if (role === "ground") continue;
        const floor = ROLE_FLOOR_OVERRIDES[role] ?? TEXT_MIN_RATIO;
        expect(contrastRatio(roleHexes[role], groundHex), `${pack.manifest.slug}: ${role}`).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  // CHM-26: selection is measured against two references — ground (is the
  // highlight visible?) and body (does the text drawn on top of it stay
  // legible?) — and the test above only ever checks the first. This checks
  // the second, on exactly the packs where it is reachable at all — see
  // SLUGS_WHERE_SELECTION_KEEPS_BODY_LEGIBLE's own doc comment for why the
  // other 12 are not a bug.
  it("keeps body legible on top of selection, on every pack whose own body/ground contrast leaves room for it", () => {
    const packs = loadCuratedThemePacks();
    for (const slug of SLUGS_WHERE_SELECTION_KEEPS_BODY_LEGIBLE) {
      const pack = packs.find((candidate) => candidate.manifest.slug === slug);
      if (!pack) throw new Error(`expected a curated pack named "${slug}"`);
      const roleHexes = pack.payloads["oh-my-posh"];
      expect(contrastRatio(roleHexes.body, roleHexes.selection), slug).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    }
  });

  it("keeps muted strictly below body's contrast, so it reads as secondary", () => {
    const packs = loadCuratedThemePacks();
    for (const pack of packs) {
      const roleHexes = pack.payloads["oh-my-posh"];
      const groundHex = roleHexes.ground;
      expect(contrastRatio(roleHexes.muted, groundHex)).toBeLessThan(
        contrastRatio(roleHexes.body, groundHex),
      );
    }
  });

  it("has both a light and a dark pack for every family except the dark-only ones", () => {
    const packs = loadCuratedThemePacks();
    const appearancesByFamily = new Map<string, Set<string>>();
    for (const pack of packs) {
      const appearances = appearancesByFamily.get(pack.manifest.family) ?? new Set();
      appearances.add(pack.manifest.appearance);
      appearancesByFamily.set(pack.manifest.family, appearances);
    }

    for (const [family, appearances] of appearancesByFamily) {
      if (EXPECTED_DARK_ONLY_FAMILIES.includes(family)) {
        expect([...appearances]).toEqual(["dark"]);
      } else {
        expect(appearances.has("light")).toBe(true);
        expect(appearances.has("dark")).toBe(true);
      }
    }
  });
});

describe("mergeThemePacksBySlug", () => {
  it("marks every bundled pack's origin as bundled when there is no user pack to override it", () => {
    const bundledPacks = loadCuratedThemePacks();
    const merged = mergeThemePacksBySlug(bundledPacks, []);

    expect(merged).toHaveLength(bundledPacks.length);
    expect(merged.every((loaded) => loaded.origin === "bundled")).toBe(true);
  });

  it("lets a user pack override a bundled pack of the same slug — the exact count and colours from the ticket: 26 bundled + 1 override = 26, not 27", () => {
    const bundledPacks = loadCuratedThemePacks();
    const draculaScheme = readVendoredScheme("Dracula.json");
    // A different family and name from the bundled "Dracula" pack — the
    // only thing that matches is the explicit slug, proving the override
    // fires on the declared slug and nothing else.
    const overridingPack = buildThemePack(
      { ...draculaScheme, name: "My Custom Dracula" },
      "Not Dracula At All",
      undefined,
      "dracula-dark",
    );

    const merged = mergeThemePacksBySlug(bundledPacks, [overridingPack]);
    const draculaEntry = merged.find((loaded) => loaded.pack.manifest.slug === "dracula-dark");

    expect(merged).toHaveLength(bundledPacks.length);
    expect(draculaEntry?.origin).toBe("user");
    expect(draculaEntry?.pack.manifest.name).toBe("My Custom Dracula");
  });

  it("adds a user pack whose slug matches no bundled pack, marked as user", () => {
    const bundledPacks = loadCuratedThemePacks();
    const scheme = readVendoredScheme("0x96f.json");
    const newPack = buildThemePack(scheme, "0x96f");

    const merged = mergeThemePacksBySlug(bundledPacks, [newPack]);
    const newEntry = merged.find((loaded) => loaded.pack.manifest.slug === newPack.manifest.slug);

    expect(merged).toHaveLength(bundledPacks.length + 1);
    expect(newEntry?.origin).toBe("user");
  });
});
