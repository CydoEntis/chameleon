import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureOhMyPoshOwnedConfigSeeded,
  restoreOriginalPrompt,
  writeOwnedPromptConfig,
} from "../../src/adapters/oh-my-posh.js";
import { parseScheme, type Scheme } from "../../src/palette/scheme.js";

/**
 * CHM-47's own load-bearing guarantee, kept under CHM-59's single owned
 * config: switching to a bundled prompt layout, and back with `chm prompt
 * mine`, must leave the user's own .omp.json byte-identical — this is a
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

// A real, minimal scheme — never invented hex, see CLAUDE.md's colour-test
// rule — used wherever a test needs to recolor rather than just write raw
// JSON. Values from 0x96f (vendor/iterm2-color-schemes/windows-terminal).
const ZEROX96F_SCHEME: Scheme = parseScheme({
  name: "0x96f",
  black: "#262427",
  red: "#ff666d",
  green: "#b3e03a",
  yellow: "#ffc739",
  blue: "#00cde8",
  purple: "#a392e8",
  cyan: "#9deaf6",
  white: "#fcfcfa",
  brightBlack: "#545452",
  brightRed: "#ff7e83",
  brightGreen: "#bee55e",
  brightYellow: "#ffd05e",
  brightBlue: "#1bd5eb",
  brightPurple: "#b0a3eb",
  brightCyan: "#acedf8",
  brightWhite: "#fcfcfa",
  background: "#262427",
  foreground: "#fcfcfa",
  cursorColor: "#fcfcfa",
  selectionBackground: "#fcfcfa",
});

let stateDir: string;
let userConfigPath: string;
let ownedConfigPath: string;
let profilePath: string;
let promptStatePath: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-prompt-layout-"));
  userConfigPath = path.join(stateDir, "my-prompt.omp.json");
  ownedConfigPath = path.join(stateDir, "chameleon.omp.json");
  profilePath = path.join(stateDir, "Microsoft.PowerShell_profile.ps1");
  promptStatePath = path.join(stateDir, "prompt-state.json");
  writeFileSync(userConfigPath, USER_CONFIG_TEXT, "utf8");
  writeFileSync(profilePath, PROFILE_TEXT, "utf8");
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("writeOwnedPromptConfig", () => {
  it("writes the resolved config to Chameleon's own owned config, never the user's own config path", () => {
    writeOwnedPromptConfig({ blocks: [{ segments: [{ foreground: "#ff0000" }] }] }, ownedConfigPath, profilePath, "pwsh");

    expect(JSON.parse(readFileSync(ownedConfigPath, "utf8"))).toEqual({ blocks: [{ segments: [{ foreground: "#ff0000" }] }] });
    // CHM-47's own load-bearing rule: the user's file was never opened.
    expect(readFileSync(userConfigPath, "utf8")).toBe(USER_CONFIG_TEXT);
  });

  it("installs the profile's init line when the profile has never had one, reporting the same creation notice CHM-39 asks for", () => {
    const freshProfilePath = path.join(stateDir, "fresh_profile.ps1");
    const notice = writeOwnedPromptConfig({ blocks: [] }, ownedConfigPath, freshProfilePath, "pwsh");
    expect(notice).toContain(freshProfilePath);
    expect(readFileSync(freshProfilePath, "utf8")).toContain("ch:begin");
    expect(readFileSync(freshProfilePath, "utf8")).toContain(ownedConfigPath);
  });

  it("leaves an already-hooked profile's own unrelated lines byte-identical outside Chameleon's own marker block", () => {
    writeOwnedPromptConfig({ blocks: [] }, ownedConfigPath, profilePath, "pwsh");
    const resultText = readFileSync(profilePath, "utf8");
    expect(resultText).toContain("# my profile");
    expect(resultText).toContain("Set-Alias ll Get-ChildItem");
  });
});

describe("ensureOhMyPoshOwnedConfigSeeded", () => {
  it("discovers the user's own config via the profile's own init line, and copies it into the owned path", () => {
    writeFileSync(profilePath, `oh-my-posh init pwsh --config '${userConfigPath}' | Invoke-Expression\n`, "utf8");

    const discovered = ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "pwsh", promptStatePath);

    expect(discovered).toBe(userConfigPath);
    expect(readFileSync(ownedConfigPath, "utf8")).toBe(USER_CONFIG_TEXT);
    // The user's own file was only ever read, never written.
    expect(readFileSync(userConfigPath, "utf8")).toBe(USER_CONFIG_TEXT);
  });

  it("is a no-op once prompt-state already records an origin — never re-discovers or re-copies", () => {
    writeFileSync(ownedConfigPath, "{}", "utf8");
    writeFileSync(profilePath, `oh-my-posh init pwsh --config '${userConfigPath}' | Invoke-Expression\n`, "utf8");
    ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "pwsh", promptStatePath);
    writeFileSync(ownedConfigPath, "{}", "utf8"); // simulate a layout switch since the first seed

    const discovered = ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "pwsh", promptStatePath);

    expect(discovered).toBe(userConfigPath);
    // Not re-copied over whatever a later layout switch left in place.
    expect(readFileSync(ownedConfigPath, "utf8")).toBe("{}");
  });
});

describe("restoreOriginalPrompt", () => {
  it("copies the original config's current content, recolors it into the owned config, and never opens it for writing", () => {
    // A prior layout switch left something else in the owned config.
    writeFileSync(ownedConfigPath, JSON.stringify({ blocks: [] }), "utf8");

    restoreOriginalPrompt(userConfigPath, ZEROX96F_SCHEME, ownedConfigPath, profilePath, "pwsh");

    // CHM-47's own acceptance criterion: byte-identical, even after a
    // switch away and back.
    expect(readFileSync(userConfigPath, "utf8")).toBe(USER_CONFIG_TEXT);
    const resultPalette = (parseJsonc(readFileSync(ownedConfigPath, "utf8"), [], { allowTrailingComma: true }) as {
      palette: Record<string, string>;
    }).palette;
    expect(resultPalette["accent"]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("re-reads the original file fresh every time — several restores in a row all reflect the same untouched original", () => {
    restoreOriginalPrompt(userConfigPath, ZEROX96F_SCHEME, ownedConfigPath, profilePath, "pwsh");
    restoreOriginalPrompt(userConfigPath, ZEROX96F_SCHEME, ownedConfigPath, profilePath, "pwsh");
    restoreOriginalPrompt(userConfigPath, ZEROX96F_SCHEME, ownedConfigPath, profilePath, "pwsh");

    expect(readFileSync(userConfigPath, "utf8")).toBe(USER_CONFIG_TEXT);
  });
});
