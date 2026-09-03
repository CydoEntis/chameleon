import { describe, expect, it } from "vitest";
import { TEXT_MIN_RATIO, MUTED_MIN_RATIO, ROLES } from "../../src/constants.js";
import { contrastRatio } from "../../src/palette/color.js";
import { buildThemePack, parseThemePack, parseUserPackManifest } from "../../src/palette/theme-pack.js";
import { readVendoredScheme } from "../../tools/vendor-scheme-library.js";

const ATTRIBUTION = {
  source: "mbadolato/iTerm2-Color-Schemes",
  sourceUrl: "https://github.com/mbadolato/iTerm2-Color-Schemes",
  commit: "752a9c079396cc9939b86e893578ed81e80c140f",
  license: "MIT",
};

describe("buildThemePack", () => {
  it("carries the source scheme's identity and appearance into the manifest", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula", ATTRIBUTION);

    expect(pack.manifest.name).toBe("Dracula");
    expect(pack.manifest.family).toBe("Dracula");
    expect(pack.manifest.appearance).toBe("dark");
    expect(pack.manifest.slug).toBe("dracula-dark");
    expect(pack.manifest.attribution).toEqual(ATTRIBUTION);
  });

  it("ships the raw scheme as the windows-terminal payload, unmodified", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula", ATTRIBUTION);

    expect(pack.payloads["windows-terminal"]).toEqual(scheme);
  });

  it("resolves a role hex table for oh-my-posh and herdr, matching each other", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula", ATTRIBUTION);

    expect(pack.payloads["oh-my-posh"]).toEqual(pack.payloads.herdr);
    for (const role of ROLES) {
      expect(pack.payloads["oh-my-posh"][role]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("repairs Solarized Dark's muted, which fails its floor before repair (fixture: 2.11)", () => {
    const scheme = readVendoredScheme("iTerm2 Solarized Dark.json");
    const pack = buildThemePack(scheme, "Solarized", ATTRIBUTION);

    const groundHex = pack.payloads["oh-my-posh"].ground;
    const mutedHex = pack.payloads["oh-my-posh"].muted;
    expect(contrastRatio(mutedHex, groundHex)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  it("clears every text role's floor for every curated family — Gruvbox Dark's accent fails before repair (fixture: 3.48)", () => {
    const scheme = readVendoredScheme("Gruvbox Dark.json");
    const pack = buildThemePack(scheme, "Gruvbox", ATTRIBUTION);

    const groundHex = pack.payloads["oh-my-posh"].ground;
    for (const role of ["body", "accent", "success", "error"] as const) {
      const hex = pack.payloads["oh-my-posh"][role];
      expect(contrastRatio(hex, groundHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    }
  });

  it("omits attribution entirely when none is given — a user pack has no upstream to credit", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula");

    expect(pack.manifest.attribution).toBeUndefined();
    expect(Object.hasOwn(pack.manifest, "attribution")).toBe(false);
  });
});

describe("parseThemePack", () => {
  it("round-trips a built pack through JSON", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula", ATTRIBUTION);

    const roundTripped = parseThemePack(JSON.parse(JSON.stringify(pack)), "dracula-dark.json");
    expect(roundTripped).toEqual(pack);
  });

  it("names the file when a pack is malformed", () => {
    expect(() => parseThemePack({ manifest: {} }, "broken.json")).toThrow(/broken\.json/);
  });
});

describe("parseUserPackManifest", () => {
  it("parses a user manifest naming a scheme and a family", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const manifest = parseUserPackManifest({ family: "My Dracula", scheme }, "my-dracula");

    expect(manifest.family).toBe("My Dracula");
    expect(manifest.scheme).toEqual(scheme);
  });

  it("allows family to be omitted", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const manifest = parseUserPackManifest({ scheme }, "my-dracula");

    expect(manifest.family).toBeUndefined();
  });

  it("names the pack directory when a user manifest is malformed", () => {
    expect(() => parseUserPackManifest({ family: "Broken" }, "broken-pack")).toThrow(/broken-pack/);
  });
});
