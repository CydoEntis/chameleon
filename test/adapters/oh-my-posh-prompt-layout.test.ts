import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeConfigPathForPromptTracking,
  applyPromptLayout,
  restoreOriginalPrompt,
} from "../../src/adapters/oh-my-posh.js";

/**
 * CHM-47's own load-bearing guarantee: switching to a bundled prompt layout,
 * and back, must leave the user's own .omp.json byte-identical — this is a
 * hand-edited fixture carrying comments and an unrelated setting, the same
 * shape test/adapters/fixtures/oh-my-posh-config.omp.json uses for the
 * theme-swap case.
 */
const USER_CONFIG_TEXT = `// My own prompt — please don't touch this file, Chameleon.
{
    "$schema": "https://raw.githubusercontent.com/JanDeDobbeleer/oh-my-posh/main/themes/schema.json",
    "version": 2,
    "palette": {
        "accent": "#89b4fa" // hand picked, ages ago
    },
    "final_space": true,
    "blocks": [
        {
            "type": "prompt",
            "alignment": "left",
            "segments": [
                { "type": "path", "foreground": "p:accent" }
            ]
        }
    ]
}
`;

const PROFILE_TEXT = "# my profile\nSet-Alias ll Get-ChildItem\n";

let stateDir: string;
let userConfigPath: string;
let bundledConfigPath: string;
let profilePath: string;
let pointerPath: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-prompt-layout-"));
  userConfigPath = path.join(stateDir, "my-prompt.omp.json");
  bundledConfigPath = path.join(stateDir, "bundled-prompt.omp.json");
  profilePath = path.join(stateDir, "Microsoft.PowerShell_profile.ps1");
  pointerPath = path.join(stateDir, "oh-my-posh-pointer.json");
  writeFileSync(userConfigPath, USER_CONFIG_TEXT, "utf8");
  writeFileSync(profilePath, PROFILE_TEXT, "utf8");
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function readPointer(): { configPath: string; updatedAtMs: number } {
  return JSON.parse(readFileSync(pointerPath, "utf8"));
}

describe("applyPromptLayout", () => {
  it("writes the resolved config to Chameleon's own bundled-prompt file, never the user's own config path", () => {
    applyPromptLayout({ blocks: [{ segments: [{ foreground: "#ff0000" }] }] }, bundledConfigPath, profilePath, pointerPath, "pwsh");

    expect(JSON.parse(readFileSync(bundledConfigPath, "utf8"))).toEqual({ blocks: [{ segments: [{ foreground: "#ff0000" }] }] });
    // CHM-47's own load-bearing rule: the user's file was never opened.
    expect(readFileSync(userConfigPath, "utf8")).toBe(USER_CONFIG_TEXT);
  });

  it("repoints the pointer at the bundled config, not at whatever the pointer named before", () => {
    applyPromptLayout({ blocks: [] }, bundledConfigPath, profilePath, pointerPath, "pwsh");
    expect(readPointer().configPath).toBe(bundledConfigPath);
  });

  it("installs the live-reload hook when the profile has never had one, reporting the same creation notice CHM-39 asks for", () => {
    const freshProfilePath = path.join(stateDir, "fresh_profile.ps1");
    const notice = applyPromptLayout({ blocks: [] }, bundledConfigPath, freshProfilePath, pointerPath, "pwsh");
    expect(notice).toContain(freshProfilePath);
    expect(readFileSync(freshProfilePath, "utf8")).toContain("ch:begin");
  });

  it("leaves an already-hooked profile's own unrelated lines byte-identical outside Chameleon's own marker block", () => {
    applyPromptLayout({ blocks: [] }, bundledConfigPath, profilePath, pointerPath, "pwsh");
    const resultText = readFileSync(profilePath, "utf8");
    expect(resultText).toContain("# my profile");
    expect(resultText).toContain("Set-Alias ll Get-ChildItem");
  });
});

describe("activeConfigPathForPromptTracking", () => {
  it("falls back to the given configPath when the pointer has never been written", () => {
    const resolved = activeConfigPathForPromptTracking(userConfigPath, profilePath, pointerPath, "pwsh", bundledConfigPath);
    expect(resolved).toBe(userConfigPath);
  });

  it("prefers the pointer's own configPath once one exists, over the given configPath — the pointer is authoritative once anything has ever applied through it", () => {
    writeFileSync(pointerPath, JSON.stringify({ configPath: userConfigPath, updatedAtMs: 1 }), "utf8");
    const resolved = activeConfigPathForPromptTracking(undefined, profilePath, pointerPath, "pwsh", bundledConfigPath);
    expect(resolved).toBe(userConfigPath);
  });

  it("never adopts Chameleon's own bundled-prompt file as 'the user's own' — falls back to configPath instead", () => {
    writeFileSync(pointerPath, JSON.stringify({ configPath: bundledConfigPath, updatedAtMs: 1 }), "utf8");
    const resolved = activeConfigPathForPromptTracking(userConfigPath, profilePath, pointerPath, "pwsh", bundledConfigPath);
    expect(resolved).toBe(userConfigPath);
  });
});

describe("restoreOriginalPrompt", () => {
  it("repoints the pointer at the original config path without ever opening the file at that path", () => {
    applyPromptLayout({ blocks: [] }, bundledConfigPath, profilePath, pointerPath, "pwsh");
    expect(readPointer().configPath).toBe(bundledConfigPath);

    restoreOriginalPrompt(userConfigPath, pointerPath);

    expect(readPointer().configPath).toBe(userConfigPath);
    // CHM-47's own acceptance criterion: byte-identical, even after a
    // switch away and back.
    expect(readFileSync(userConfigPath, "utf8")).toBe(USER_CONFIG_TEXT);
  });

  it("works after several switches, not only the first — chm prompt mine's own acceptance criterion", () => {
    applyPromptLayout({ blocks: [{ segments: [{ foreground: "#111111" }] }] }, bundledConfigPath, profilePath, pointerPath, "pwsh");
    applyPromptLayout({ blocks: [{ segments: [{ foreground: "#222222" }] }] }, bundledConfigPath, profilePath, pointerPath, "pwsh");
    applyPromptLayout({ blocks: [{ segments: [{ foreground: "#333333" }] }] }, bundledConfigPath, profilePath, pointerPath, "pwsh");

    restoreOriginalPrompt(userConfigPath, pointerPath);

    expect(readPointer().configPath).toBe(userConfigPath);
    expect(readFileSync(userConfigPath, "utf8")).toBe(USER_CONFIG_TEXT);
  });
});
