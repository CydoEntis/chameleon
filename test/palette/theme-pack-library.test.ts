import { describe, expect, it } from "vitest";
import { MUTED_MIN_RATIO, ROLES, TEXT_MIN_RATIO } from "../../src/constants.js";
import { contrastRatio } from "../../src/palette/color.js";
import { loadCuratedThemePacks } from "../../src/palette/theme-pack-library.js";

// The twelve families in CHM-6, each light and dark, plus Dracula and
// Monokai (dark only) — see CLAUDE.md's "What".
const EXPECTED_PACK_COUNT = 26;
const EXPECTED_DARK_ONLY_FAMILIES = ["Dracula", "Monokai"];

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

  it("clears every role's contrast floor on every pack", () => {
    const packs = loadCuratedThemePacks();
    for (const pack of packs) {
      const roleHexes = pack.payloads["oh-my-posh"];
      const groundHex = roleHexes.ground;
      for (const role of ROLES) {
        if (role === "ground") continue;
        const floor = role === "muted" ? MUTED_MIN_RATIO : TEXT_MIN_RATIO;
        expect(contrastRatio(roleHexes[role], groundHex)).toBeGreaterThanOrEqual(floor);
      }
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
