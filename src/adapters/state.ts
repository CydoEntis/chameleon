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
