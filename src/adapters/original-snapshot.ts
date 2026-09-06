import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createDefaultOhMyPoshAdapter, discoverPreOwnedOhMyPoshConfig } from "./oh-my-posh.js";
import { claudeCodeSettingsPath, detectShell, herdrConfigPath, ohMyPoshProfilePathFor, stateDir, type Shell } from "./platform.js";
import { defaultWindowsTerminalSettingsPath } from "./windows-terminal.js";

/**
 * CHM-71: the machine's own setup, exactly as it was before Chameleon ever
 * wrote to it. Taken once — on the very first apply, before any target is
 * touched — and never overwritten by any apply after that. This is what lets
 * `chm <theme>` freely own a surface it used to have to leave alone (Claude
 * Code's statusLine, most notably): the original is preserved by being
 * copied somewhere safe, not by Chameleon refusing to write.
 *
 * Every field here is the *raw* file text a target's own apply is about to
 * overwrite, never a parsed, narrower slice of it — a byte-identical restore
 * is only ever as good as what was captured, and reconstructing a file from
 * a few named fields (a theme name, a colour) would lose whatever else a
 * hand-edited config carries: comments, key order, a sibling setting nothing
 * here knows the name of. See CLAUDE.md's "eat one user's config and the
 * tool is dead."
 */
const OriginalWindowsTerminalSnapshotSchema = z.object({
  settingsPath: z.string().min(1),
  settingsText: z.string(),
});

const OriginalOhMyPoshDiscoveredConfigSchema = z.object({
  path: z.string().min(1),
  text: z.string(),
});

const OriginalOhMyPoshSnapshotSchema = z.object({
  profilePath: z.string().min(1),
  profileText: z.string(),
  /** Whether the profile file existed at all before Chameleon's first apply — a profile it created from nothing (see CHM-39) must be deleted on restore, not left behind holding an empty string. */
  didProfileExist: z.boolean(),
  /** The config `oh-my-posh init` named before Chameleon ever seeded its own owned copy from it (see ensureOhMyPoshOwnedConfigSeeded) — undefined when none was discoverable yet. */
  discoveredConfig: OriginalOhMyPoshDiscoveredConfigSchema.optional(),
});

const OriginalHerdrSnapshotSchema = z.object({
  configPath: z.string().min(1),
  configText: z.string(),
});

const OriginalClaudeCodeSnapshotSchema = z.object({
  settingsPath: z.string().min(1),
  settingsText: z.string(),
});

const OriginalSnapshotSchema = z.object({
  capturedAtMs: z.number(),
  windowsTerminal: OriginalWindowsTerminalSnapshotSchema.optional(),
  ohMyPosh: OriginalOhMyPoshSnapshotSchema.optional(),
  herdr: OriginalHerdrSnapshotSchema.optional(),
  claudeCode: OriginalClaudeCodeSnapshotSchema.optional(),
});

export type OriginalSnapshot = z.infer<typeof OriginalSnapshotSchema>;

/** File name of the snapshot `captureOriginalSnapshotIfMissing` writes and `readOriginalSnapshot`/`chm original` (index.ts's restoreOriginal) read — see platform.ts's stateDir. Chameleon's own state directory, never the user's own config directory: CLAUDE.md's "Stored in Chameleon's own state directory, not in the user's files." */
const ORIGINAL_SNAPSHOT_FILE_NAME = "original-snapshot.json";

export function defaultOriginalSnapshotPath(): string {
  return path.join(stateDir(), ORIGINAL_SNAPSHOT_FILE_NAME);
}

/**
 * Writes `snapshot` to `snapshotPath` so that a crash partway through the
 * write can never leave a half-written file behind: the write lands on a
 * temporary path first, and only a single, atomic rename ever makes it visible
 * under `snapshotPath` itself. A process killed before the rename leaves
 * nothing at `snapshotPath` at all — exactly as if capture had not run yet —
 * so the next apply simply tries again, rather than ever reading back a
 * torn, half-written snapshot. This is the property CLAUDE.md's "must
 * survive ... a crash mid-write" rests on.
 */
function writeSnapshotAtomically(snapshotPath: string, snapshot: OriginalSnapshot): void {
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(snapshotPath), `.${path.basename(snapshotPath)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(temporaryPath, JSON.stringify(snapshot, null, 2), "utf8");
  renameSync(temporaryPath, snapshotPath);
}

/**
 * The snapshot already on disk, or undefined only when `snapshotPath` does
 * not exist at all — never for a file that exists but cannot be understood.
 * That distinction matters more here than for state.ts's own active-pack
 * pointer: this file is the one safety net CLAUDE.md's "eat one user's
 * config and the tool is dead" rests on, so a snapshot that exists but is
 * unreadable must say so loudly and stop, never be treated as "nothing was
 * ever captured" — reading that as "missing" would let a later apply
 * recapture over it, permanently losing whatever the real original was.
 */
export function readOriginalSnapshot(snapshotPath: string = defaultOriginalSnapshotPath()): OriginalSnapshot | undefined {
  if (!existsSync(snapshotPath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch (error) {
    throw new Error(`${snapshotPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const validated = OriginalSnapshotSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`${snapshotPath} is not an original snapshot Chameleon understands: ${validated.error.message}`);
  }
  return validated.data;
}

/**
 * The real path/shell resolution `captureOriginalSnapshotIfMissing` uses for
 * each target, exactly like every adapter's own `createXAdapter(path = real
 * default)` — bundled into one object here, rather than one default
 * parameter per target, because a test overriding one of these almost always
 * needs to override several at once, and a real caller (`chm`'s own apply
 * pipeline) never overrides any of them.
 */
export interface OriginalSnapshotCapturePaths {
  readonly windowsTerminalSettingsPath?: string | undefined;
  readonly ohMyPoshDetected?: boolean;
  readonly ohMyPoshShell?: Shell;
  readonly ohMyPoshProfilePath?: string;
  readonly herdrConfigPath?: string | undefined;
  readonly claudeCodeSettingsPath?: string;
}

function captureWindowsTerminalSnapshot(paths: OriginalSnapshotCapturePaths): z.infer<typeof OriginalWindowsTerminalSnapshotSchema> | undefined {
  const settingsPath = paths.windowsTerminalSettingsPath ?? defaultWindowsTerminalSettingsPath();
  if (!settingsPath || !existsSync(settingsPath)) return undefined;
  return { settingsPath, settingsText: readFileSync(settingsPath, "utf8") };
}

/**
 * Oh My Posh has no config path Chameleon can look up directly the way the
 * other three targets do (see platform.ts) — it is only ever detected by its
 * own binary being on PATH (createDefaultOhMyPoshAdapter's own `detect`), so
 * that is the gate here too: nothing worth restoring exists for a machine
 * that never had Oh My Posh installed in the first place. Captures the shell
 * profile Chameleon is about to write its init line into — verbatim, or an
 * absent-file marker when it does not exist yet, see CHM-39 — and whatever
 * config `oh-my-posh init` already named, before that config is ever copied
 * into Chameleon's own owned path (discoverPreOwnedOhMyPoshConfig).
 */
function captureOhMyPoshSnapshot(paths: OriginalSnapshotCapturePaths): z.infer<typeof OriginalOhMyPoshSnapshotSchema> | undefined {
  const isDetected = paths.ohMyPoshDetected ?? createDefaultOhMyPoshAdapter().detect();
  if (!isDetected) return undefined;

  const shell = paths.ohMyPoshShell ?? detectShell();
  const profilePath = paths.ohMyPoshProfilePath ?? ohMyPoshProfilePathFor(shell);
  const didProfileExist = existsSync(profilePath);
  const profileText = didProfileExist ? readFileSync(profilePath, "utf8") : "";
  const discoveredConfig = discoverPreOwnedOhMyPoshConfig(profilePath, shell);

  return { profilePath, profileText, didProfileExist, discoveredConfig };
}

function captureHerdrSnapshot(paths: OriginalSnapshotCapturePaths): z.infer<typeof OriginalHerdrSnapshotSchema> | undefined {
  const configPath = paths.herdrConfigPath ?? herdrConfigPath();
  if (!configPath || !existsSync(configPath)) return undefined;
  return { configPath, configText: readFileSync(configPath, "utf8") };
}

function captureClaudeCodeSnapshot(paths: OriginalSnapshotCapturePaths): z.infer<typeof OriginalClaudeCodeSnapshotSchema> | undefined {
  const settingsPath = paths.claudeCodeSettingsPath ?? claudeCodeSettingsPath();
  if (!existsSync(settingsPath)) return undefined;
  return { settingsPath, settingsText: readFileSync(settingsPath, "utf8") };
}

/**
 * Captures every surface Chameleon is about to theme, exactly as it stands
 * right now, unless a snapshot has already been captured — checked by plain
 * existence of `snapshotPath`, never by whether it parses. That is the one
 * guard CLAUDE.md's "never overwritten by a later apply" rests on: a
 * snapshot that exists but is somehow corrupt must still block a recapture,
 * because recapturing now would record Chameleon's *own* already-applied
 * colours as "the original" and destroy the one thing this file exists to
 * protect. A target that is not installed, or has nothing configured yet, is
 * simply left out of the snapshot (its section stays undefined) rather than
 * failing the capture for the targets that *are* there. A machine with
 * nothing configured at all produces a snapshot with every section
 * undefined — still written once, so a target installed later never
 * retroactively gets "captured" from a state Chameleon itself already
 * changed.
 *
 * Must run before any target is written to — see index.ts's applyThemePack,
 * the only real caller — so every one of the four captures above always
 * reads a file Chameleon has not touched yet. `capturePaths` is only ever
 * overridden by tests, which point every target at a fixture copy so nothing
 * here touches a real config; `chm` itself always reads the real ones.
 */
export function captureOriginalSnapshotIfMissing(
  snapshotPath: string = defaultOriginalSnapshotPath(),
  capturePaths: OriginalSnapshotCapturePaths = {},
): void {
  if (existsSync(snapshotPath)) return;

  const snapshot: OriginalSnapshot = {
    capturedAtMs: Date.now(),
    windowsTerminal: captureWindowsTerminalSnapshot(capturePaths),
    ohMyPosh: captureOhMyPoshSnapshot(capturePaths),
    herdr: captureHerdrSnapshot(capturePaths),
    claudeCode: captureClaudeCodeSnapshot(capturePaths),
  };

  writeSnapshotAtomically(snapshotPath, snapshot);
}

/** Backs a raw file write with the same directory-creation courtesy every adapter's own apply already extends to a config that might not exist yet — restoring must never fail merely because a parent directory was cleaned up since the snapshot was taken. */
function writeTextEnsuringDir(targetPath: string, text: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, text, "utf8");
}

/** Writes Windows Terminal's settings.json back exactly as snapshotted. Returns whether there was anything recorded to restore. */
export function restoreWindowsTerminalFromSnapshot(snapshot: OriginalSnapshot): boolean {
  if (!snapshot.windowsTerminal) return false;
  writeTextEnsuringDir(snapshot.windowsTerminal.settingsPath, snapshot.windowsTerminal.settingsText);
  return true;
}

/**
 * Restores the shell profile to exactly what it was before Chameleon ever
 * wrote an init line into it — deleting it outright when it did not exist at
 * all beforehand, rather than leaving a file behind holding an empty string
 * — and, when one was discoverable, the config `oh-my-posh init` named at the
 * time, so the profile's own (restored) init line and the config it points
 * at agree again. Returns whether there was anything recorded to restore.
 */
export function restoreOhMyPoshFromSnapshot(snapshot: OriginalSnapshot): boolean {
  if (!snapshot.ohMyPosh) return false;
  const { profilePath, profileText, didProfileExist, discoveredConfig } = snapshot.ohMyPosh;

  if (didProfileExist) {
    writeTextEnsuringDir(profilePath, profileText);
  } else {
    rmSync(profilePath, { force: true });
  }
  if (discoveredConfig) {
    writeTextEnsuringDir(discoveredConfig.path, discoveredConfig.text);
  }
  return true;
}

/** Writes Herdr's config.toml back exactly as snapshotted. Returns whether there was anything recorded to restore. */
export function restoreHerdrFromSnapshot(snapshot: OriginalSnapshot): boolean {
  if (!snapshot.herdr) return false;
  writeTextEnsuringDir(snapshot.herdr.configPath, snapshot.herdr.configText);
  return true;
}

/** Writes Claude Code's settings.json back exactly as snapshotted — theme and statusLine both, since both are captured as part of the same raw file. Returns whether there was anything recorded to restore. */
export function restoreClaudeCodeFromSnapshot(snapshot: OriginalSnapshot): boolean {
  if (!snapshot.claudeCode) return false;
  writeTextEnsuringDir(snapshot.claudeCode.settingsPath, snapshot.claudeCode.settingsText);
  return true;
}
