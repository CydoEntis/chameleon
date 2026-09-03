import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectNerdFontInstalled, nerdFontInstallCommand } from "../../src/adapters/fonts.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

function makeSpawnResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    pid: 1234,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

// A trimmed but real shape of `reg query`'s own output for the fonts key —
// one plain font and one Nerd Font-patched one, the case doctor exists to
// tell apart.
const REG_QUERY_OUTPUT_WITH_NERD_FONT = [
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
  "    Cascadia Mono (TrueType)    REG_SZ    CascadiaMono.ttf",
  "    CaskaydiaCove NF (TrueType)    REG_SZ    CaskaydiaCoveNerdFont-Regular.ttf",
  "",
].join("\r\n");

const REG_QUERY_OUTPUT_WITHOUT_NERD_FONT = [
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
  "    Cascadia Mono (TrueType)    REG_SZ    CascadiaMono.ttf",
  "    Segoe UI (TrueType)    REG_SZ    segoeui.ttf",
  "",
].join("\r\n");

describe("detectNerdFontInstalled", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("is true when a font family registered in the current user's fonts key reads as a Nerd Font", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult({ stdout: REG_QUERY_OUTPUT_WITH_NERD_FONT }));
    expect(detectNerdFontInstalled()).toBe(true);
  });

  it("is false when every installed family is a plain, unpatched font", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult({ stdout: REG_QUERY_OUTPUT_WITHOUT_NERD_FONT }));
    expect(detectNerdFontInstalled()).toBe(false);
  });

  it("is false, never thrown, when the registry query itself fails — a doctor run must continue past this", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult({ error: new Error("ENOENT"), status: null }));
    expect(detectNerdFontInstalled()).toBe(false);
  });

  it("is false when the key exists but is empty", () => {
    vi.mocked(spawnSync).mockReturnValue(
      makeSpawnResult({ stdout: "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts\r\n\r\n" }),
    );
    expect(detectNerdFontInstalled()).toBe(false);
  });
});

describe("nerdFontInstallCommand", () => {
  it("delegates to oh-my-posh's own font installer rather than reimplementing one", () => {
    expect(nerdFontInstallCommand()).toBe("oh-my-posh font install CascadiaCode");
  });

  it("installs the named font when one is given", () => {
    expect(nerdFontInstallCommand("Meslo")).toBe("oh-my-posh font install Meslo");
  });
});
