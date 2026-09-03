import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateNerdFontStatus,
  installNerdFont,
  isNerdFontFamilyName,
  NERD_FONT_INSTALL_ARGS,
  OH_MY_POSH_BINARY_NAME,
  parseFontFamilyNamesFromRegQueryOutput,
} from "../../src/adapters/nerd-font.js";

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

describe("isNerdFontFamilyName", () => {
  it("recognises a fully-named Nerd Font build", () => {
    expect(isNerdFontFamilyName("CaskaydiaCove Nerd Font")).toBe(true);
    expect(isNerdFontFamilyName("FiraCode Nerd Font Mono")).toBe(true);
  });

  it("recognises the older nerd-fonts naming Oh My Posh's own docs recommend", () => {
    expect(isNerdFontFamilyName("MesloLGS NF")).toBe(true);
  });

  it("does not mistake an ordinary font for one — Cascadia Mono is not a Nerd Font just because it ships with Windows Terminal", () => {
    expect(isNerdFontFamilyName("Cascadia Mono")).toBe(false);
    expect(isNerdFontFamilyName("Consolas")).toBe(false);
    expect(isNerdFontFamilyName("Segoe UI")).toBe(false);
  });

  it("does not match a family name that merely contains the letters 'nf' as part of a word", () => {
    expect(isNerdFontFamilyName("Infinity Sans")).toBe(false);
  });
});

describe("parseFontFamilyNamesFromRegQueryOutput", () => {
  // A real `reg query` shape: a header line, then one indented value line per font.
  const REAL_SHAPED_OUTPUT = [
    "",
    "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
    "    MesloLGS NF (TrueType)    REG_SZ    MesloLGSNFRegular.ttf",
    "    Segoe UI (TrueType)    REG_SZ    segoeui.ttf",
    "    CaskaydiaCove Nerd Font (OpenType)    REG_SZ    CaskaydiaCoveNerdFont-Regular.otf",
    "",
  ].join("\r\n");

  it("extracts every family name, stripping the (TrueType)/(OpenType) suffix reg query appends", () => {
    expect(parseFontFamilyNamesFromRegQueryOutput(REAL_SHAPED_OUTPUT)).toEqual([
      "MesloLGS NF",
      "Segoe UI",
      "CaskaydiaCove Nerd Font",
    ]);
  });

  it("returns nothing for a key with no font values — a fresh machine, not a parse failure", () => {
    expect(parseFontFamilyNamesFromRegQueryOutput("\r\nHKEY_CURRENT_USER\\...\\Fonts\r\n\r\n")).toEqual([]);
  });
});

describe("evaluateNerdFontStatus", () => {
  it("reports not installed when nothing on the machine looks like a Nerd Font", () => {
    const status = evaluateNerdFontStatus(["Segoe UI", "Consolas"], undefined);
    expect(status.isInstalled).toBe(false);
    expect(status.isSelected).toBe(false);
    expect(status.installedNerdFontFamilyNames).toEqual([]);
  });

  it("reports installed but not selected — the bug this ticket exists to catch — when a Nerd Font is on the machine but a different font is the one Windows Terminal actually uses", () => {
    const status = evaluateNerdFontStatus(["MesloLGS NF", "Segoe UI"], "Cascadia Mono");
    expect(status.isInstalled).toBe(true);
    expect(status.isSelected).toBe(false);
    expect(status.selectedFontFace).toBe("Cascadia Mono");
    expect(status.installedNerdFontFamilyNames).toEqual(["MesloLGS NF"]);
  });

  it("reports installed and selected only when the selected face itself is a Nerd Font — checking installed alone is the bug", () => {
    const status = evaluateNerdFontStatus(["MesloLGS NF"], "MesloLGS NF");
    expect(status.isInstalled).toBe(true);
    expect(status.isSelected).toBe(true);
  });

  it("reports not selected when nothing has ever been set, even if a Nerd Font is installed", () => {
    const status = evaluateNerdFontStatus(["MesloLGS NF"], undefined);
    expect(status.isSelected).toBe(false);
  });
});

describe("installNerdFont", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("delegates to Oh My Posh's own headless font installer, never a hand-rolled patcher", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult());

    installNerdFont();

    expect(spawnSync).toHaveBeenCalledWith(OH_MY_POSH_BINARY_NAME, [...NERD_FONT_INSTALL_ARGS], expect.objectContaining({ stdio: "inherit" }));
  });

  it("throws naming the command when the binary cannot be started", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult({ error: new Error("ENOENT"), status: null }));
    expect(() => installNerdFont()).toThrow(/ENOENT/);
  });

  it("throws when the installer runs but exits non-zero", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult({ status: 1 }));
    expect(() => installNerdFont()).toThrow(/status 1/);
  });

  it("succeeds silently on a zero exit", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult({ status: 0 }));
    expect(() => installNerdFont()).not.toThrow();
  });
});
