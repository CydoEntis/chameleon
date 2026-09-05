import { describe, expect, it } from "vitest";
import { nearestRoleFor } from "../../src/palette/role-mapping.js";

// Every hex below is lifted verbatim from the real, unmodified "chips" Oh My
// Posh community theme (test/adapters/fixtures/chips.omp.json) — the exact
// fixture CHM-31 is about, never invented hex. See code-standards.md's
// "Colour tests use real schemes' real values".

describe("nearestRoleFor", () => {
  it("picks error for a name that says so, regardless of its current colour", () => {
    // c-badge-return-fail-term is a pale red (#FF8A80) in chips, but the
    // name alone is reason enough — a name hint never needs the colour.
    expect(nearestRoleFor("c-badge-return-fail-term", "#FF8A80")).toBe("error");
    expect(nearestRoleFor("c-battery-state-error", "#FF867F")).toBe("error");
  });

  it("picks success for a name that says so, regardless of its current colour", () => {
    expect(nearestRoleFor("c-badge-return-success", "#B2FF59")).toBe("success");
  });

  it("classifies a red-hued key with no reliable name as error", () => {
    // c-git-upstream-gone: red-hued (hue ~3°), no "error"/"fail" in the name.
    expect(nearestRoleFor("c-git-upstream-gone", "#FF867F")).toBe("error");
  });

  it("classifies a green-hued key with no reliable name as success", () => {
    // c-project-node: a saturated green.
    expect(nearestRoleFor("c-project-node", "#9CFF57")).toBe("success");
  });

  it("classifies a cool-hued (blue/cyan/purple) key with no reliable name as accent", () => {
    // c-badge-return-custom: a purple, and c-git-ahead: cyan.
    expect(nearestRoleFor("c-badge-return-custom", "#E7B9FF")).toBe("accent");
    expect(nearestRoleFor("c-git-ahead", "#6EFFFF")).toBe("accent");
  });

  it("classifies a dark, low-saturation key as muted", () => {
    // c-badge-text: near-black, no real hue.
    expect(nearestRoleFor("c-badge-text", "#212121")).toBe("muted");
  });

  it("classifies a light, low-saturation key as body", () => {
    // c-badge-white: near-white, no real hue.
    expect(nearestRoleFor("c-badge-white", "#FAFAFA")).toBe("body");
  });
});
