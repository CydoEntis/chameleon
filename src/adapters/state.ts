import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { stateDir } from "./platform.js";

/** File name of the pointer `ch <slug>` writes and `ch current`, `ch next` and `ch dark`/`ch light` all read. */
const ACTIVE_PACK_FILE_NAME = "active-pack.json";

const ActivePackStateSchema = z.object({
  slug: z.string().min(1),
  updatedAtMs: z.number(),
});

export type ActivePackState = z.infer<typeof ActivePackStateSchema>;

/** Where `ch` records which pack it last applied — see platform.ts's stateDir. */
export function defaultActivePackStatePath(): string {
  return path.join(stateDir(), ACTIVE_PACK_FILE_NAME);
}

/**
 * The pack `ch` last successfully applied, or undefined when nothing has
 * been applied yet, or the state file cannot be read — either way, "nothing
 * recorded" rather than a thrown error, since a missing or corrupted pointer
 * must never stop `ch current`, `ch next` or `ch dark`/`ch light` from doing
 * something sensible.
 */
export function readActivePackState(statePath: string = defaultActivePackStatePath()): ActivePackState | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    const validated = ActivePackStateSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

/** Records `slug` as the pack `ch` most recently applied, timestamped now. */
export function writeActivePackState(slug: string, statePath: string = defaultActivePackStatePath()): void {
  mkdirSync(path.dirname(statePath), { recursive: true });
  const state: ActivePackState = { slug, updatedAtMs: Date.now() };
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

// --- CHM-86: whether Chameleon manages Claude Code's statusLine ------------
//
// A lifecycle choice, not a config value — it belongs beside active-pack.json
// in Chameleon's own state, never in the user's settings.json, so `chm
// statusline off` survives every later apply without ever touching a file the
// user owns. See adapters/claude-code.ts's ensureStatusLineConfigured, which
// is the only reader that also decides this on a machine's first apply.

/** File name of the record `ensureStatusLineConfigured`, `chm statusline on`/`off` and `chm doctor` all read or write — see platform.ts's stateDir. */
const STATUSLINE_STATE_FILE_NAME = "statusline-state.json";

const StatuslineStateSchema = z.object({
  isEnabled: z.boolean(),
});

export type StatuslineState = z.infer<typeof StatuslineStateSchema>;

/** Where `ch` records whether it currently manages Claude Code's statusLine. */
export function defaultStatuslineStatePath(): string {
  return path.join(stateDir(), STATUSLINE_STATE_FILE_NAME);
}

/**
 * Chameleon's own recorded choice for whether it manages the statusLine, or
 * undefined when no choice has ever been recorded — the case a machine's
 * first apply resolves for itself (see claude-code.ts's
 * ensureStatusLineConfigured). A file that exists but cannot be understood is
 * treated the same as missing, the same "report the fact, never throw"
 * contract readActivePackState already follows for its own state file.
 */
export function readStatuslineState(statePath: string = defaultStatuslineStatePath()): StatuslineState | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    const validated = StatuslineStateSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records `isEnabled` as Chameleon's own choice for whether it manages the
 * statusLine — `chm statusline on`/`off`'s explicit request, or the decision
 * a machine's first apply makes for itself when nothing has been recorded
 * yet.
 */
export function writeStatuslineState(isEnabled: boolean, statePath: string = defaultStatuslineStatePath()): void {
  mkdirSync(path.dirname(statePath), { recursive: true });
  const state: StatuslineState = { isEnabled };
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}
