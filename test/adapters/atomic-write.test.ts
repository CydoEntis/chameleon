import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomically } from "../../src/adapters/atomic-write.js";

/**
 * The property under test is that nothing watching one of these files can
 * observe it half-written — see atomic-write.ts for why that matters for
 * Windows Terminal, Herdr and Oh My Posh specifically. A test cannot race a
 * real watcher deterministically, so what is asserted here is the mechanism
 * that guarantees it: the target is only ever published by a rename, so it
 * holds either its whole old content or its whole new content and never a
 * truncated seam, and no staging file is left behind either way.
 */
describe("writeFileAtomically", () => {
  let directory: string;
  let targetPath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "chameleon-atomic-"));
    targetPath = path.join(directory, "settings.json");
  });

  it("writes the contents to a file that did not exist", () => {
    writeFileAtomically(targetPath, '{"theme":"nord"}');

    expect(readFileSync(targetPath, "utf8")).toBe('{"theme":"nord"}');
  });

  it("replaces an existing file's contents", () => {
    writeFileSync(targetPath, '{"theme":"gruvbox"}', "utf8");

    writeFileAtomically(targetPath, '{"theme":"nord"}');

    expect(readFileSync(targetPath, "utf8")).toBe('{"theme":"nord"}');
  });

  it("leaves no staging file behind", () => {
    writeFileAtomically(targetPath, '{"theme":"nord"}');

    expect(readdirSync(directory)).toEqual(["settings.json"]);
  });

  it("leaves the target untouched, and no staging file, when the write fails", () => {
    // A directory standing at the target path makes the rename fail after the
    // staging file has already been written — the one ordering where a
    // half-finished write could leave debris behind. What matters is what is
    // left on disk, not which errno came back.
    const blockedTarget = path.join(directory, "blocked");
    mkdirSync(blockedTarget);

    expect(() => writeFileAtomically(blockedTarget, "anything")).toThrow();

    expect(readdirSync(directory).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(blockedTarget)).toEqual([]);
  });

  it("does not disturb anything else in the directory", () => {
    writeFileSync(path.join(directory, "unrelated.toml"), "keep me", "utf8");

    writeFileAtomically(targetPath, '{"theme":"nord"}');

    expect(readFileSync(path.join(directory, "unrelated.toml"), "utf8")).toBe("keep me");
    expect(existsSync(targetPath)).toBe(true);
  });
});
