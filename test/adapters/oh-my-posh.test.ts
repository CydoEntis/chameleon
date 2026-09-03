import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOhMyPoshAdapter, undoOhMyPosh } from "../../src/adapters/oh-my-posh.js";
import { ROLES } from "../../src/constants.js";
import { toPalette } from "../../src/palette/palette.js";
import { assignRolesByContrast } from "../../src/palette/roles.js";
import { repairFailingRoles } from "../../src/palette/repair.js";
import { parseScheme, type Scheme } from "../../src/palette/scheme.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FIXTURE_PATH = path.join(currentDir, "fixtures", "oh-my-posh.omp.jsonc");
const PROFILE_FIXTURE_PATH = path.join(currentDir, "fixtures", "profile.ps1");

const CONFIG_FIXTURE = readFileSync(CONFIG_FIXTURE_PATH, "utf8");
const PROFILE_FIXTURE = readFileSync(PROFILE_FIXTURE_PATH, "utf8");

// Real vendored scheme values (mbadolato/iTerm2-Color-Schemes) — never invented hex.
// Same schemes test/adapters/windows-terminal.test.ts already validates against.
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

const AARDVARK_BLUE_SCHEME: Scheme = parseScheme({
  name: "Aardvark Blue",
  black: "#191919",
  red: "#aa342e",
  green: "#4b8c0f",
  yellow: "#dbba00",
  blue: "#1370d3",
  purple: "#c43ac3",
  cyan: "#008eb0",
  white: "#bebebe",
  brightBlack: "#525252",
  brightRed: "#f05b50",
  brightGreen: "#95dc55",
  brightYellow: "#ffe763",
  brightBlue: "#60a4ec",
  brightPurple: "#e26be2",
  brightCyan: "#60b6cb",
  brightWhite: "#f7f7f7",
  background: "#102040",
  foreground: "#dddddd",
  cursorColor: "#007acc",
  selectionBackground: "#bfdbfe",
});

/** The role → hex map this adapter must write for `scheme`, computed through the same pipeline the adapter itself calls. */
function resolvedPaletteHexOf(scheme: Scheme): Record<(typeof ROLES)[number], string> {
  const { palette } = repairFailingRoles(assignRolesByContrast(toPalette(scheme)));
  return Object.fromEntries(ROLES.map((role) => [role, palette[role].hex])) as Record<(typeof ROLES)[number], string>;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function parseWritten(text: string): unknown {
  return parseJsonc(text, [], { allowTrailingComma: true });
}

/** Writes the profile fixture as if the user already had one — creating the parent directory the test's own temp layout doesn't. */
function writeExistingProfileFixture(profilePath: string): void {
  mkdirSync(path.dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, PROFILE_FIXTURE, "utf8");
}

/**
 * True when every line of `original`, in order, appears verbatim somewhere
 * in `result` — the byte-for-byte-outside-the-markers guarantee, checked
 * without re-implementing the adapter's own splicing logic in the test.
 */
function everyOriginalLineSurvivesInOrder(original: string, result: string): boolean {
  const originalLines = original.split(/\r\n|\n/);
  const resultLines = result.split(/\r\n|\n/);
  let originalIndex = 0;
  for (const resultLine of resultLines) {
    if (originalIndex < originalLines.length && resultLine === originalLines[originalIndex]) {
      originalIndex += 1;
    }
  }
  return originalIndex === originalLines.length;
}

describe("oh my posh adapter", () => {
  let workDir: string;
  let configPath: string;
  let pointerPath: string;
  let profilePath: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-"));
    configPath = path.join(workDir, "theme.omp.json");
    pointerPath = path.join(workDir, "pointer", "pointer.json");
    profilePath = path.join(workDir, "profile", "Microsoft.PowerShell_profile.ps1");
    writeFileSync(configPath, CONFIG_FIXTURE, "utf8");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("detects Oh My Posh by the presence of its config file", () => {
    expect(createOhMyPoshAdapter(configPath, pointerPath, profilePath).detect()).toBe(true);
    expect(createOhMyPoshAdapter(path.join(workDir, "missing.omp.json"), pointerPath, profilePath).detect()).toBe(false);
    expect(createOhMyPoshAdapter(undefined, pointerPath, profilePath).detect()).toBe(false);
  });

  it("reads a hostile config — comments and trailing commas included", () => {
    const config = createOhMyPoshAdapter(configPath, pointerPath, profilePath).read();
    expect(config.palette?.["customAccent"]).toBe("#89b4fa");
    expect(Array.isArray(config.blocks)).toBe(true);
  });

  it("writes every role as a palette entry, matching the resolved palette exactly", () => {
    createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);

    const parsed = parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> };
    const expectedHex = resolvedPaletteHexOf(ZEROX96F_SCHEME);
    for (const role of ROLES) {
      expect(parsed.palette[role]).toBe(expectedHex[role]);
    }
  });

  it("leaves the segment list byte-identical across a theme swap", () => {
    const originalParsed = parseWritten(CONFIG_FIXTURE) as { blocks: unknown };

    createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);
    const afterFirstApply = readFileSync(configPath, "utf8");
    const afterFirstBlocks = (parseWritten(afterFirstApply) as { blocks: unknown }).blocks;
    expect(afterFirstBlocks).toEqual(originalParsed.blocks);

    createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(AARDVARK_BLUE_SCHEME);
    const afterSecondApply = readFileSync(configPath, "utf8");
    const afterSecondBlocks = (parseWritten(afterSecondApply) as { blocks: unknown }).blocks;
    expect(afterSecondBlocks).toEqual(originalParsed.blocks);
  });

  it("preserves unrelated palette entries, comments and key order untouched by any edit", () => {
    createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(resultText).toContain("// Oh My Posh prompt config");
    expect(resultText).toContain("// a colour I added myself, unrelated to chameleon");
    expect(resultText).toContain("// keep the title in sync with the shell name");
    expect(everyOriginalLineSurvivesInOrder(CONFIG_FIXTURE, resultText)).toBe(true);

    const parsed = parseWritten(resultText) as { palette: Record<string, string>; console_title_template: string };
    expect(parsed.palette["customAccent"]).toBe("#89b4fa");
    expect(parsed.palette["os"]).toBe("#ACE1AF");
    expect(parsed.console_title_template).toBe("{{ .Shell }}");
  });

  it("is idempotent — applying the same theme twice produces the same file", () => {
    const adapter = createOhMyPoshAdapter(configPath, pointerPath, profilePath);

    adapter.apply(ZEROX96F_SCHEME);
    const afterFirstApply = readFileSync(configPath, "utf8");

    adapter.apply(ZEROX96F_SCHEME);
    const afterSecondApply = readFileSync(configPath, "utf8");

    expect(afterSecondApply).toBe(afterFirstApply);
    expect(countOccurrences(afterSecondApply, "// ch:begin")).toBe(1);
  });

  it("upserts the palette block in place when a different theme is applied later", () => {
    const adapter = createOhMyPoshAdapter(configPath, pointerPath, profilePath);

    adapter.apply(ZEROX96F_SCHEME);
    adapter.apply(AARDVARK_BLUE_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    const parsed = parseWritten(resultText) as { palette: Record<string, string> };
    const expectedHex = resolvedPaletteHexOf(AARDVARK_BLUE_SCHEME);
    for (const role of ROLES) {
      expect(parsed.palette[role]).toBe(expectedHex[role]);
    }
    expect(countOccurrences(resultText, "// ch:begin")).toBe(1);
  });

  it("dedupes a pre-existing plain entry under a role's own name, leaving exactly one", () => {
    const configWithConflict = CONFIG_FIXTURE.replace(
      '"customAccent": "#89b4fa",',
      '"accent": "#ffffff",\n        "customAccent": "#89b4fa",',
    );
    writeFileSync(configPath, configWithConflict, "utf8");

    createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(countOccurrences(resultText, '"accent"')).toBe(1);
    const parsed = parseWritten(resultText) as { palette: Record<string, string> };
    expect(parsed.palette.accent).toBe(resolvedPaletteHexOf(ZEROX96F_SCHEME).accent);
  });

  it("seeds a palette object on a config that predates the feature", () => {
    const configWithoutPalette = JSON.stringify({
      blocks: [{ type: "prompt", segments: [{ type: "os", foreground: "p:accent" }] }],
    });
    writeFileSync(configPath, configWithoutPalette, "utf8");

    createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);

    const parsed = parseWritten(readFileSync(configPath, "utf8")) as {
      palette: Record<string, string>;
      blocks: unknown;
    };
    expect(parsed.palette.accent).toBe(resolvedPaletteHexOf(ZEROX96F_SCHEME).accent);
    expect(parsed.blocks).toEqual(JSON.parse(configWithoutPalette).blocks);
  });

  it("writes a backup before every apply, and undo restores the config exactly", () => {
    createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);
    expect(readFileSync(configPath, "utf8")).not.toBe(CONFIG_FIXTURE);
    expect(readFileSync(`${configPath}.chameleon-backup`, "utf8")).toBe(CONFIG_FIXTURE);

    undoOhMyPosh(configPath, profilePath);
    expect(readFileSync(configPath, "utf8")).toBe(CONFIG_FIXTURE);
  });

  it("undoes a freshly-created profile by removing it, since it never had a prior version to restore", () => {
    createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);
    expect(readFileSync(profilePath, "utf8")).toContain("# ch:begin");

    undoOhMyPosh(configPath, profilePath);
    expect(existsSync(profilePath)).toBe(false);
  });

  it("refuses to apply when there is no config to edit", () => {
    const adapter = createOhMyPoshAdapter(path.join(workDir, "missing.omp.json"), pointerPath, profilePath);
    expect(() => adapter.apply(ZEROX96F_SCHEME)).toThrow();
  });

  it("names the file and the problem when a config it must edit is shaped wrong", () => {
    const malformedPath = path.join(workDir, "malformed.omp.json");
    writeFileSync(malformedPath, JSON.stringify({ palette: "not an object" }), "utf8");
    expect(() => createOhMyPoshAdapter(malformedPath, pointerPath, profilePath).read()).toThrow(malformedPath);
  });

  it("reloads without touching the config — an already-running shell picks the change up on its own", () => {
    createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);
    const afterApply = readFileSync(configPath, "utf8");

    createOhMyPoshAdapter(configPath, pointerPath, profilePath).reload();
    expect(readFileSync(configPath, "utf8")).toBe(afterApply);
  });

  describe("the pointer file", () => {
    it("records the active config path and a timestamp, and updates the timestamp on reapply", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);
        const firstPointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { configPath: string; appliedAt: string };
        expect(firstPointer.configPath).toBe(configPath);
        expect(firstPointer.appliedAt).toBe("2026-01-01T00:00:00.000Z");

        vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
        createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(AARDVARK_BLUE_SCHEME);
        const secondPointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { configPath: string; appliedAt: string };
        expect(secondPointer.appliedAt).toBe("2026-01-01T00:05:00.000Z");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("the PowerShell profile", () => {
    it("chains an existing user-defined Set-PoshContext instead of clobbering it", () => {
      writeExistingProfileFixture(profilePath);

      createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);

      const resultText = readFileSync(profilePath, "utf8");
      // The user's own function is still there, byte for byte.
      expect(resultText).toContain('function Set-PoshContext {\n    # my own context setup, unrelated to chameleon\n    $env:MY_CUSTOM_VAR = "hello"\n}');
      expect(everyOriginalLineSurvivesInOrder(PROFILE_FIXTURE, resultText)).toBe(true);
      // Chameleon's own block captures it under another name before redefining Set-PoshContext.
      expect(resultText).toContain("__ChameleonUserPoshContext");
      expect(resultText).toContain("function global:Set-PoshContext {");
      expect(countOccurrences(resultText, "# ch:begin")).toBe(1);
    });

    it("creates the profile and its parent directory when neither exists yet", () => {
      createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);

      const resultText = readFileSync(profilePath, "utf8");
      expect(resultText).toContain("# ch:begin");
      expect(resultText).toContain("# ch:end");
    });

    it("references the pointer file it wrote, so the installed hook reads the same file apply() writes", () => {
      createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);

      const resultText = readFileSync(profilePath, "utf8");
      expect(resultText).toContain(pointerPath);
    });

    it("is idempotent and preserves unrelated profile content across a second apply", () => {
      writeExistingProfileFixture(profilePath);
      const adapter = createOhMyPoshAdapter(configPath, pointerPath, profilePath);

      adapter.apply(ZEROX96F_SCHEME);
      const afterFirstApply = readFileSync(profilePath, "utf8");

      adapter.apply(AARDVARK_BLUE_SCHEME);
      const afterSecondApply = readFileSync(profilePath, "utf8");

      expect(afterSecondApply).toBe(afterFirstApply); // pointer path unchanged, so the block itself doesn't change
      expect(countOccurrences(afterSecondApply, "# ch:begin")).toBe(1);
      expect(afterSecondApply).toContain("Set-PSReadLineOption -PredictionSource History");
      expect(afterSecondApply).toContain('oh-my-posh init pwsh --config "$env:POSH_THEME" | Invoke-Expression');
    });

    it("writes a backup before editing an existing profile, and undo restores it exactly", () => {
      writeExistingProfileFixture(profilePath);

      createOhMyPoshAdapter(configPath, pointerPath, profilePath).apply(ZEROX96F_SCHEME);
      expect(readFileSync(profilePath, "utf8")).not.toBe(PROFILE_FIXTURE);
      expect(readFileSync(`${profilePath}.chameleon-backup`, "utf8")).toBe(PROFILE_FIXTURE);

      undoOhMyPosh(configPath, profilePath);
      expect(readFileSync(profilePath, "utf8")).toBe(PROFILE_FIXTURE);
    });
  });
});
