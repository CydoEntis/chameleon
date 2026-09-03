import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MUTED_MIN_RATIO, TEXT_MIN_RATIO } from "../src/constants.js";
import { contrastRatio } from "../src/palette/color.js";
import { loadAllThemePacks } from "../src/index.js";
import { readVendoredScheme } from "../tools/vendor-scheme-library.js";

let userThemeDir: string;

function writeUserPack(packDirName: string, manifest: unknown): void {
  const packDir = path.join(userThemeDir, packDirName);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(path.join(packDir, "pack.json"), JSON.stringify(manifest), "utf8");
}

beforeEach(() => {
  userThemeDir = mkdtempSync(path.join(tmpdir(), "chameleon-load-all-theme-packs-"));
});

afterEach(() => {
  rmSync(userThemeDir, { recursive: true, force: true });
});

describe("loadAllThemePacks", () => {
  it("returns only bundled packs, marked bundled, when the user directory is empty", () => {
    const { packs, warnings } = loadAllThemePacks(userThemeDir);

    expect(warnings).toEqual([]);
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.every((loaded) => loaded.origin === "bundled")).toBe(true);
  });

  it("merges in a pack dropped into the user directory with no other step, marked user", () => {
    const scheme = { ...readVendoredScheme("0x96f.json"), name: "My 0x96f" };
    writeUserPack("my-0x96f", { scheme });

    const { packs, warnings } = loadAllThemePacks(userThemeDir);
    const droppedIn = packs.find((loaded) => loaded.pack.manifest.name === "My 0x96f");

    expect(warnings).toHaveLength(1); // no declared slug — see the derivation warning
    expect(droppedIn?.origin).toBe("user");
  });

  it("surfaces a malformed user pack as a warning without losing the bundled packs", () => {
    writeUserPack("broken", { family: "Broken" }); // missing "scheme"

    const { packs, warnings } = loadAllThemePacks(userThemeDir);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"broken"/);
    expect(packs.length).toBeGreaterThan(0);
  });

  it("a user pack declaring a bundled pack's own slug replaces it end to end — 26 bundled + 1 override = 26, not 27", () => {
    const { packs: bundledOnly } = loadAllThemePacks(path.join(userThemeDir, "does-not-exist"));
    const bundledCatppuccinDark = bundledOnly.find((loaded) => loaded.pack.manifest.slug === "catppuccin-dark");
    expect(bundledCatppuccinDark).toBeDefined();

    // A pack.json a real user would hand-write: declares the exact slug of
    // an existing bundled family under a scheme and name of its own — the
    // CHM-12 regression this ticket exists to fix is a loader that silently
    // derives a different slug from "family" instead of honouring this.
    const overridingScheme = { ...readVendoredScheme("Dracula.json"), name: "Catppuccin Mocha" };
    writeUserPack("catppuccin-override", {
      slug: "catppuccin-dark",
      name: "Catppuccin Mocha",
      family: "Catppuccin",
      scheme: overridingScheme,
    });

    const { packs, warnings } = loadAllThemePacks(userThemeDir);

    expect(warnings).toEqual([]);
    expect(packs).toHaveLength(bundledOnly.length);

    const overridden = packs.find((loaded) => loaded.pack.manifest.slug === "catppuccin-dark");
    expect(overridden?.origin).toBe("user");
    expect(overridden?.pack.manifest.name).toBe("Catppuccin Mocha");
    // The colours are the user's Dracula-derived scheme, not the bundled
    // Catppuccin Mocha's — proves the override actually swapped the payload,
    // not just the manifest's display name.
    expect(overridden?.pack.payloads["windows-terminal"].background).toBe(overridingScheme.background);
    expect(overridden?.pack.payloads["windows-terminal"].background).not.toBe(
      bundledCatppuccinDark?.pack.payloads["windows-terminal"].background,
    );

    // The override is still run through the same contrast engine and floors
    // as a bundled pack — see CLAUDE.md, "User packs are held to the same
    // contrast floors as bundled ones."
    const roleHexes = overridden!.pack.payloads["oh-my-posh"];
    expect(contrastRatio(roleHexes.body, roleHexes.ground)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(roleHexes.accent, roleHexes.ground)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(roleHexes.muted, roleHexes.ground)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });
});
