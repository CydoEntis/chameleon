import { describe, expect, it } from "vitest";
import { TARGETS, VERSION } from "../src/index.js";

describe("package surface", () => {
  it("exports a version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("names every target exactly once", () => {
    expect(new Set(TARGETS).size).toBe(TARGETS.length);
  });
});
