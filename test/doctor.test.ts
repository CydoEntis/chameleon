import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHerdrAdapter } from "../src/adapters/herdr.js";
import { createOhMyPoshAdapter } from "../src/adapters/oh-my-posh.js";
import { createWindowsTerminalAdapter } from "../src/adapters/windows-terminal.js";
import { buildDoctorReport, describeDoctorActions } from "../src/doctor.js";

// A minimal but real settings.json — just enough for detect() and read() to
// succeed. Hostile-fixture coverage for the shape itself already lives in
// windows-terminal.test.ts; this file only needs the doctor-level wiring.
const MINIMAL_WINDOWS_TERMINAL_SETTINGS = JSON.stringify({
  profiles: { defaults: { fontFace: "Cascadia Mono" } },
  schemes: [],
});

describe("buildDoctorReport", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-doctor-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reports every target missing, accurately, on a machine with none of them", () => {
    const missingPath = (name: string) => path.join(stateDir, name);
    const report = buildDoctorReport(
      createWindowsTerminalAdapter(missingPath("settings.json")),
      createOhMyPoshAdapter(missingPath("theme.omp.json"), missingPath("profile.ps1"), missingPath("pointer.json")),
      createHerdrAdapter(missingPath("config.toml")),
      () => [],
    );

    expect(report.targets).toEqual([
      { target: "windows-terminal", isInstalled: false },
      { target: "oh-my-posh", isInstalled: false },
      { target: "herdr", isInstalled: false },
    ]);
    expect(report.nerdFont.isInstalled).toBe(false);
  });

  it("reports every target installed, accurately, when every config file is present", () => {
    const settingsPath = path.join(stateDir, "settings.json");
    const ohMyPoshConfigPath = path.join(stateDir, "theme.omp.json");
    const herdrConfigPath = path.join(stateDir, "config.toml");
    writeFileSync(settingsPath, MINIMAL_WINDOWS_TERMINAL_SETTINGS, "utf8");
    writeFileSync(ohMyPoshConfigPath, JSON.stringify({ blocks: [] }), "utf8");
    writeFileSync(herdrConfigPath, '[theme]\nname = "builtin"\n', "utf8");

    const report = buildDoctorReport(
      createWindowsTerminalAdapter(settingsPath),
      createOhMyPoshAdapter(ohMyPoshConfigPath, path.join(stateDir, "profile.ps1"), path.join(stateDir, "pointer.json")),
      createHerdrAdapter(herdrConfigPath),
      () => ["MesloLGS NF"],
    );

    expect(report.targets.every((status) => status.isInstalled)).toBe(true);
  });

  it("catches a Nerd Font that is installed but not the one Windows Terminal has selected", () => {
    const settingsPath = path.join(stateDir, "settings.json");
    writeFileSync(settingsPath, MINIMAL_WINDOWS_TERMINAL_SETTINGS, "utf8"); // fontFace: "Cascadia Mono"

    const report = buildDoctorReport(
      createWindowsTerminalAdapter(settingsPath),
      createOhMyPoshAdapter(path.join(stateDir, "missing.omp.json")),
      createHerdrAdapter(path.join(stateDir, "missing.toml")),
      () => ["MesloLGS NF"],
    );

    expect(report.nerdFont.isInstalled).toBe(true);
    expect(report.nerdFont.isSelected).toBe(false);
    expect(report.nerdFont.selectedFontFace).toBe("Cascadia Mono");
  });

  it("never throws when settings.json exists but is shaped wrong — reports the font as unselected rather than crashing the whole report", () => {
    const settingsPath = path.join(stateDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ profiles: "not an object" }), "utf8");

    const report = buildDoctorReport(
      createWindowsTerminalAdapter(settingsPath),
      createOhMyPoshAdapter(path.join(stateDir, "missing.omp.json")),
      createHerdrAdapter(path.join(stateDir, "missing.toml")),
      () => ["MesloLGS NF"],
    );

    expect(report.targets[0]).toEqual({ target: "windows-terminal", isInstalled: true });
    expect(report.nerdFont.selectedFontFace).toBeUndefined();
    expect(report.nerdFont.isSelected).toBe(false);
  });

  it("never throws when Windows Terminal itself is missing — nothing to read a fontFace out of", () => {
    const report = buildDoctorReport(
      createWindowsTerminalAdapter(path.join(stateDir, "missing.json")),
      createOhMyPoshAdapter(path.join(stateDir, "missing.omp.json")),
      createHerdrAdapter(path.join(stateDir, "missing.toml")),
      () => ["MesloLGS NF"],
    );

    expect(report.nerdFont.selectedFontFace).toBeUndefined();
    expect(report.nerdFont.isSelected).toBe(false);
  });
});

describe("describeDoctorActions", () => {
  it("offers to install Oh My Posh when it is missing", () => {
    const actions = describeDoctorActions({
      targets: [
        { target: "windows-terminal", isInstalled: true },
        { target: "oh-my-posh", isInstalled: false },
        { target: "herdr", isInstalled: true },
      ],
      nerdFont: { installedNerdFontFamilyNames: ["MesloLGS NF"], isInstalled: true, selectedFontFace: "MesloLGS NF", isSelected: true },
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("install-oh-my-posh");
    expect(actions[0]?.commandLine).toBe("winget install JanDeDobbeleer.OhMyPosh");
  });

  it("never offers to install Herdr — detect only, per CLAUDE.md's out-of-scope", () => {
    const actions = describeDoctorActions({
      targets: [
        { target: "windows-terminal", isInstalled: true },
        { target: "oh-my-posh", isInstalled: true },
        { target: "herdr", isInstalled: false },
      ],
      nerdFont: { installedNerdFontFamilyNames: ["MesloLGS NF"], isInstalled: true, selectedFontFace: "MesloLGS NF", isSelected: true },
    });

    expect(actions.some((action) => action.description.toLowerCase().includes("herdr"))).toBe(false);
  });

  it("offers to install a Nerd Font when none is on the machine", () => {
    const actions = describeDoctorActions({
      targets: [
        { target: "windows-terminal", isInstalled: true },
        { target: "oh-my-posh", isInstalled: true },
        { target: "herdr", isInstalled: true },
      ],
      nerdFont: { installedNerdFontFamilyNames: [], isInstalled: false, selectedFontFace: undefined, isSelected: false },
    });

    expect(actions).toEqual([
      {
        kind: "install-nerd-font",
        description: "Install a Nerd Font (Meslo)",
        commandLine: "oh-my-posh font install meslo --headless",
        fontFamilyName: undefined,
      },
    ]);
  });

  it("offers to select an already-installed Nerd Font, naming the exact family, instead of reinstalling", () => {
    const actions = describeDoctorActions({
      targets: [
        { target: "windows-terminal", isInstalled: true },
        { target: "oh-my-posh", isInstalled: true },
        { target: "herdr", isInstalled: true },
      ],
      nerdFont: { installedNerdFontFamilyNames: ["MesloLGS NF"], isInstalled: true, selectedFontFace: "Cascadia Mono", isSelected: false },
    });

    expect(actions).toEqual([
      {
        kind: "select-nerd-font",
        description: 'Set Windows Terminal\'s profiles.defaults.fontFace to "MesloLGS NF"',
        commandLine: undefined,
        fontFamilyName: "MesloLGS NF",
      },
    ]);
  });

  it("offers nothing when every target and the font are already in good shape", () => {
    const actions = describeDoctorActions({
      targets: [
        { target: "windows-terminal", isInstalled: true },
        { target: "oh-my-posh", isInstalled: true },
        { target: "herdr", isInstalled: true },
      ],
      nerdFont: { installedNerdFontFamilyNames: ["MesloLGS NF"], isInstalled: true, selectedFontFace: "MesloLGS NF", isSelected: true },
    });

    expect(actions).toEqual([]);
  });
});
