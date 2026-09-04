import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readActivePackState, writeActivePackState } from "../src/adapters/state.js";
import {
  applyThemePack,
  currentPack,
  findFamilySibling,
  loadAllThemePacks,
  nextPackSlug,
  packSlugAtRow,
  prevPackSlug,
  undoAppliedPack,
} from "../src/index.js";

// CHM-19's orchestration only fans a pack's scheme out to whichever real
// adapter each target already ships; the adapters themselves are covered by
// their own test files. Mocking `detect`/`apply` here is what lets these
// tests exercise "some targets installed, some not, one of them throws"
// without ever touching a real settings.json, .omp.json or config.toml —
// createWindowsTerminalAdapter()/createOhMyPoshAdapter()/createHerdrAdapter()
// with no arguments resolve to the real, machine-specific config paths, and
// a test must never write to those. Vitest hoists vi.mock above these
// imports regardless of where it appears in the file.
const windowsTerminalAdapter = { detect: vi.fn(), apply: vi.fn() };
const ohMyPoshAdapter = { detect: vi.fn(), apply: vi.fn() };
const herdrAdapter = { detect: vi.fn(), apply: vi.fn() };
const undoWindowsTerminalMock = vi.fn();
const undoOhMyPoshMock = vi.fn();
const undoHerdrMock = vi.fn();

vi.mock("../src/adapters/windows-terminal.js", () => ({
  createWindowsTerminalAdapter: () => windowsTerminalAdapter,
  selectedFontFace: () => undefined,
  undoWindowsTerminal: () => undoWindowsTerminalMock(),
  WINDOWS_TERMINAL_WINGET_PACKAGE_ID: "Microsoft.WindowsTerminal",
}));
vi.mock("../src/adapters/oh-my-posh.js", () => ({
  createOhMyPoshAdapter: () => ohMyPoshAdapter,
  OH_MY_POSH_WINGET_PACKAGE_ID: "JanDeDobbeleer.OhMyPosh",
  undoOhMyPosh: () => undoOhMyPoshMock(),
}));
vi.mock("../src/adapters/herdr.js", () => ({
  createHerdrAdapter: () => herdrAdapter,
  undoHerdr: () => undoHerdrMock(),
}));

let userThemeDir: string;
let statePath: string;

beforeEach(() => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), "chameleon-pack-commands-"));
  userThemeDir = path.join(scratchDir, "themes"); // never created — bundled packs only, same as test/index.test.ts's empty-directory cases
  statePath = path.join(scratchDir, "active-pack.json");

  windowsTerminalAdapter.detect.mockReset().mockReturnValue(true);
  windowsTerminalAdapter.apply.mockReset();
  ohMyPoshAdapter.detect.mockReset().mockReturnValue(true);
  ohMyPoshAdapter.apply.mockReset();
  herdrAdapter.detect.mockReset().mockReturnValue(true);
  herdrAdapter.apply.mockReset();
  undoWindowsTerminalMock.mockReset();
  undoOhMyPoshMock.mockReset();
  undoHerdrMock.mockReset();
});

afterEach(() => {
  rmSync(path.dirname(statePath), { recursive: true, force: true });
});

describe("applyThemePack", () => {
  it("applies to every detected target and records the pack as active", () => {
    const report = applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(report.results).toEqual([
      { target: "windows-terminal", status: "applied" },
      { target: "oh-my-posh", status: "applied" },
      { target: "herdr", status: "applied" },
    ]);
    expect(windowsTerminalAdapter.apply).toHaveBeenCalledTimes(1);
    expect(ohMyPoshAdapter.apply).toHaveBeenCalledTimes(1);
    expect(herdrAdapter.apply).toHaveBeenCalledTimes(1);
    expect(readActivePackState(statePath)?.slug).toBe("catppuccin-dark");
  });

  it("skips a target that is not installed, never treating that as a failure — a machine with only Windows Terminal still succeeds", () => {
    ohMyPoshAdapter.detect.mockReturnValue(false);
    herdrAdapter.detect.mockReturnValue(false);

    const report = applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(report.results).toEqual([
      { target: "windows-terminal", status: "applied" },
      { target: "oh-my-posh", status: "skipped", detail: "not installed" },
      { target: "herdr", status: "skipped", detail: "not installed" },
    ]);
    expect(ohMyPoshAdapter.apply).not.toHaveBeenCalled();
    expect(herdrAdapter.apply).not.toHaveBeenCalled();
    // Still a successful apply — Windows Terminal actually changed.
    expect(readActivePackState(statePath)?.slug).toBe("catppuccin-dark");
  });

  it("reports a target's own failure without stopping the targets after it", () => {
    herdrAdapter.apply.mockImplementation(() => {
      throw new Error("no Herdr config found at C:\\fake\\config.toml");
    });

    const report = applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(report.results).toEqual([
      { target: "windows-terminal", status: "applied" },
      { target: "oh-my-posh", status: "applied" },
      { target: "herdr", status: "failed", detail: "no Herdr config found at C:\\fake\\config.toml" },
    ]);
    // windows-terminal and oh-my-posh still ran, and still changed something.
    expect(windowsTerminalAdapter.apply).toHaveBeenCalledTimes(1);
    expect(ohMyPoshAdapter.apply).toHaveBeenCalledTimes(1);
    expect(readActivePackState(statePath)?.slug).toBe("catppuccin-dark");
  });

  it("does not record a pack as active when every target was skipped", () => {
    windowsTerminalAdapter.detect.mockReturnValue(false);
    ohMyPoshAdapter.detect.mockReturnValue(false);
    herdrAdapter.detect.mockReturnValue(false);

    applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(readActivePackState(statePath)).toBeUndefined();
  });

  it("applying the same pack twice calls each installed target's apply twice with the identical scheme — the idempotency every adapter's own marker-scoped write already guarantees", () => {
    applyThemePack("catppuccin-dark", userThemeDir, statePath);
    applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(windowsTerminalAdapter.apply).toHaveBeenCalledTimes(2);
    const [firstCallScheme] = windowsTerminalAdapter.apply.mock.calls[0]!;
    const [secondCallScheme] = windowsTerminalAdapter.apply.mock.calls[1]!;
    expect(secondCallScheme).toEqual(firstCallScheme);
  });

  it("throws a message naming `ch list` for a slug that does not exist", () => {
    expect(() => applyThemePack("not-a-real-pack", userThemeDir, statePath)).toThrow(/no pack named "not-a-real-pack".*ch list/);
  });
});

describe("undoAppliedPack", () => {
  it("restores every detected target and skips one that is not installed", () => {
    herdrAdapter.detect.mockReturnValue(false);

    const results = undoAppliedPack();

    expect(results).toEqual([
      { target: "windows-terminal", status: "restored" },
      { target: "oh-my-posh", status: "restored" },
      { target: "herdr", status: "skipped", detail: "not installed" },
    ]);
    expect(undoWindowsTerminalMock).toHaveBeenCalledTimes(1);
    expect(undoOhMyPoshMock).toHaveBeenCalledTimes(1);
    expect(undoHerdrMock).not.toHaveBeenCalled();
  });

  it("reports one target's undo failure without stopping the others", () => {
    undoOhMyPoshMock.mockImplementation(() => {
      throw new Error("no backup found — nothing to undo");
    });

    const results = undoAppliedPack();

    expect(results).toEqual([
      { target: "windows-terminal", status: "restored" },
      { target: "oh-my-posh", status: "failed", detail: "no backup found — nothing to undo" },
      { target: "herdr", status: "restored" },
    ]);
  });
});

describe("currentPack", () => {
  it("returns undefined when nothing has ever been applied", () => {
    expect(currentPack(userThemeDir, statePath)).toBeUndefined();
  });

  it("reports the applied pack's slug and name immediately after an apply", () => {
    applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(currentPack(userThemeDir, statePath)).toEqual({ slug: "catppuccin-dark", name: "Catppuccin Mocha" });
  });

  it("still reports the slug when the recorded pack is no longer in the library, with no name", () => {
    writeActivePackState("a-pack-that-got-deleted", statePath);

    expect(currentPack(userThemeDir, statePath)).toEqual({ slug: "a-pack-that-got-deleted", name: undefined });
  });
});

describe("nextPackSlug", () => {
  it("advances to the pack after the active one in `ch list` order", () => {
    writeActivePackState("catppuccin-dark", statePath);

    const nextSlug = nextPackSlug(userThemeDir, statePath);

    expect(nextSlug).not.toBe("catppuccin-dark");
    expect(typeof nextSlug).toBe("string");
  });

  it("wraps from the last pack in the list back to the first", () => {
    const { packs } = loadAllThemePacks(userThemeDir);
    const lastSlug = packs[packs.length - 1]!.pack.manifest.slug;
    const firstSlug = packs[0]!.pack.manifest.slug;
    writeActivePackState(lastSlug, statePath);

    expect(nextPackSlug(userThemeDir, statePath)).toBe(firstSlug);
  });

  it("starts at the first pack in the list when nothing has been applied yet", () => {
    const { packs } = loadAllThemePacks(userThemeDir);

    expect(nextPackSlug(userThemeDir, statePath)).toBe(packs[0]!.pack.manifest.slug);
  });
});

describe("prevPackSlug", () => {
  it("retreats to the pack before the active one in `ch list` order", () => {
    const { packs } = loadAllThemePacks(userThemeDir);
    writeActivePackState(packs[1]!.pack.manifest.slug, statePath);

    expect(prevPackSlug(userThemeDir, statePath)).toBe(packs[0]!.pack.manifest.slug);
  });

  it("wraps from the first pack in the list back to the last", () => {
    const { packs } = loadAllThemePacks(userThemeDir);
    const firstSlug = packs[0]!.pack.manifest.slug;
    const lastSlug = packs[packs.length - 1]!.pack.manifest.slug;
    writeActivePackState(firstSlug, statePath);

    expect(prevPackSlug(userThemeDir, statePath)).toBe(lastSlug);
  });

  it("starts at the last pack in the list when nothing has been applied yet — the mirror of nextPackSlug's first-pack default", () => {
    const { packs } = loadAllThemePacks(userThemeDir);

    expect(prevPackSlug(userThemeDir, statePath)).toBe(packs[packs.length - 1]!.pack.manifest.slug);
  });
});

describe("packSlugAtRow", () => {
  it("returns the slug at the same row `ch list` would print it on", () => {
    const { packs } = loadAllThemePacks(userThemeDir);

    expect(packSlugAtRow(1, userThemeDir)).toBe(packs[0]!.pack.manifest.slug);
    expect(packSlugAtRow(packs.length, userThemeDir)).toBe(packs[packs.length - 1]!.pack.manifest.slug);
  });

  it("returns undefined for a row that does not exist, rather than the nearest one", () => {
    const { packs } = loadAllThemePacks(userThemeDir);

    expect(packSlugAtRow(0, userThemeDir)).toBeUndefined();
    expect(packSlugAtRow(packs.length + 1, userThemeDir)).toBeUndefined();
  });
});

describe("findFamilySibling", () => {
  it("finds the active pack's sibling in the requested appearance, within the same family", () => {
    writeActivePackState("catppuccin-dark", statePath);

    const result = findFamilySibling("light", userThemeDir, statePath);

    expect(result).toEqual({ family: "Catppuccin", siblingSlug: "catppuccin-light", nearestAlternativeSlug: undefined });
  });

  it("names the nearest alternative, rather than failing silently, for a family with no sibling in that mode", () => {
    writeActivePackState("monokai-dark", statePath); // Monokai ships dark only — see themes/monokai-dark.json

    const result = findFamilySibling("light", userThemeDir, statePath);

    expect(result.family).toBe("Monokai");
    expect(result.siblingSlug).toBeUndefined();
    expect(result.nearestAlternativeSlug).toBeDefined();
    expect(result.nearestAlternativeSlug).not.toBe("monokai-dark");
  });

  it("throws when nothing has been applied yet — there is no active pack to find a sibling of", () => {
    expect(() => findFamilySibling("dark", userThemeDir, statePath)).toThrow(/no pack has been applied yet/);
  });
});
