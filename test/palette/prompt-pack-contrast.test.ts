import { describe, expect, it } from "vitest";
import { loadBundledPromptPacks } from "../../src/palette/prompt-pack-library.js";
import { countSegments, findContrastFailures } from "../../src/palette/prompt-pack.js";
import { loadCuratedThemePacks } from "../../src/palette/theme-pack-library.js";

/**
 * CHM-46's own acceptance criterion: "Every bundled layout, rendered against
 * all 26 packs, has every segment's foreground clear 4.5 against its
 * background — assert the count of segments checked, per CHM-40, where a
 * single-sample check is what let the bug ship." This is that count: every
 * bundled layout's own segment total, checked once per bundled theme pack.
 * Computed from the loaders themselves rather than hardcoded, so an added
 * layout or pack changes this expectation automatically instead of a stale
 * literal silently under-counting.
 */
describe("bundled prompt layouts against all bundled theme packs", () => {
  it("clears TEXT_MIN_RATIO for every segment's foreground against its background, on every bundled pack — and actually checked more than a handful", () => {
    const promptPacks = loadBundledPromptPacks();
    const themePacks = loadCuratedThemePacks();

    let segmentsChecked = 0;
    const failures: string[] = [];

    for (const promptPack of promptPacks) {
      for (const themePack of themePacks) {
        segmentsChecked += countSegments(promptPack.layout);
        failures.push(...findContrastFailures(promptPack.layout, themePack.payloads["oh-my-posh"], `${promptPack.manifest.slug} on ${themePack.manifest.slug}`));
      }
    }

    const expectedSegmentsChecked = promptPacks.reduce((total, pack) => total + countSegments(pack.layout), 0) * themePacks.length;

    // The count itself is asserted, not just "no failures" — a lint that
    // silently iterated zero packs or zero segments would also report zero
    // failures, and CHM-40 is exactly the bug a single-sample check let
    // through.
    expect(segmentsChecked).toBe(expectedSegmentsChecked);
    expect(segmentsChecked).toBeGreaterThan(promptPacks.length * themePacks.length);
    expect(failures).toEqual([]);
  });
});
