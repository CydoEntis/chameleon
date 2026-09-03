import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAllThemePacks } from "../src/index.js";
import { readVendoredScheme } from "../tools/vendor-scheme-library.js";

let userThemeDir: string;

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
    const packDir = path.join(userThemeDir, "my-0x96f");
    mkdirSync(packDir, { recursive: true });
    const scheme = { ...readVendoredScheme("0x96f.json"), name: "My 0x96f" };
    writeFileSync(path.join(packDir, "pack.json"), JSON.stringify({ scheme }), "utf8");

    const { packs, warnings } = loadAllThemePacks(userThemeDir);
    const droppedIn = packs.find((loaded) => loaded.pack.manifest.name === "My 0x96f");

    expect(warnings).toEqual([]);
    expect(droppedIn?.origin).toBe("user");
  });

  it("surfaces a malformed user pack as a warning without losing the bundled packs", () => {
    const packDir = path.join(userThemeDir, "broken");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(path.join(packDir, "pack.json"), JSON.stringify({ family: "Broken" }), "utf8");

    const { packs, warnings } = loadAllThemePacks(userThemeDir);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"broken"/);
    expect(packs.length).toBeGreaterThan(0);
  });
});
