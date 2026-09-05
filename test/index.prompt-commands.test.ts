import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeActivePackState } from "../src/adapters/state.js";
import { loadCuratedThemePacks } from "../src/palette/theme-pack-library.js";

// CHM-47's own orchestration (applyPromptPack/restorePromptToMine/
// currentPromptPack) never touches a real profile, pointer or bundled-prompt
// file directly — it delegates every bit of that to adapters/oh-my-posh.js,
// which is mocked here the same way test/index.pack-commands.test.ts mocks
// it for applyThemePack: real file I/O is that module's own, already-tested
// concern (see test/adapters/oh-my-posh-prompt-layout.test.ts), not this
// orchestration layer's. Windows Terminal and the Nerd Font detector are
// mocked too, so listPromptPacks' own Nerd Font flag is deterministic rather
// than depending on this machine's real fonts and settings.json.
const ohMyPoshAdapter = { detect: vi.fn(), apply: vi.fn(), read: vi.fn(), reload: vi.fn() };
const applyPromptLayoutForCurrentShellMock = vi.fn();
const currentPromptTrackingConfigPathMock = vi.fn();
const restoreOriginalPromptMock = vi.fn();

vi.mock("../src/adapters/oh-my-posh.js", () => ({
  createDefaultOhMyPoshAdapter: () => ohMyPoshAdapter,
  createOhMyPoshAdapter: () => ohMyPoshAdapter,
  ohMyPoshMatchesRoleHexes: () => true,
  OH_MY_POSH_WINGET_PACKAGE_ID: "JanDeDobbeleer.OhMyPosh",
  undoOhMyPosh: vi.fn(),
  applyPromptLayoutForCurrentShell: (...args: unknown[]) => applyPromptLayoutForCurrentShellMock(...args),
  currentPromptTrackingConfigPath: (...args: unknown[]) => currentPromptTrackingConfigPathMock(...args),
  restoreOriginalPrompt: (...args: unknown[]) => restoreOriginalPromptMock(...args),
}));
vi.mock("../src/adapters/windows-terminal.js", () => ({
  createWindowsTerminalAdapter: () => ({ detect: () => false, read: vi.fn(), apply: vi.fn(), reload: vi.fn() }),
  selectedFontFace: () => undefined,
  undoWindowsTerminal: vi.fn(),
  windowsTerminalMatchesScheme: () => true,
  WINDOWS_TERMINAL_WINGET_PACKAGE_ID: "Microsoft.WindowsTerminal",
}));
vi.mock("../src/adapters/fonts.js", () => ({
  detectNerdFontInstalled: () => false,
  isNerdFontFamilyName: (name: string) => /nerd font|\bnf[mp]?$/i.test(name),
  nerdFontInstallCommand: () => "oh-my-posh font install CascadiaCode",
}));

// Imported after the mocks above, matching pack-commands.test.ts's own
// ordering note: vitest hoists vi.mock regardless, but this keeps the file
// readable in the order it actually executes.
const {
  applyPromptPack,
  currentPromptPack,
  listPromptPacks,
  restorePromptToMine,
} = await import("../src/index.js");

let scratchDir: string;
let userThemeDir: string;
let statePath: string;
let promptStatePath: string;

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(tmpdir(), "chameleon-prompt-commands-"));
  userThemeDir = path.join(scratchDir, "themes"); // never created — bundled theme packs only
  statePath = path.join(scratchDir, "active-pack.json");
  promptStatePath = path.join(scratchDir, "prompt-state.json");

  ohMyPoshAdapter.detect.mockReset().mockReturnValue(true);
  applyPromptLayoutForCurrentShellMock.mockReset().mockReturnValue(undefined);
  currentPromptTrackingConfigPathMock.mockReset().mockReturnValue("C:\\Users\\me\\my-real-prompt.omp.json");
  restoreOriginalPromptMock.mockReset();

  // A theme must already be applied — a bundled layout is authored purely
  // against Chameleon's roles and has no colour of its own to fall back to.
  const [firstThemePack] = loadCuratedThemePacks();
  writeActivePackState(firstThemePack!.manifest.slug, statePath);
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("applyPromptPack", () => {
  it("explains rather than failing obscurely when Oh My Posh is not installed", () => {
    ohMyPoshAdapter.detect.mockReturnValue(false);
    expect(() => applyPromptPack("lambda", promptStatePath, userThemeDir, statePath)).toThrow(/Oh My Posh is not installed/);
  });

  it("throws naming a name a person can act on for an unknown layout", () => {
    expect(() => applyPromptPack("not-a-real-layout", promptStatePath, userThemeDir, statePath)).toThrow(/no prompt layout named/);
  });

  it("resolves the layout's own p:<role> references before handing it to the adapter — no reference survives", () => {
    applyPromptPack("lambda", promptStatePath, userThemeDir, statePath);

    expect(applyPromptLayoutForCurrentShellMock).toHaveBeenCalledTimes(1);
    const [resolvedConfig] = applyPromptLayoutForCurrentShellMock.mock.calls[0]!;
    expect(JSON.stringify(resolvedConfig)).not.toContain("p:");
  });

  it("records the currently active config as 'original' on the very first switch", () => {
    applyPromptPack("lambda", promptStatePath, userThemeDir, statePath);

    expect(currentPromptTrackingConfigPathMock).toHaveBeenCalledTimes(1);
    expect(currentPromptPack(promptStatePath)?.slug).toBe("lambda");
  });

  it("carries the same 'original' config path forward across several switches, never re-recording it", () => {
    applyPromptPack("lambda", promptStatePath, userThemeDir, statePath);
    applyPromptPack("spaceship", promptStatePath, userThemeDir, statePath);
    applyPromptPack("avit", promptStatePath, userThemeDir, statePath);

    // Only the very first switch has nothing recorded yet to read back —
    // every switch after that reuses it instead of asking again.
    expect(currentPromptTrackingConfigPathMock).toHaveBeenCalledTimes(1);
    expect(currentPromptPack(promptStatePath)?.slug).toBe("avit");
  });

  it("flags, but does not block, a layout that needs a Nerd Font when none is selected", () => {
    const result = applyPromptPack("lambda", promptStatePath, userThemeDir, statePath);
    expect(result.nerdFontWarning).toMatch(/Nerd Font/);
    expect(applyPromptLayoutForCurrentShellMock).toHaveBeenCalledTimes(1);
  });

  it("never warns for a layout that renders with no Nerd Font at all", () => {
    const result = applyPromptPack("half-life", promptStatePath, userThemeDir, statePath);
    expect(result.nerdFontWarning).toBeUndefined();
  });
});

describe("restorePromptToMine", () => {
  it("throws when no bundled layout has ever been applied", () => {
    expect(() => restorePromptToMine(promptStatePath)).toThrow(/no bundled prompt layout has ever been applied/);
  });

  it("repoints at the recorded original path, and clears the active slug so ch current reports 'mine'", () => {
    applyPromptPack("lambda", promptStatePath, userThemeDir, statePath);

    restorePromptToMine(promptStatePath);

    expect(restoreOriginalPromptMock).toHaveBeenCalledWith("C:\\Users\\me\\my-real-prompt.omp.json");
    expect(currentPromptPack(promptStatePath)).toEqual({ slug: undefined, name: undefined });
  });

  it("still finds its way back to the very first original path after several switches — not only the first", () => {
    applyPromptPack("lambda", promptStatePath, userThemeDir, statePath);
    applyPromptPack("spaceship", promptStatePath, userThemeDir, statePath);
    applyPromptPack("avit", promptStatePath, userThemeDir, statePath);

    restorePromptToMine(promptStatePath);

    expect(restoreOriginalPromptMock).toHaveBeenCalledWith("C:\\Users\\me\\my-real-prompt.omp.json");
  });
});

describe("currentPromptPack", () => {
  it("returns undefined when no bundled layout has ever been applied", () => {
    expect(currentPromptPack(promptStatePath)).toBeUndefined();
  });

  it("names the active bundled layout after a switch", () => {
    applyPromptPack("spaceship", promptStatePath, userThemeDir, statePath);
    expect(currentPromptPack(promptStatePath)).toEqual({ slug: "spaceship", name: "Spaceship" });
  });
});

describe("listPromptPacks", () => {
  it("lists every bundled layout, flagging (never hiding) the ones that need a Nerd Font when none is selected", () => {
    const entries = listPromptPacks();
    const lambda = entries.find((entry) => entry.slug === "lambda");
    const halfLife = entries.find((entry) => entry.slug === "half-life");

    expect(lambda?.requiresNerdFont).toBe(true);
    expect(lambda?.nerdFontWarning).toBe(true);
    expect(halfLife?.requiresNerdFont).toBe(false);
    expect(halfLife?.nerdFontWarning).toBe(false);
  });
});
