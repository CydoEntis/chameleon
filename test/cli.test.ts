import { describe, expect, it } from "vitest";
import type { CurrentPackReport } from "../src/index.js";
import { formatDriftLine, hasDrift } from "../src/cli.js";

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
