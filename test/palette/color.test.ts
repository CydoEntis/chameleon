import { describe, expect, it } from "vitest";
import {
  chromaOf,
  contrastRatio,
  fromHsl,
  fromHueChromaMatch,
  mix,
  relativeLuminance,
  toHsl,
} from "../../src/palette/color.js";

describe("relativeLuminance", () => {
  it("gives black a relative luminance of 0", () => {
    expect(relativeLuminance("#000000")).toBe(0);
  });

  it("gives white a relative luminance of 1", () => {
    expect(relativeLuminance("#ffffff")).toBe(1);
  });

  it("matches the WCAG value for Catppuccin Mocha's background", () => {
    // #1e1e2e is Catppuccin Mocha's real background — see the vendored
    // scheme at vendor/iterm2-color-schemes/windows-terminal/Catppuccin Mocha.json.
    expect(relativeLuminance("#1e1e2e")).toBeCloseTo(0.014018225783409327, 10);
  });

  it("matches the WCAG value for Gruvbox Light's background", () => {
    // #fbf1c7 is Gruvbox Light's real background.
    expect(relativeLuminance("#fbf1c7")).toBeCloseTo(0.8754334472439043, 10);
  });

  it("is case-insensitive on hex digits", () => {
    expect(relativeLuminance("#1E1E2E")).toBe(relativeLuminance("#1e1e2e"));
  });

  it("rejects a string that is not a 6-digit hex colour", () => {
    expect(() => relativeLuminance("not-a-colour")).toThrow(/hex colour/);
  });
});

describe("contrastRatio", () => {
  it("gives black against white the maximum WCAG ratio of 21", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
  });

  it("gives a colour against itself a ratio of 1", () => {
    expect(contrastRatio("#1e1e2e", "#1e1e2e")).toBe(1);
  });

  it("does not depend on argument order", () => {
    expect(contrastRatio("#1e1e2e", "#cdd6f4")).toBe(contrastRatio("#cdd6f4", "#1e1e2e"));
  });

  it("matches the known ratio between Catppuccin Mocha's background and foreground", () => {
    // #1e1e2e and #cdd6f4 are Catppuccin Mocha's real background and
    // foreground — see the vendored scheme at
    // vendor/iterm2-color-schemes/windows-terminal/Catppuccin Mocha.json.
    expect(contrastRatio("#1e1e2e", "#cdd6f4")).toBeCloseTo(11.341133436863977, 10);
  });

  it("matches the known ratio between iTerm2 Solarized Dark's background and foreground", () => {
    expect(contrastRatio("#002b36", "#839496")).toBeCloseTo(4.747877839876171, 10);
  });
});

describe("toHsl", () => {
  it("gives pure red a hue of 0 at full saturation and mid lightness", () => {
    expect(toHsl("#ff0000")).toEqual({ hue: 0, saturation: 100, lightness: 50 });
  });

  it("gives black and white zero saturation", () => {
    expect(toHsl("#000000")).toEqual({ hue: 0, saturation: 0, lightness: 0 });
    expect(toHsl("#ffffff")).toEqual({ hue: 0, saturation: 0, lightness: 100 });
  });
});

describe("fromHsl", () => {
  it("round-trips pure red", () => {
    expect(fromHsl({ hue: 0, saturation: 100, lightness: 50 })).toBe("#ff0000");
  });

  it("is the inverse of toHsl for a real scheme colour", () => {
    // #268bd2 is iTerm2 Solarized Dark's real blue slot.
    const hsl = toHsl("#268bd2");
    expect(fromHsl(hsl)).toBe("#268bd2");
  });
});

describe("chromaOf", () => {
  it("gives black and white zero chroma", () => {
    expect(chromaOf("#000000")).toBe(0);
    expect(chromaOf("#ffffff")).toBe(0);
  });

  it("gives pure red the maximum chroma of 1", () => {
    expect(chromaOf("#ff0000")).toBe(1);
  });

  it("stays high for a near-white colour that still reads as saturated", () => {
    // #eeff5c is Acid Lime's real yellow slot — full HSL saturation, but
    // also high chroma, unlike a colour that has been pushed toward white
    // by holding saturation instead of chroma constant. See CHM-20.
    expect(chromaOf("#eeff5c")).toBeCloseTo(0.6392156862745098, 10);
  });

  it("is low for a colour HSL would still call saturated but that reads as barely tinted", () => {
    // #fdfff0 is within a rounding step of the near-white colour a
    // fixed-saturation repair used to land Acid Lime's success role on
    // (CHM-17) — 100% HSL saturation, but almost no visible colour left.
    expect(chromaOf("#fdfff0")).toBeCloseTo(0.058823529411764705, 10);
  });
});

describe("fromHueChromaMatch", () => {
  it("round-trips pure red", () => {
    expect(fromHueChromaMatch({ hue: 0, chroma: 1, matchValue: 0 })).toBe("#ff0000");
  });

  it("gives a chroma of 0 the same grey regardless of hue", () => {
    expect(fromHueChromaMatch({ hue: 0, chroma: 0, matchValue: 0.5 })).toBe("#808080");
    expect(fromHueChromaMatch({ hue: 200, chroma: 0, matchValue: 0.5 })).toBe("#808080");
  });

  it("holds chromaOf constant while matchValue sweeps from dark to light", () => {
    // The property repair depends on: moving matchValue never changes how
    // colourful the result reads, only how light it is.
    const hue = 66.3;
    const chroma = 0.5;
    for (const matchValue of [0, 0.1, 0.25, 1 - chroma]) {
      expect(chromaOf(fromHueChromaMatch({ hue, chroma, matchValue }))).toBeCloseTo(chroma, 2);
    }
  });
});

describe("mix", () => {
  // #1e1e2e and #cdd6f4 are Catppuccin Mocha's real background and
  // foreground — see vendor/iterm2-color-schemes/windows-terminal/Catppuccin Mocha.json.
  const MOCHA_BACKGROUND = "#1e1e2e";
  const MOCHA_FOREGROUND = "#cdd6f4";

  it("returns hexA unchanged at fraction 0", () => {
    expect(mix(MOCHA_BACKGROUND, MOCHA_FOREGROUND, 0)).toBe(MOCHA_BACKGROUND);
  });

  it("returns hexB unchanged at fraction 1", () => {
    expect(mix(MOCHA_BACKGROUND, MOCHA_FOREGROUND, 1)).toBe(MOCHA_FOREGROUND);
  });

  it("averages each channel at fraction 0.5", () => {
    // (0x1e + 0xcd) / 2 = 117.5 → 118 = 0x76; (0x1e + 0xd6) / 2 = 122 = 0x7a;
    // (0x2e + 0xf4) / 2 = 145 = 0x91.
    expect(mix(MOCHA_BACKGROUND, MOCHA_FOREGROUND, 0.5)).toBe("#767a91");
  });

  it("does not depend on argument order for a given fraction of travel", () => {
    expect(mix(MOCHA_BACKGROUND, MOCHA_FOREGROUND, 0.25)).toBe(mix(MOCHA_FOREGROUND, MOCHA_BACKGROUND, 0.75));
  });
});
