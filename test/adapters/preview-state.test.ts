import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPreviewState, readPreviewState, writePreviewState } from "../../src/adapters/preview-state.js";

let stateDir: string;
let previewStatePath: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-preview-state-"));
  previewStatePath = path.join(stateDir, "preview-in-flight.json");
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("readPreviewState", () => {
  it("returns undefined when no preview marker has ever been written", () => {
    expect(readPreviewState(previewStatePath)).toBeUndefined();
  });

  it("returns undefined when the marker is not valid JSON", () => {
    writeFileSync(previewStatePath, "{ not json", "utf8");
    expect(readPreviewState(previewStatePath)).toBeUndefined();
  });

  it("returns undefined when the marker's shape does not match — updatedAtMs is required", () => {
    writeFileSync(previewStatePath, JSON.stringify({ originalSlug: "catppuccin-dark" }), "utf8");
    expect(readPreviewState(previewStatePath)).toBeUndefined();
  });

  it("reads back exactly what writePreviewState wrote, originalSlug included", () => {
    writePreviewState("catppuccin-dark", previewStatePath);

    const state = readPreviewState(previewStatePath);
    expect(state?.originalSlug).toBe("catppuccin-dark");
    expect(typeof state?.updatedAtMs).toBe("number");
  });

  it("reads back a marker with no originalSlug — nothing had been applied before the preview started", () => {
    writePreviewState(undefined, previewStatePath);

    const state = readPreviewState(previewStatePath);
    expect(state?.originalSlug).toBeUndefined();
    expect(typeof state?.updatedAtMs).toBe("number");
  });
});

describe("writePreviewState", () => {
  it("creates the state directory when it does not exist yet", () => {
    const nestedPreviewStatePath = path.join(stateDir, "nested", "preview-in-flight.json");

    writePreviewState("dracula-dark", nestedPreviewStatePath);

    expect(readPreviewState(nestedPreviewStatePath)?.originalSlug).toBe("dracula-dark");
  });

  it("replaces an earlier marker on a second write rather than appending", () => {
    writePreviewState("catppuccin-dark", previewStatePath);
    writePreviewState("dracula-dark", previewStatePath);

    expect(readPreviewState(previewStatePath)?.originalSlug).toBe("dracula-dark");
    // Exactly one JSON object on disk, not two concatenated.
    expect(() => JSON.parse(readFileSync(previewStatePath, "utf8"))).not.toThrow();
  });
});

describe("clearPreviewState", () => {
  it("removes an existing marker", () => {
    writePreviewState("catppuccin-dark", previewStatePath);

    clearPreviewState(previewStatePath);

    expect(readPreviewState(previewStatePath)).toBeUndefined();
  });

  it("is a no-op when no marker exists — every real apply/undo calls this unconditionally", () => {
    expect(() => clearPreviewState(previewStatePath)).not.toThrow();
  });
});
