import { describe, expect, it } from "vitest";
import { loadBundledPromptPacks } from "../../src/palette/prompt-pack-library.js";
import { countSegments, findNerdFontGlyphs } from "../../src/palette/prompt-pack.js";

/** The six layouts CHM-46's own "The layouts" table names. */
const EXPECTED_SLUGS = ["half-life", "lambda", "spaceship", "avit", "di4am0nd", "bubblesline"];

describe("loadBundledPromptPacks", () => {
  it("loads exactly the six bundled prompt packs, and nothing more", () => {
    const packs = loadBundledPromptPacks();
    expect(packs.map((pack) => pack.manifest.slug).sort()).toEqual([...EXPECTED_SLUGS].sort());
  });

  it("gives every pack a unique slug, a name and a non-empty description", () => {
    const packs = loadBundledPromptPacks();
    const slugs = packs.map((pack) => pack.manifest.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const pack of packs) {
      expect(pack.manifest.name.length).toBeGreaterThan(0);
      expect(pack.manifest.description.length).toBeGreaterThan(0);
    }
  });

  it("carries at least one segment on every bundled pack — a pack with zero segments would silently pass every other check", () => {
    const packs = loadBundledPromptPacks();
    for (const pack of packs) {
      expect(countSegments(pack.layout)).toBeGreaterThan(0);
    }
  });

  it("half-life renders with no Nerd Font glyphs at all — the no-font fallback CHM-46 names explicitly", () => {
    const packs = loadBundledPromptPacks();
    const halfLife = packs.find((pack) => pack.manifest.slug === "half-life");
    expect(halfLife?.manifest.requiresNerdFont).toBe(false);
    expect(findNerdFontGlyphs(JSON.stringify(halfLife?.layout))).toEqual([]);
  });

  it("marks every layout but half-life as requiring a Nerd Font", () => {
    const packs = loadBundledPromptPacks();
    for (const pack of packs) {
      const expectsGlyphs = pack.manifest.slug !== "half-life";
      expect(pack.manifest.requiresNerdFont).toBe(expectsGlyphs);
    }
  });
});
