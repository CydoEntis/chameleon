import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { TARGETS, VERSION } from "../src/index.js";
import packageJson from "../package.json" with { type: "json" };

describe("package surface", () => {
  it("exports a version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("names every target exactly once", () => {
    expect(new Set(TARGETS).size).toBe(TARGETS.length);
  });

  it("does not list the vendored scheme library among the published files", () => {
    // vendor/ is the ~600-scheme input tools/build-theme-packs.ts turns into
    // the curated packs under themes/ — see CHM-6. Only the packs ship; the
    // 1 MB of source schemes that generated them must not.
    expect(packageJson.files).not.toContain("vendor");
  });

  it("does not include a vendored scheme in what `npm pack` would publish", () => {
    // No user-controlled input in this command — a fixed, literal string is
    // simpler here than execFileSync's shell-escaping caveats on Windows,
    // where npm itself is a .cmd shim that requires a shell to invoke.
    const dryRunOutput = execSync("npm pack --dry-run --json", { encoding: "utf8" });
    const [packResult] = JSON.parse(dryRunOutput) as Array<{ files: Array<{ path: string }> }>;
    const publishedPaths = packResult?.files.map((file) => file.path) ?? [];

    expect(publishedPaths.some((filePath) => filePath.startsWith("vendor/"))).toBe(false);
  });
});
