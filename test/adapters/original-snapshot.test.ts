import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureOriginalSnapshotIfMissing,
  readOriginalSnapshot,
  restoreClaudeCodeFromSnapshot,
  restoreHerdrFromSnapshot,
  restoreOhMyPoshFromSnapshot,
  restoreWindowsTerminalFromSnapshot,
  type OriginalSnapshotCapturePaths,
} from "../../src/adapters/original-snapshot.js";

/**
 * CHM-71: the one-time snapshot that lets Chameleon own a surface it used to
 * have to leave alone. These tests exercise the module directly, against real
 * temp files rather than mocks — the whole point of this file is "does a
 * byte-for-byte restore actually happen", which a mock cannot prove.
 */

let scratchDir: string;
let snapshotPath: string;
let windowsTerminalSettingsPath: string;
let herdrConfigPath: string;
let claudeCodeSettingsPath: string;
let ohMyPoshProfilePath: string;
let ohMyPoshConfigPath: string;

// A hostile fixture per code-standards.md: comments, unrelated settings, and
// a shape a real hand-edited file would carry — never a clean minimal config.
const WINDOWS_TERMINAL_FIXTURE = [
  "{",
  '  // my own colour scheme, do not let the picker overwrite this comment',
  '  "theme": "dark",',
  '  "profiles": { "defaults": { "colorScheme": "Aardvark Blue", "fontFace": "Cascadia Code" } },',
  '  "schemes": [ { "name": "Aardvark Blue", "background": "#00002a" } ],',
  '  "copyOnSelect": true',
  "}",
  "",
].join("\n");

const HERDR_FIXTURE = [
  "# herdr's own config, hand-edited",
  "[theme]",
  'name = "rose-pine"',
  "",
  "[theme.custom]",
  'accent = "#c4a7e7"',
  "",
  "[ui]",
  "status-bar = true",
  'accent = "#c4a7e7"',
  "",
].join("\n");

const CLAUDE_CODE_FIXTURE = JSON.stringify(
  { theme: "light", statusLine: { type: "command", command: "node ~/.claude/statusline.js" }, effortLevel: "high" },
  null,
  2,
);

/** Built once `ohMyPoshConfigPath` is known (see beforeEach) — a real pwsh profile line quotes its own `--config` path, which is what lets it survive round-tripping on Windows without needing `$env:`-style expansion. */
function buildOhMyPoshProfileFixture(): string {
  return ["# my own aliases", "Set-Alias ll ls", `oh-my-posh init pwsh --config "${ohMyPoshConfigPath}" | Invoke-Expression`, ""].join("\n");
}

const OH_MY_POSH_CONFIG_FIXTURE = JSON.stringify({ palette: { accent: "#89b4fa" }, blocks: [] }, null, 2);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(tmpdir(), "chameleon-original-snapshot-"));
  snapshotPath = path.join(scratchDir, "state", "original-snapshot.json");
  windowsTerminalSettingsPath = path.join(scratchDir, "windows-terminal-settings.json");
  herdrConfigPath = path.join(scratchDir, "herdr-config.toml");
  claudeCodeSettingsPath = path.join(scratchDir, "claude-settings.json");
  ohMyPoshProfilePath = path.join(scratchDir, "profile.ps1");
  ohMyPoshConfigPath = path.join(scratchDir, "mine.omp.json");
  // Oh My Posh discovery prefers $POSH_CONFIG over the profile's own init
  // line, so a real one in the environment running this suite is found
  // instead of the fixture above — and the test then asserts against the
  // developer's own prompt. Clear both so the profile is the only source.
  vi.stubEnv("POSH_CONFIG", "");
  vi.stubEnv("POSH_THEME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratchDir, { recursive: true, force: true });
});

/** Every target present and configured — the "first apply on a configured machine" case every acceptance criterion in the ticket starts from. */
function writeAllFourFixtures(): void {
  writeFileSync(windowsTerminalSettingsPath, WINDOWS_TERMINAL_FIXTURE, "utf8");
  writeFileSync(herdrConfigPath, HERDR_FIXTURE, "utf8");
  writeFileSync(claudeCodeSettingsPath, CLAUDE_CODE_FIXTURE, "utf8");
  writeFileSync(ohMyPoshProfilePath, buildOhMyPoshProfileFixture(), "utf8");
  writeFileSync(ohMyPoshConfigPath, OH_MY_POSH_CONFIG_FIXTURE, "utf8");
}

function fullCapturePaths(): OriginalSnapshotCapturePaths {
  return {
    windowsTerminalSettingsPath,
    herdrConfigPath,
    claudeCodeSettingsPath,
    ohMyPoshDetected: true,
    ohMyPoshShell: "pwsh",
    ohMyPoshProfilePath,
  };
}

describe("captureOriginalSnapshotIfMissing", () => {
  it("captures all four surfaces on a configured machine", () => {
    writeAllFourFixtures();

    captureOriginalSnapshotIfMissing(snapshotPath, fullCapturePaths());

    const snapshot = readOriginalSnapshot(snapshotPath);
    expect(snapshot?.windowsTerminal?.settingsText).toBe(WINDOWS_TERMINAL_FIXTURE);
    expect(snapshot?.herdr?.configText).toBe(HERDR_FIXTURE);
    expect(snapshot?.claudeCode?.settingsText).toBe(CLAUDE_CODE_FIXTURE);
    expect(snapshot?.ohMyPosh?.profileText).toBe(buildOhMyPoshProfileFixture());
    expect(snapshot?.ohMyPosh?.didProfileExist).toBe(true);
  });

  it("captures nothing on a machine with nothing configured — behaves as it does today", () => {
    // None of the four fixtures written; Oh My Posh reported not installed.
    captureOriginalSnapshotIfMissing(snapshotPath, { ...fullCapturePaths(), ohMyPoshDetected: false });

    const snapshot = readOriginalSnapshot(snapshotPath);
    expect(snapshot?.windowsTerminal).toBeUndefined();
    expect(snapshot?.herdr).toBeUndefined();
    expect(snapshot?.claudeCode).toBeUndefined();
    expect(snapshot?.ohMyPosh).toBeUndefined();
    // Still recorded once, so a target installed later is never retroactively "captured" from a state Chameleon itself already changed.
    expect(existsSync(snapshotPath)).toBe(true);
  });

  it("captures only the surfaces actually configured, leaving the rest undefined", () => {
    writeFileSync(claudeCodeSettingsPath, CLAUDE_CODE_FIXTURE, "utf8");

    // Every path pointed somewhere in the scratch dir — even the ones with
    // "nothing configured" — so this never falls through to a real,
    // machine-specific default and reads an actual installed config.
    captureOriginalSnapshotIfMissing(snapshotPath, {
      claudeCodeSettingsPath,
      windowsTerminalSettingsPath: path.join(scratchDir, "no-windows-terminal-here.json"),
      herdrConfigPath: path.join(scratchDir, "no-herdr-here.toml"),
      ohMyPoshDetected: false,
    });

    const snapshot = readOriginalSnapshot(snapshotPath);
    expect(snapshot?.claudeCode?.settingsText).toBe(CLAUDE_CODE_FIXTURE);
    expect(snapshot?.windowsTerminal).toBeUndefined();
    expect(snapshot?.herdr).toBeUndefined();
  });

  it("never recaptures once a snapshot exists, even across many later applies with several different themes", () => {
    writeAllFourFixtures();
    captureOriginalSnapshotIfMissing(snapshotPath, fullCapturePaths());
    const firstSnapshotText = readFileSync(snapshotPath, "utf8");

    // Simulate several real theme applies changing every live config.
    for (const themeMarker of ["catppuccin", "dracula", "nord", "gruvbox"]) {
      writeFileSync(windowsTerminalSettingsPath, `{"theme":"${themeMarker}"}`, "utf8");
      writeFileSync(herdrConfigPath, `[theme]\nname = "${themeMarker}"\n`, "utf8");
      writeFileSync(claudeCodeSettingsPath, JSON.stringify({ theme: `${themeMarker}-ansi`, statusLine: { type: "command", command: "chm statusline" } }), "utf8");
      captureOriginalSnapshotIfMissing(snapshotPath, fullCapturePaths());
    }

    expect(readFileSync(snapshotPath, "utf8")).toBe(firstSnapshotText);
    const snapshot = readOriginalSnapshot(snapshotPath);
    expect(snapshot?.windowsTerminal?.settingsText).toBe(WINDOWS_TERMINAL_FIXTURE);
    expect(snapshot?.claudeCode?.settingsText).toBe(CLAUDE_CODE_FIXTURE);
  });

  it("never recaptures over a corrupted snapshot file — existence alone is the guard, never validity", () => {
    mkdirSync(path.dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, "{ not actually json", "utf8");
    writeAllFourFixtures();

    captureOriginalSnapshotIfMissing(snapshotPath, fullCapturePaths());

    // Still the corrupted content — a recapture here would have silently
    // recorded Chameleon's own already-live state as "the original".
    expect(readFileSync(snapshotPath, "utf8")).toBe("{ not actually json");
  });

  it("survives an interrupted write: a leftover, half-written temp file never blocks or corrupts the next capture", () => {
    mkdirSync(path.dirname(snapshotPath), { recursive: true });
    // Simulate a crash between the temp write and the rename in
    // writeSnapshotAtomically: a stray temp file sits beside the real path,
    // which itself was never created.
    writeFileSync(path.join(path.dirname(snapshotPath), ".original-snapshot.json.tmp-stale"), "{ half", "utf8");
    writeAllFourFixtures();

    captureOriginalSnapshotIfMissing(snapshotPath, fullCapturePaths());

    expect(existsSync(snapshotPath)).toBe(true);
    const snapshot = readOriginalSnapshot(snapshotPath);
    expect(snapshot?.claudeCode?.settingsText).toBe(CLAUDE_CODE_FIXTURE);
  });

  it("leaves nothing behind at the final path if the write is interrupted before the atomic rename", () => {
    // The write-then-rename shape itself: writing directly to a temp path
    // and never renaming it must never make the real snapshot appear to
    // exist, which is exactly the property a killed process relies on.
    mkdirSync(path.dirname(snapshotPath), { recursive: true });
    const temporaryPath = `${snapshotPath}.tmp-simulated-crash`;
    writeFileSync(temporaryPath, JSON.stringify({ capturedAtMs: Date.now() }), "utf8");

    expect(existsSync(snapshotPath)).toBe(false);
    // A subsequent real capture must still run normally, proving the
    // leftover temp file was never mistaken for a completed snapshot.
    writeAllFourFixtures();
    captureOriginalSnapshotIfMissing(snapshotPath, fullCapturePaths());
    expect(readOriginalSnapshot(snapshotPath)?.claudeCode?.settingsText).toBe(CLAUDE_CODE_FIXTURE);

    rmSync(temporaryPath, { force: true });
  });
});

describe("readOriginalSnapshot", () => {
  it("returns undefined when nothing has ever been captured", () => {
    expect(readOriginalSnapshot(snapshotPath)).toBeUndefined();
  });

  it("throws, naming the file, rather than silently treating a corrupted snapshot as missing", () => {
    mkdirSync(path.dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, "{ not json", "utf8");

    expect(() => readOriginalSnapshot(snapshotPath)).toThrow(snapshotPath);
  });

  it("throws, naming the file, when the JSON parses but does not match the snapshot shape", () => {
    mkdirSync(path.dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({ notASnapshot: true }), "utf8");

    expect(() => readOriginalSnapshot(snapshotPath)).toThrow(snapshotPath);
  });
});

describe("restoring — byte-identical, verified by hash", () => {
  beforeEach(() => {
    writeAllFourFixtures();
    captureOriginalSnapshotIfMissing(snapshotPath, fullCapturePaths());

    // Several "applies" later, every live file has drifted from the original.
    writeFileSync(windowsTerminalSettingsPath, '{"theme":"light","profiles":{"defaults":{"colorScheme":"Chameleon"}}}', "utf8");
    writeFileSync(herdrConfigPath, '[theme]\nname = "dracula"\n', "utf8");
    writeFileSync(claudeCodeSettingsPath, JSON.stringify({ theme: "dark-ansi", statusLine: { type: "command", command: "chm statusline" } }), "utf8");
    writeFileSync(ohMyPoshProfilePath, "# ch:begin\noh-my-posh init pwsh --config chameleon.omp.json | Invoke-Expression\n# ch:end\n", "utf8");
  });

  it("restores Windows Terminal's settings.json to the exact original hash", () => {
    const snapshot = readOriginalSnapshot(snapshotPath)!;
    expect(restoreWindowsTerminalFromSnapshot(snapshot)).toBe(true);

    expect(sha256(readFileSync(windowsTerminalSettingsPath, "utf8"))).toBe(sha256(WINDOWS_TERMINAL_FIXTURE));
  });

  it("restores Herdr's config.toml to the exact original hash", () => {
    const snapshot = readOriginalSnapshot(snapshotPath)!;
    expect(restoreHerdrFromSnapshot(snapshot)).toBe(true);

    expect(sha256(readFileSync(herdrConfigPath, "utf8"))).toBe(sha256(HERDR_FIXTURE));
  });

  it("restores Claude Code's settings.json — theme and statusLine both — to the exact original hash", () => {
    const snapshot = readOriginalSnapshot(snapshotPath)!;
    expect(restoreClaudeCodeFromSnapshot(snapshot)).toBe(true);

    const restoredText = readFileSync(claudeCodeSettingsPath, "utf8");
    expect(sha256(restoredText)).toBe(sha256(CLAUDE_CODE_FIXTURE));
    expect(JSON.parse(restoredText).statusLine).toEqual({ type: "command", command: "node ~/.claude/statusline.js" });
  });

  it("restores the Oh My Posh shell profile to the exact original hash", () => {
    const snapshot = readOriginalSnapshot(snapshotPath)!;
    expect(restoreOhMyPoshFromSnapshot(snapshot)).toBe(true);

    expect(sha256(readFileSync(ohMyPoshProfilePath, "utf8"))).toBe(sha256(buildOhMyPoshProfileFixture()));
  });

  it("deletes the Oh My Posh profile on restore when Chameleon itself created it from nothing", () => {
    rmSync(ohMyPoshProfilePath, { force: true });
    captureOriginalSnapshotIfMissing(path.join(scratchDir, "state2", "snap.json"), {
      ohMyPoshDetected: true,
      ohMyPoshShell: "pwsh",
      ohMyPoshProfilePath,
    });
    const snapshot = readOriginalSnapshot(path.join(scratchDir, "state2", "snap.json"))!;
    expect(snapshot.ohMyPosh?.didProfileExist).toBe(false);

    writeFileSync(ohMyPoshProfilePath, "# ch:begin\noh-my-posh init pwsh --config chameleon.omp.json | Invoke-Expression\n# ch:end\n", "utf8");
    expect(restoreOhMyPoshFromSnapshot(snapshot)).toBe(true);

    expect(existsSync(ohMyPoshProfilePath)).toBe(false);
  });

  it("restores the pre-owned Oh My Posh config it discovered, alongside the profile", () => {
    const snapshot = readOriginalSnapshot(snapshotPath)!;
    expect(snapshot.ohMyPosh?.discoveredConfig?.path).toBe(ohMyPoshConfigPath);

    writeFileSync(ohMyPoshConfigPath, '{"palette":{"accent":"#ff0000"}}', "utf8");
    restoreOhMyPoshFromSnapshot(snapshot);

    expect(sha256(readFileSync(ohMyPoshConfigPath, "utf8"))).toBe(sha256(OH_MY_POSH_CONFIG_FIXTURE));
  });

  it("returns false, restoring nothing, for a target that had nothing recorded", () => {
    const snapshot = readOriginalSnapshot(snapshotPath)!;
    const emptySnapshot = { ...snapshot, herdr: undefined };

    expect(restoreHerdrFromSnapshot(emptySnapshot)).toBe(false);
  });
});

describe("restoring survives real-machine-style round trips (several themes, then restore)", () => {
  it("matches copies taken beforehand, hash for hash, after many applies and a restore — the ticket's own verification method", () => {
    writeAllFourFixtures();
    const beforeHashes = {
      windowsTerminal: sha256(WINDOWS_TERMINAL_FIXTURE),
      herdr: sha256(HERDR_FIXTURE),
      claudeCode: sha256(CLAUDE_CODE_FIXTURE),
    };

    captureOriginalSnapshotIfMissing(snapshotPath, fullCapturePaths());

    for (const themeMarker of ["catppuccin", "dracula", "nord"]) {
      writeFileSync(windowsTerminalSettingsPath, `{"theme":"${themeMarker}"}`, "utf8");
      writeFileSync(herdrConfigPath, `[theme]\nname = "${themeMarker}"\n`, "utf8");
      writeFileSync(claudeCodeSettingsPath, JSON.stringify({ theme: `${themeMarker}-ansi` }), "utf8");
      captureOriginalSnapshotIfMissing(snapshotPath, fullCapturePaths());
    }

    const snapshot = readOriginalSnapshot(snapshotPath)!;
    restoreWindowsTerminalFromSnapshot(snapshot);
    restoreHerdrFromSnapshot(snapshot);
    restoreClaudeCodeFromSnapshot(snapshot);

    expect(sha256(readFileSync(windowsTerminalSettingsPath, "utf8"))).toBe(beforeHashes.windowsTerminal);
    expect(sha256(readFileSync(herdrConfigPath, "utf8"))).toBe(beforeHashes.herdr);
    expect(sha256(readFileSync(claudeCodeSettingsPath, "utf8"))).toBe(beforeHashes.claudeCode);
  });
});
