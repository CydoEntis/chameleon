import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readActivePackState, writeActivePackState } from "../src/adapters/state.js";
import { shouldRestoreOriginalSelectionOnExit } from "../src/cli.js";
import {
  applyThemePack,
  currentPack,
  detectPackDrift,
  findFamilySibling,
  loadAllThemePacks,
  nextPackSlug,
  packSlugAtRow,
  previewThemePackToFileTargets,
  prevPackSlug,
  undoAppliedPack,
} from "../src/index.js";

// CHM-19's orchestration only fans a pack's scheme out to whichever real
// adapter each target already ships; the adapters themselves are covered by
// their own test files. Mocking `detect`/`apply`/`read` here is what lets
// these tests exercise "some targets installed, some not, one of them
// throws, one of them has drifted" without ever touching a real
// settings.json, .omp.json or config.toml —
// createWindowsTerminalAdapter()/createOhMyPoshAdapter()/createHerdrAdapter()
// with no arguments resolve to the real, machine-specific config paths, and
// a test must never write to those. Vitest hoists vi.mock above these
// imports regardless of where it appears in the file. Each adapter's own
// "matches the recorded pack" comparison (CHM-27) is mocked too, defaulting
// to "matches" so a test that isn't about drift never has to think about it.
// index.ts's own orchestration calls createDefaultOhMyPoshAdapter, not
// createOhMyPoshAdapter directly — see CHM-25 — so both must resolve to the
// same mock here.
const windowsTerminalAdapter = { detect: vi.fn(), apply: vi.fn(), read: vi.fn(), reload: vi.fn() };
const ohMyPoshAdapter = { detect: vi.fn(), apply: vi.fn(), read: vi.fn(), reload: vi.fn() };
const herdrAdapter = { detect: vi.fn(), apply: vi.fn(), read: vi.fn(), reload: vi.fn() };
const claudeCodeAdapter = { detect: vi.fn(), apply: vi.fn(), read: vi.fn(), reload: vi.fn() };
const undoWindowsTerminalMock = vi.fn();
const undoOhMyPoshMock = vi.fn();
const undoHerdrMock = vi.fn();
const undoClaudeCodeMock = vi.fn();
const windowsTerminalMatchesSchemeMock = vi.fn();
const ohMyPoshMatchesRoleHexesMock = vi.fn();
const herdrMatchesRoleHexesMock = vi.fn();
const claudeCodeMatchesAppearanceMock = vi.fn();

vi.mock("../src/adapters/windows-terminal.js", () => ({
  createWindowsTerminalAdapter: () => windowsTerminalAdapter,
  selectedFontFace: () => undefined,
  undoWindowsTerminal: () => undoWindowsTerminalMock(),
  windowsTerminalMatchesScheme: (...args: unknown[]) => windowsTerminalMatchesSchemeMock(...args),
  WINDOWS_TERMINAL_WINGET_PACKAGE_ID: "Microsoft.WindowsTerminal",
}));
vi.mock("../src/adapters/oh-my-posh.js", () => ({
  createDefaultOhMyPoshAdapter: () => ohMyPoshAdapter,
  createOhMyPoshAdapter: () => ohMyPoshAdapter,
  ohMyPoshMatchesRoleHexes: (...args: unknown[]) => ohMyPoshMatchesRoleHexesMock(...args),
  OH_MY_POSH_WINGET_PACKAGE_ID: "JanDeDobbeleer.OhMyPosh",
  undoOhMyPosh: () => undoOhMyPoshMock(),
}));
vi.mock("../src/adapters/herdr.js", () => ({
  createHerdrAdapter: () => herdrAdapter,
  herdrMatchesRoleHexes: (...args: unknown[]) => herdrMatchesRoleHexesMock(...args),
  undoHerdr: () => undoHerdrMock(),
}));
vi.mock("../src/adapters/claude-code.js", () => ({
  createClaudeCodeAdapter: () => claudeCodeAdapter,
  claudeCodeMatchesAppearance: (...args: unknown[]) => claudeCodeMatchesAppearanceMock(...args),
  undoClaudeCode: () => undoClaudeCodeMock(),
}));

let userThemeDir: string;
let statePath: string;

beforeEach(() => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), "chameleon-pack-commands-"));
  userThemeDir = path.join(scratchDir, "themes"); // never created — bundled packs only, same as test/index.test.ts's empty-directory cases
  statePath = path.join(scratchDir, "active-pack.json");

  windowsTerminalAdapter.detect.mockReset().mockReturnValue(true);
  windowsTerminalAdapter.apply.mockReset();
  windowsTerminalAdapter.read.mockReset();
  windowsTerminalAdapter.reload.mockReset();
  ohMyPoshAdapter.detect.mockReset().mockReturnValue(true);
  ohMyPoshAdapter.apply.mockReset();
  ohMyPoshAdapter.read.mockReset();
  ohMyPoshAdapter.reload.mockReset();
  herdrAdapter.detect.mockReset().mockReturnValue(true);
  herdrAdapter.apply.mockReset();
  herdrAdapter.read.mockReset();
  herdrAdapter.reload.mockReset();
  claudeCodeAdapter.detect.mockReset().mockReturnValue(true);
  claudeCodeAdapter.apply.mockReset();
  claudeCodeAdapter.read.mockReset();
  claudeCodeAdapter.reload.mockReset();
  undoWindowsTerminalMock.mockReset();
  undoOhMyPoshMock.mockReset();
  undoHerdrMock.mockReset();
  undoClaudeCodeMock.mockReset();
  windowsTerminalMatchesSchemeMock.mockReset().mockReturnValue(true);
  ohMyPoshMatchesRoleHexesMock.mockReset().mockReturnValue(true);
  herdrMatchesRoleHexesMock.mockReset().mockReturnValue(true);
  claudeCodeMatchesAppearanceMock.mockReset().mockReturnValue(true);
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
      { target: "claude-code", status: "applied" },
    ]);
    expect(windowsTerminalAdapter.apply).toHaveBeenCalledTimes(1);
    expect(ohMyPoshAdapter.apply).toHaveBeenCalledTimes(1);
    expect(herdrAdapter.apply).toHaveBeenCalledTimes(1);
    expect(claudeCodeAdapter.apply).toHaveBeenCalledTimes(1);
    expect(report.isFullyApplied).toBe(true);
    expect(readActivePackState(statePath)?.slug).toBe("catppuccin-dark");
  });

  // CHM-45: reload() was declared, implemented and wired into every adapter,
  // and called by nothing — the config landed on disk and the running
  // program was never told to re-read it. This is the test that would have
  // caught that: it watches for the call itself, not just the config write.
  it("reloads every applied target after its write lands", () => {
    applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(windowsTerminalAdapter.reload).toHaveBeenCalledTimes(1);
    expect(ohMyPoshAdapter.reload).toHaveBeenCalledTimes(1);
    expect(herdrAdapter.reload).toHaveBeenCalledTimes(1);
    expect(claudeCodeAdapter.reload).toHaveBeenCalledTimes(1);
    // Not just "called" — called after that same target's own write, never before it.
    expect(windowsTerminalAdapter.apply.mock.invocationCallOrder[0]!).toBeLessThan(windowsTerminalAdapter.reload.mock.invocationCallOrder[0]!);
    expect(ohMyPoshAdapter.apply.mock.invocationCallOrder[0]!).toBeLessThan(ohMyPoshAdapter.reload.mock.invocationCallOrder[0]!);
    expect(herdrAdapter.apply.mock.invocationCallOrder[0]!).toBeLessThan(herdrAdapter.reload.mock.invocationCallOrder[0]!);
    expect(claudeCodeAdapter.apply.mock.invocationCallOrder[0]!).toBeLessThan(claudeCodeAdapter.reload.mock.invocationCallOrder[0]!);
  });

  it("skips a target that is not installed, never treating that as a failure — a machine with only Windows Terminal still succeeds", () => {
    ohMyPoshAdapter.detect.mockReturnValue(false);
    herdrAdapter.detect.mockReturnValue(false);

    const report = applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(report.results).toEqual([
      { target: "windows-terminal", status: "applied" },
      { target: "oh-my-posh", status: "skipped", detail: "not installed" },
      { target: "herdr", status: "skipped", detail: "not installed" },
      { target: "claude-code", status: "applied" },
    ]);
    expect(ohMyPoshAdapter.apply).not.toHaveBeenCalled();
    expect(herdrAdapter.apply).not.toHaveBeenCalled();
    // Still a successful apply — Windows Terminal actually changed.
    expect(report.isFullyApplied).toBe(true);
    expect(readActivePackState(statePath)?.slug).toBe("catppuccin-dark");
  });

  // CHM-27: a partial apply must never be recorded as the active pack — the
  // whole bug this ticket exists to fix was `ch prev`/`ch <slug>` recording
  // success, and the state file lying about it, the moment *any* target took
  // the new pack, even with Oh My Posh (say) sitting on POSH_THEME unset.
  it("reports a target's own failure without stopping the targets after it, and never records the pack as active", () => {
    herdrAdapter.apply.mockImplementation(() => {
      throw new Error("no Herdr config found at C:\\fake\\config.toml");
    });

    const report = applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(report.results).toEqual([
      { target: "windows-terminal", status: "applied" },
      { target: "oh-my-posh", status: "applied" },
      { target: "herdr", status: "failed", detail: "no Herdr config found at C:\\fake\\config.toml" },
      { target: "claude-code", status: "applied" },
    ]);
    // windows-terminal and oh-my-posh still ran, and still changed something
    // — a partial apply is never rolled back, only left unrecorded.
    expect(windowsTerminalAdapter.apply).toHaveBeenCalledTimes(1);
    expect(ohMyPoshAdapter.apply).toHaveBeenCalledTimes(1);
    expect(report.isFullyApplied).toBe(false);
    expect(readActivePackState(statePath)).toBeUndefined();
  });

  // CHM-27's own reproduction: `ch prev` then `ch 26` from a shell with no
  // POSH_THEME, Oh My Posh otherwise installed. Windows Terminal and Herdr
  // both took the new pack; Oh My Posh — detected, but with nothing for it
  // to write to — did not. That must fail loudly, not print "applied" and
  // exit 0 with the state file believing it.
  it("fails loudly, rather than reporting success, when Oh My Posh is installed but POSH_THEME is unset", () => {
    ohMyPoshAdapter.apply.mockImplementation(() => {
      throw new Error("POSH_THEME is not set — no active Oh My Posh config to apply to");
    });

    const report = applyThemePack("tokyo-night-light", userThemeDir, statePath);

    expect(report.results).toEqual([
      { target: "windows-terminal", status: "applied" },
      { target: "oh-my-posh", status: "failed", detail: "POSH_THEME is not set — no active Oh My Posh config to apply to" },
      { target: "herdr", status: "applied" },
      { target: "claude-code", status: "applied" },
    ]);
    expect(report.isFullyApplied).toBe(false);
    expect(readActivePackState(statePath)).toBeUndefined();
  });

  // CHM-45: a write that landed but was never reloaded is not actually
  // "applied" from the user's point of view — the target is still showing
  // the old config. A reload failure must downgrade the same way a failed
  // write already does (CHM-27): named per target, and partial overall.
  it("downgrades a target to failed, naming it, when its reload fails after a successful write", () => {
    herdrAdapter.reload.mockImplementation(() => {
      throw new Error("Herdr did not reload: herdr reported \"status\" failed: duplicate key `text`");
    });

    const report = applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(report.results).toEqual([
      { target: "windows-terminal", status: "applied" },
      { target: "oh-my-posh", status: "applied" },
      { target: "herdr", status: "failed", detail: "Herdr did not reload: herdr reported \"status\" failed: duplicate key `text`" },
      { target: "claude-code", status: "applied" },
    ]);
    // The write itself still happened — a reload failure never rolls it back.
    expect(herdrAdapter.apply).toHaveBeenCalledTimes(1);
    expect(report.isFullyApplied).toBe(false);
    expect(readActivePackState(statePath)).toBeUndefined();
  });

  // CHM-45: Herdr not running is not a failure — there is nothing to
  // reload, and the config `apply` just wrote is already correct on disk.
  // This must stay "applied", just with a note, never downgrade to partial.
  it("reports Herdr not running as a note on a successful apply, not a failure", () => {
    herdrAdapter.reload.mockReturnValue("Herdr is not running — nothing to reload");

    const report = applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(report.results).toEqual([
      { target: "windows-terminal", status: "applied" },
      { target: "oh-my-posh", status: "applied" },
      { target: "herdr", status: "applied", detail: "Herdr is not running — nothing to reload" },
      { target: "claude-code", status: "applied" },
    ]);
    expect(report.isFullyApplied).toBe(true);
    expect(readActivePackState(statePath)?.slug).toBe("catppuccin-dark");
  });

  it("leaves a previously recorded pack in place when a later apply only partially succeeds", () => {
    applyThemePack("catppuccin-dark", userThemeDir, statePath);
    herdrAdapter.apply.mockImplementation(() => {
      throw new Error("no Herdr config found at C:\\fake\\config.toml");
    });

    applyThemePack("catppuccin-light", userThemeDir, statePath);

    // The pointer still names the last pack that actually took fully —
    // never the partially-applied one, and never wiped outright.
    expect(readActivePackState(statePath)?.slug).toBe("catppuccin-dark");
  });

  it("does not record a pack as active when every target was skipped", () => {
    windowsTerminalAdapter.detect.mockReturnValue(false);
    ohMyPoshAdapter.detect.mockReturnValue(false);
    herdrAdapter.detect.mockReturnValue(false);
    claudeCodeAdapter.detect.mockReturnValue(false);

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

  it("throws a message naming `chm themes` for a slug that does not exist", () => {
    expect(() => applyThemePack("not-a-real-pack", userThemeDir, statePath)).toThrow(/no pack named "not-a-real-pack".*chm themes/);
  });
});

// CHM-52: the picker's own live preview now applies to Herdr, Oh My Posh and
// Claude Code — the three targets a terminal escape-sequence preview cannot
// reach — without ever touching Windows Terminal (previewed with escape
// codes instead, see cli.ts's buildTerminalPreviewSequence) and without
// recording anything as the active pack. A preview is not a command the
// user issued, and must leave nothing for `chm current`/`chm undo` to
// mistake for one.
describe("previewThemePackToFileTargets", () => {
  it("applies to oh-my-posh, herdr and claude-code, in that target order, but never windows-terminal", () => {
    const results = previewThemePackToFileTargets("catppuccin-dark", userThemeDir);

    expect(results).toEqual([
      { target: "oh-my-posh", status: "applied" },
      { target: "herdr", status: "applied" },
      { target: "claude-code", status: "applied" },
    ]);
    expect(windowsTerminalAdapter.apply).not.toHaveBeenCalled();
    expect(ohMyPoshAdapter.apply).toHaveBeenCalledTimes(1);
    expect(herdrAdapter.apply).toHaveBeenCalledTimes(1);
    expect(claudeCodeAdapter.apply).toHaveBeenCalledTimes(1);
  });

  it("never records the previewed slug as the active pack — chm current and chm undo must never see a preview as a committed choice", () => {
    previewThemePackToFileTargets("catppuccin-dark", userThemeDir);

    expect(readActivePackState(statePath)).toBeUndefined();
  });

  it("leaves a previously recorded active pack exactly as it was, even after previewing a different one", () => {
    applyThemePack("catppuccin-dark", userThemeDir, statePath);

    previewThemePackToFileTargets("catppuccin-light", userThemeDir);

    expect(readActivePackState(statePath)?.slug).toBe("catppuccin-dark");
  });

  it("skips a target that is not installed, never treating that as a failure", () => {
    herdrAdapter.detect.mockReturnValue(false);

    const results = previewThemePackToFileTargets("catppuccin-dark", userThemeDir);

    expect(results).toEqual([
      { target: "oh-my-posh", status: "applied" },
      { target: "herdr", status: "skipped", detail: "not installed" },
      { target: "claude-code", status: "applied" },
    ]);
    expect(herdrAdapter.apply).not.toHaveBeenCalled();
  });

  it("reports one target's own failure without stopping the targets after it", () => {
    herdrAdapter.apply.mockImplementation(() => {
      throw new Error("no Herdr config found at C:\\fake\\config.toml");
    });

    const results = previewThemePackToFileTargets("catppuccin-dark", userThemeDir);

    expect(results).toEqual([
      { target: "oh-my-posh", status: "applied" },
      { target: "herdr", status: "failed", detail: "no Herdr config found at C:\\fake\\config.toml" },
      { target: "claude-code", status: "applied" },
    ]);
  });

  it("throws a message naming `chm themes` for a slug that does not exist", () => {
    expect(() => previewThemePackToFileTargets("not-a-real-pack", userThemeDir)).toThrow(/no pack named "not-a-real-pack".*chm themes/);
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
      { target: "claude-code", status: "restored" },
    ]);
    expect(undoWindowsTerminalMock).toHaveBeenCalledTimes(1);
    expect(undoOhMyPoshMock).toHaveBeenCalledTimes(1);
    expect(undoHerdrMock).not.toHaveBeenCalled();
    expect(undoClaudeCodeMock).toHaveBeenCalledTimes(1);
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
      { target: "claude-code", status: "restored" },
    ]);
  });

  // CHM-45: restoring a backup that is never reloaded leaves the identical
  // gap `ch <theme>` had — the config on disk goes back to what it was, but
  // the running program keeps showing the pack `ch undo` was meant to undo.
  it("reloads every restored target after its backup is restored", () => {
    undoAppliedPack();

    expect(windowsTerminalAdapter.reload).toHaveBeenCalledTimes(1);
    expect(ohMyPoshAdapter.reload).toHaveBeenCalledTimes(1);
    expect(herdrAdapter.reload).toHaveBeenCalledTimes(1);
    expect(claudeCodeAdapter.reload).toHaveBeenCalledTimes(1);
    // Not just "called" — called after that same target's own restore, never before it.
    expect(undoWindowsTerminalMock.mock.invocationCallOrder[0]!).toBeLessThan(windowsTerminalAdapter.reload.mock.invocationCallOrder[0]!);
    expect(undoOhMyPoshMock.mock.invocationCallOrder[0]!).toBeLessThan(ohMyPoshAdapter.reload.mock.invocationCallOrder[0]!);
    expect(undoHerdrMock.mock.invocationCallOrder[0]!).toBeLessThan(herdrAdapter.reload.mock.invocationCallOrder[0]!);
    expect(undoClaudeCodeMock.mock.invocationCallOrder[0]!).toBeLessThan(claudeCodeAdapter.reload.mock.invocationCallOrder[0]!);
  });

  it("downgrades a target to failed, naming it, when its reload fails after a successful restore", () => {
    herdrAdapter.reload.mockImplementation(() => {
      throw new Error("Herdr did not reload: herdr reported \"server_error\"");
    });

    const results = undoAppliedPack();

    expect(results).toEqual([
      { target: "windows-terminal", status: "restored" },
      { target: "oh-my-posh", status: "restored" },
      { target: "herdr", status: "failed", detail: "Herdr did not reload: herdr reported \"server_error\"" },
      { target: "claude-code", status: "restored" },
    ]);
  });

  it("reports Herdr not running as a note on a successful restore, not a failure", () => {
    herdrAdapter.reload.mockReturnValue("Herdr is not running — nothing to reload");

    const results = undoAppliedPack();

    expect(results).toEqual([
      { target: "windows-terminal", status: "restored" },
      { target: "oh-my-posh", status: "restored" },
      { target: "herdr", status: "restored", detail: "Herdr is not running — nothing to reload" },
      { target: "claude-code", status: "restored" },
    ]);
  });
});

// CHM-56's own reproduction: a picker open on solarized-dark previews
// gruvbox-dark (a debounced file-target write, never the state pointer),
// while a second `chm dracula-dark` in another pane applies for real — and
// the picker's own Esc must not silently revert that. shouldRestoreOriginalSelectionOnExit
// is the decision the picker's cancel() consults before restoring anything;
// this proves it against the exact four-step sequence from the ticket,
// through the real applyThemePack/previewThemePackToFileTargets orchestration,
// not a hand-rolled stand-in for it.
describe("CHM-56: the picker must not restore blindly over a real apply made while it was open", () => {
  it("dracula survives: preview does not touch the recorded pack, and Esc leaves a later real apply alone", () => {
    // 1. picker opened — records original = solarized-dark
    applyThemePack("solarized-dark", userThemeDir, statePath);
    const originalSlug = currentPack(userThemeDir, statePath)?.slug;

    // 2. arrowed to gruvbox — debounced preview writes gruvbox into the
    // file-writable targets, never the state pointer.
    previewThemePackToFileTargets("gruvbox-dark", userThemeDir);
    expect(currentPack(userThemeDir, statePath)?.slug).toBe("solarized-dark");

    // 3. `chm dracula-dark` run from a second process — a real, full apply.
    applyThemePack("dracula-dark", userThemeDir, statePath);
    expect(currentPack(userThemeDir, statePath)?.slug).toBe("dracula-dark");

    // 4. picker exits (Esc) — must not restore originalSlug, since the
    // active pack changed since the picker opened.
    expect(shouldRestoreOriginalSelectionOnExit(originalSlug, currentPack(userThemeDir, statePath)?.slug)).toBe(false);

    // Dracula survives: nothing here calls applyThemePack(originalSlug), so
    // solarized-dark never comes back.
    expect(currentPack(userThemeDir, statePath)?.slug).toBe("dracula-dark");
  });

  it("still restores normally when nothing else changed the active pack while the picker was open", () => {
    applyThemePack("solarized-dark", userThemeDir, statePath);
    const originalSlug = currentPack(userThemeDir, statePath)?.slug;

    previewThemePackToFileTargets("gruvbox-dark", userThemeDir);

    // CHM-52's own unchanged path: nobody else applied anything, so Esc's
    // restore is still exactly what it was before this ticket.
    expect(shouldRestoreOriginalSelectionOnExit(originalSlug, currentPack(userThemeDir, statePath)?.slug)).toBe(true);
  });
});

describe("currentPack", () => {
  it("returns undefined when nothing has ever been applied", () => {
    expect(currentPack(userThemeDir, statePath)).toBeUndefined();
  });

  it("reports the applied pack's slug and name immediately after an apply, with no drift", () => {
    applyThemePack("catppuccin-dark", userThemeDir, statePath);

    expect(currentPack(userThemeDir, statePath)).toEqual({ slug: "catppuccin-dark", name: "Catppuccin Mocha", driftedTargets: [] });
  });

  it("still reports the slug when the recorded pack is no longer in the library, with no name and no drift to compare", () => {
    writeActivePackState("a-pack-that-got-deleted", statePath);

    expect(currentPack(userThemeDir, statePath)).toEqual({ slug: "a-pack-that-got-deleted", name: undefined, driftedTargets: [] });
  });

  // CHM-27: this is the reproduction — a partial apply leaves the
  // succeeding targets pointed at the new pack while the recorded pointer
  // (correctly, per applyThemePack) stays on the old one. `ch current` must
  // surface that as drift on the succeeding target, not report a clean slug.
  it("reports drift on a target whose live config no longer matches the recorded pack", () => {
    writeActivePackState("catppuccin-dark", statePath);
    ohMyPoshMatchesRoleHexesMock.mockReturnValue(false);

    expect(currentPack(userThemeDir, statePath)).toEqual({
      slug: "catppuccin-dark",
      name: "Catppuccin Mocha",
      driftedTargets: ["oh-my-posh"],
    });
  });
});

describe("detectPackDrift", () => {
  it("returns nothing when every detected target still matches the pack", () => {
    expect(detectPackDrift("catppuccin-dark", userThemeDir)).toEqual([]);
  });

  it("never reports a target that is not installed as drift, even if it would otherwise disagree", () => {
    herdrAdapter.detect.mockReturnValue(false);
    herdrMatchesRoleHexesMock.mockReturnValue(false);

    expect(detectPackDrift("catppuccin-dark", userThemeDir)).toEqual([]);
  });

  it("reports a detected target whose live config cannot even be read as drifted, rather than skipping it", () => {
    windowsTerminalAdapter.read.mockImplementation(() => {
      throw new Error("no Windows Terminal settings.json found");
    });

    expect(detectPackDrift("catppuccin-dark", userThemeDir)).toEqual(["windows-terminal"]);
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
