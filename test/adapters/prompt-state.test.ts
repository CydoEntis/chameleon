import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPromptState, writePromptState } from "../../src/adapters/prompt-state.js";

let stateDir: string;
let statePath: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-prompt-state-"));
  statePath = path.join(stateDir, "prompt-state.json");
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("readPromptState", () => {
  it("returns undefined when no state file has ever been written", () => {
    expect(readPromptState(statePath)).toBeUndefined();
  });

  it("returns undefined when the state file is not valid JSON", () => {
    writeFileSync(statePath, "{ not json", "utf8");
    expect(readPromptState(statePath)).toBeUndefined();
  });

  it("returns undefined when the state file's shape does not match — originalConfigPath is required", () => {
    writeFileSync(statePath, JSON.stringify({ updatedAtMs: Date.now() }), "utf8");
    expect(readPromptState(statePath)).toBeUndefined();
  });

  it("reads back exactly what writePromptState wrote, activeSlug included", () => {
    writePromptState({ originalConfigPath: "C:\\Users\\me\\mytheme.omp.json", activeSlug: "lambda", updatedAtMs: 123 }, statePath);

    const state = readPromptState(statePath);
    expect(state?.originalConfigPath).toBe("C:\\Users\\me\\mytheme.omp.json");
    expect(state?.activeSlug).toBe("lambda");
    expect(state?.updatedAtMs).toBe(123);
  });

  it("reads back a state with no activeSlug at all — the 'mine' shape written after ch prompt mine", () => {
    writePromptState({ originalConfigPath: "C:\\Users\\me\\mytheme.omp.json", updatedAtMs: 456 }, statePath);

    const state = readPromptState(statePath);
    expect(state?.activeSlug).toBeUndefined();
  });
});

describe("writePromptState", () => {
  it("creates the state directory when it does not exist yet", () => {
    const nestedStatePath = path.join(stateDir, "nested", "prompt-state.json");

    writePromptState({ originalConfigPath: "/home/me/mytheme.omp.json", activeSlug: "spaceship", updatedAtMs: 789 }, nestedStatePath);

    expect(readPromptState(nestedStatePath)?.activeSlug).toBe("spaceship");
  });

  it("overwrites a previous state file in place — a switch to a new layout replaces the old activeSlug, never appends", () => {
    writePromptState({ originalConfigPath: "/home/me/mytheme.omp.json", activeSlug: "lambda", updatedAtMs: 1 }, statePath);
    writePromptState({ originalConfigPath: "/home/me/mytheme.omp.json", activeSlug: "avit", updatedAtMs: 2 }, statePath);

    const state = readPromptState(statePath);
    expect(state?.activeSlug).toBe("avit");
    expect(JSON.parse(readFileSync(statePath, "utf8")).activeSlug).toBe("avit");
  });
});
