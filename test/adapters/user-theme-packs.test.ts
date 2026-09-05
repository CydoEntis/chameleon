import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadUserThemePacks } from "../../src/adapters/user-theme-packs.js";
import { ANSI_MIN_RATIO, MUTED_MIN_RATIO } from "../../src/constants.js";
import { contrastRatio } from "../../src/palette/color.js";
import type { Scheme } from "../../src/palette/scheme.js";
import { readVendoredScheme } from "../../tools/vendor-scheme-library.js";

// Real vendored schemes (mbadolato/iTerm2-Color-Schemes) — never invented hex,
// per code-standards.md's "Colour tests use real schemes' real values". A
// pack's display name is its scheme's own `name`, so a couple of these are
// renamed to a "My ..." variant to prove the manifest — not the loader —
// controls what a user pack is called.
const DRACULA_SCHEME = readVendoredScheme("Dracula.json");
const MY_DRACULA_SCHEME: Scheme = { ...DRACULA_SCHEME, name: "My Dracula" };
// Solarized Dark's muted fails MUTED_MIN_RATIO before repair (fixture: 2.11) —
// see test/palette/theme-pack.test.ts, which proves the same fact for a
// bundled pack. Used here to prove a user pack gets the identical repair.
const SOLARIZED_DARK_SCHEME = readVendoredScheme("iTerm2 Solarized Dark.json");

let userThemeDir: string;

function writePack(packDirName: string, manifest: unknown): void {
  const packDir = path.join(userThemeDir, packDirName);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(path.join(packDir, "pack.json"), JSON.stringify(manifest), "utf8");
}

beforeEach(() => {
  userThemeDir = mkdtempSync(path.join(tmpdir(), "chameleon-user-theme-packs-"));
});

afterEach(() => {
  rmSync(userThemeDir, { recursive: true, force: true });
});

describe("loadUserThemePacks", () => {
  it("returns no packs and no warnings when the directory does not exist yet", () => {
    const result = loadUserThemePacks(path.join(userThemeDir, "does-not-exist"));
    expect(result.packs).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("loads a pack dropped into its own sub-directory, using its declared slug verbatim", () => {
    writePack("my-dracula", { slug: "my-dracula-dark", family: "My Dracula", scheme: MY_DRACULA_SCHEME });

    const result = loadUserThemePacks(userThemeDir);

    expect(result.warnings).toEqual([]);
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]?.manifest.name).toBe("My Dracula");
    expect(result.packs[0]?.manifest.slug).toBe("my-dracula-dark");
    // Apart from selectionBackground, which CHM-30 resolves for every pack,
    // and black, which CHM-32 repairs (fixture: 1.11) — both for a
    // user-supplied pack exactly as for a bundled one, see
    // theme-pack.test.ts's equivalent assertions on Dracula as a bundled
    // pack.
    const wtPayload = result.packs[0]?.payloads["windows-terminal"];
    expect(wtPayload).toEqual({ ...MY_DRACULA_SCHEME, black: wtPayload?.black, selectionBackground: wtPayload?.selectionBackground });
    expect(wtPayload?.black).not.toBe(MY_DRACULA_SCHEME.black);
    expect(contrastRatio(wtPayload?.black ?? "", MY_DRACULA_SCHEME.background)).toBeGreaterThanOrEqual(ANSI_MIN_RATIO);
  });

  it("never derives a slug from name or family when one is declared, even if it disagrees with them", () => {
    // The declared slug bears no relation to "family" + appearance — proves
    // the loader does not fall back to deriving one just because it could.
    // This is the exact defect CHM-12 shipped: a declared slug was silently
    // discarded in favour of one derived from family, so a pack could never
    // collide with — and override — a bundled pack of a different family.
    writePack("catppuccin-override", {
      slug: "catppuccin-dark",
      name: "Catppuccin Mocha",
      family: "My Dracula",
      scheme: MY_DRACULA_SCHEME,
    });

    const result = loadUserThemePacks(userThemeDir);

    expect(result.packs[0]?.manifest.slug).toBe("catppuccin-dark");
  });

  it("falls back to the scheme's own name for family when family is omitted", () => {
    writePack("named-only", { scheme: MY_DRACULA_SCHEME });

    const result = loadUserThemePacks(userThemeDir);

    expect(result.packs[0]?.manifest.family).toBe("My Dracula");
  });

  it("derives a slug from family and appearance when none is declared, and warns that it did", () => {
    writePack("named-only", { family: "My Dracula", scheme: MY_DRACULA_SCHEME });

    const result = loadUserThemePacks(userThemeDir);

    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]?.manifest.slug).toBe("my-dracula-dark");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/"named-only"/);
    expect(result.warnings[0]).toMatch(/no slug/);
  });

  it("repairs a user pack's colours through the same contrast floors as a bundled one", () => {
    writePack("my-solarized", { scheme: SOLARIZED_DARK_SCHEME });

    const result = loadUserThemePacks(userThemeDir);

    const roleHexes = result.packs[0]?.payloads["oh-my-posh"];
    expect(roleHexes).toBeDefined();
    expect(contrastRatio(roleHexes!.muted, roleHexes!.ground)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  it("reports a malformed manifest by the pack's directory name and skips only that pack", () => {
    writePack("broken", { family: "Broken" }); // missing "scheme"
    writePack("fine", { slug: "dracula-dark", scheme: DRACULA_SCHEME });

    const result = loadUserThemePacks(userThemeDir);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/"broken"/);
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]?.manifest.name).toBe("Dracula");
  });

  it("reports a pack directory with no pack.json by name and skips it", () => {
    mkdirSync(path.join(userThemeDir, "empty-dir"), { recursive: true });
    writePack("fine", { slug: "dracula-dark", scheme: DRACULA_SCHEME });

    const result = loadUserThemePacks(userThemeDir);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/"empty-dir"/);
    expect(result.packs).toHaveLength(1);
  });

  it("reports invalid JSON by the pack's directory name and skips only that pack", () => {
    const packDir = path.join(userThemeDir, "invalid-json");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(path.join(packDir, "pack.json"), "{ not valid json", "utf8");
    writePack("fine", { slug: "dracula-dark", scheme: DRACULA_SCHEME });

    const result = loadUserThemePacks(userThemeDir);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/"invalid-json"/);
    expect(result.packs).toHaveLength(1);
  });

  it("does not attribute a user pack to the vendored library", () => {
    writePack("my-dracula", { scheme: MY_DRACULA_SCHEME });

    const result = loadUserThemePacks(userThemeDir);

    expect(result.packs[0]?.manifest.attribution).toBeUndefined();
  });
});
