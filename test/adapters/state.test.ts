import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readActivePackState, writeActivePackState } from "../../src/adapters/state.js";

let stateDir: string;
let statePath: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-state-"));
  statePath = path.join(stateDir, "active-pack.json");
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("readActivePackState", () => {
  it("returns undefined when no state file has ever been written", () => {
    expect(readActivePackState(statePath)).toBeUndefined();
  });

  it("returns undefined when the state file is not valid JSON", () => {
    writeFileSync(statePath, "{ not json", "utf8");
    expect(readActivePackState(statePath)).toBeUndefined();
  });

  it("returns undefined when the state file's shape does not match — a slug is required", () => {
    writeFileSync(statePath, JSON.stringify({ updatedAtMs: Date.now() }), "utf8");
    expect(readActivePackState(statePath)).toBeUndefined();
  });

  it("reads back exactly what writeActivePackState wrote", () => {
    writeActivePackState("catppuccin-dark", statePath);

    const state = readActivePackState(statePath);
    expect(state?.slug).toBe("catppuccin-dark");
    expect(typeof state?.updatedAtMs).toBe("number");
  });
});

describe("writeActivePackState", () => {
  it("creates the state directory when it does not exist yet", () => {
    const nestedStatePath = path.join(stateDir, "nested", "active-pack.json");

    writeActivePackState("dracula-dark", nestedStatePath);

    expect(readActivePackState(nestedStatePath)?.slug).toBe("dracula-dark");
  });

  it("replaces an earlier state on a second write rather than appending", () => {
    writeActivePackState("catppuccin-dark", statePath);
    writeActivePackState("dracula-dark", statePath);

    expect(readActivePackState(statePath)?.slug).toBe("dracula-dark");
    // Exactly one JSON object on disk, not two concatenated.
    expect(() => JSON.parse(readFileSync(statePath, "utf8"))).not.toThrow();
  });
});
