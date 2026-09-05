import { describe, expect, it } from "vitest";
import type { CurrentPackReport, LoadedThemePack } from "../src/index.js";
import { loadCuratedThemePacks, mergeThemePacksBySlug } from "../src/index.js";
import { formatDriftLine, formatThemeLine, hasDrift, normalizeThemeQuery, resolveThemeQuery, USAGE } from "../src/cli.js";

// CHM-34: `ch doctor` was reporting "drift: none" — a comparison it never
// performed — whenever the recorded pack could no longer be loaded (deleted
// after being applied). `driftedTargets` comes back empty in that case for
// the same reason it comes back empty on a genuine match (see
// currentPack/detectPackDrift in index.pack-commands.test.ts), so
// formatDriftLine/hasDrift must branch on `name === undefined`, not just on
// `driftedTargets.length`, or the two cases are indistinguishable.
function unloadablePackDrift(slug: string): CurrentPackReport {
  return { slug, name: undefined, driftedTargets: [] };
}

function matchingPackDrift(slug: string): CurrentPackReport {
  return { slug, name: "Some Pack", driftedTargets: [] };
}

function driftedPackDrift(slug: string): CurrentPackReport {
  return { slug, name: "Some Pack", driftedTargets: ["oh-my-posh"] };
}

describe("formatDriftLine", () => {
  it("reports nothing to compare when no pack has ever been applied", () => {
    expect(formatDriftLine(undefined)).toBe("drift: no pack has been applied yet — nothing to compare");
  });

  // The deleted-pack case (CHM-34's reproduction): the state file still
  // names a slug, but it no longer resolves to a loadable pack, so no
  // comparison ever ran.
  it("says the check could not run when the recorded pack is no longer available, rather than claiming a match", () => {
    const line = formatDriftLine(unloadablePackDrift("no-such-deleted-pack"));

    expect(line).toBe('cannot check drift: pack "no-such-deleted-pack" is no longer available');
    expect(line).not.toMatch(/drift: none/);
  });

  it("reports none when every detected target matches the recorded, loadable pack", () => {
    expect(formatDriftLine(matchingPackDrift("catppuccin-dark"))).toBe('drift: none — every detected target matches "catppuccin-dark"');
  });

  it("names the targets that no longer match the recorded pack", () => {
    expect(formatDriftLine(driftedPackDrift("catppuccin-dark"))).toBe('drift: oh-my-posh no longer matches "catppuccin-dark"');
  });
});

describe("hasDrift", () => {
  it("is false when no pack has ever been applied", () => {
    expect(hasDrift(undefined)).toBe(false);
  });

  // Exit code must reflect that the check could not run, rather than success
  // — the other half of CHM-34's fix.
  it("is true when the recorded pack could not be loaded, even though driftedTargets is empty", () => {
    expect(hasDrift(unloadablePackDrift("no-such-deleted-pack"))).toBe(true);
  });

  it("is false when every detected target matches the recorded pack", () => {
    expect(hasDrift(matchingPackDrift("catppuccin-dark"))).toBe(false);
  });

  it("is true when a target no longer matches the recorded pack", () => {
    expect(hasDrift(driftedPackDrift("catppuccin-dark"))).toBe(true);
  });
});

// Real bundled packs (loadCuratedThemePacks/mergeThemePacksBySlug), not
// invented fixtures — see CLAUDE.md's "colour tests use real schemes' real
// values." Catppuccin's own two packs (catppuccin-dark "Catppuccin Mocha",
// catppuccin-light "Catppuccin Latte") share a slug and name prefix, which is
// exactly what makes them useful here: real cases of an exact match, a
// prefix that must read as ambiguous, and a near-miss with an obvious "did
// you mean".
const BUNDLED_PACKS: readonly LoadedThemePack[] = mergeThemePacksBySlug(loadCuratedThemePacks(), []);

function findBundledPack(slug: string): LoadedThemePack {
  const loaded = BUNDLED_PACKS.find((candidate) => candidate.pack.manifest.slug === slug);
  if (!loaded) throw new Error(`test fixture error: no bundled pack named "${slug}"`);
  return loaded;
}

describe("normalizeThemeQuery", () => {
  it("lowercases and strips separators so a slug, a name and joined words all collapse to the same key", () => {
    expect(normalizeThemeQuery("Catppuccin Mocha")).toBe("catppuccinmocha");
    expect(normalizeThemeQuery("catppuccin-mocha")).toBe("catppuccinmocha");
    expect(normalizeThemeQuery("catppuccin_mocha")).toBe("catppuccinmocha");
    expect(normalizeThemeQuery("CATPPUCCIN MOCHA")).toBe("catppuccinmocha");
  });
});

describe("formatThemeLine", () => {
  it("shows the display name, never the slug", () => {
    const line = formatThemeLine(findBundledPack("catppuccin-dark"));
    expect(line).toContain("Catppuccin Mocha");
    expect(line).not.toContain("catppuccin-dark");
  });

  it("carries no marker at all for the bundled default — CHM-42's 'a tag on every row means nothing'", () => {
    const line = formatThemeLine(findBundledPack("catppuccin-dark"));
    expect(line).not.toContain("(bundled)");
    expect(line).not.toContain("(user)");
  });

  it("marks a user pack, and only a user pack", () => {
    const bundled = findBundledPack("catppuccin-dark");
    const userPack: LoadedThemePack = { ...bundled, origin: "user" };
    expect(formatThemeLine(userPack)).toContain("(user)");
  });
});

describe("resolveThemeQuery", () => {
  it("resolves an exact slug", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["catppuccin-dark"]);
    expect(result).toEqual({ status: "resolved", loaded: findBundledPack("catppuccin-dark") });
  });

  it("resolves a quoted display name, case- and separator-insensitively", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["CATPPUCCIN-MOCHA"]);
    expect(result).toEqual({ status: "resolved", loaded: findBundledPack("catppuccin-dark") });
  });

  it("resolves several bare words joined into one name", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["catppuccin", "mocha"]);
    expect(result).toEqual({ status: "resolved", loaded: findBundledPack("catppuccin-dark") });
  });

  it("lists every candidate for an ambiguous prefix rather than guessing one", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["catppuccin"]);
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("unreachable");
    const candidateSlugs = result.candidates.map((loaded) => loaded.pack.manifest.slug).sort();
    expect(candidateSlugs).toEqual(["catppuccin-dark", "catppuccin-light"]);
  });

  it("suggests the closest match for a name that resolves to nothing", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["Catpuccin Mocha"]);
    expect(result.status).toBe("unknown");
    if (result.status !== "unknown") throw new Error("unreachable");
    expect(result.closest?.pack.manifest.slug).toBe("catppuccin-dark");
  });
});

describe("USAGE", () => {
  it("names `chm themes` as the way to browse", () => {
    expect(USAGE).toContain("chm themes");
  });
});
