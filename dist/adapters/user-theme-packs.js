import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildThemePack, parseUserPackManifest } from "../palette/theme-pack.js";
import { stateDir } from "./platform.js";
/** Sub-directory of the state directory a user drops their own pack directories into. */
const USER_THEMES_DIR_NAME = "themes";
/** File name a pack directory must contain for the loader to find it. */
const PACK_MANIFEST_FILE_NAME = "pack.json";
/** Where `ch` looks for user-dropped packs: `<chameleon state dir>/themes/<pack>/pack.json` — see platform.ts's stateDir. */
export function defaultUserThemePackDir() {
    return path.join(stateDir(), USER_THEMES_DIR_NAME);
}
/**
 * Reads one pack sub-directory. A missing manifest, invalid JSON, a manifest
 * that fails UserPackManifestSchema, or a scheme that still cannot clear its
 * floor after repair all become a named warning rather than a thrown error,
 * so one bad pack never stops the others loading.
 *
 * A manifest that declares no `slug` still gets one — derived from its
 * family and measured appearance, the same way a bundled pack's is — but
 * that derivation is reported as a warning rather than done silently, since
 * a silently derived slug is exactly what let CHM-12's loader accept a
 * pack.json declaring one slug and quietly load it under another.
 */
function readPackDirectory(packDirPath, packDirName) {
    const manifestPath = path.join(packDirPath, PACK_MANIFEST_FILE_NAME);
    if (!existsSync(manifestPath)) {
        return { warning: `user pack "${packDirName}" has no ${PACK_MANIFEST_FILE_NAME}, skipping` };
    }
    try {
        const rawJson = JSON.parse(readFileSync(manifestPath, "utf8"));
        const manifest = parseUserPackManifest(rawJson, packDirName);
        const pack = buildThemePack(manifest.scheme, manifest.family ?? manifest.scheme.name, undefined, manifest.slug);
        if (manifest.slug === undefined) {
            return {
                pack,
                warning: `user pack "${packDirName}" declares no slug, deriving "${pack.manifest.slug}" from its family and appearance`,
            };
        }
        return { pack };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { warning: `user pack "${packDirName}" is malformed: ${reason}` };
    }
}
/**
 * Reads every pack a user has dropped into their own theme directory — one
 * sub-directory per pack, each holding a pack.json naming the scheme it
 * adapts. Every pack is run through buildThemePack, the exact pipeline the
 * bundled packs are generated with, so a dropped-in theme clears the same
 * contrast floors a bundled one does — see CLAUDE.md, "User packs are held
 * to the same contrast floors as bundled ones."
 *
 * A missing directory means no user packs exist yet, not an error — this is
 * read on every `ch` invocation, including the first one, before anyone has
 * dropped anything in.
 */
export function loadUserThemePacks(themeDir = defaultUserThemePackDir()) {
    if (!existsSync(themeDir)) {
        return { packs: [], warnings: [] };
    }
    const packDirNames = readdirSync(themeDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    const packs = [];
    const warnings = [];
    for (const packDirName of packDirNames) {
        const result = readPackDirectory(path.join(themeDir, packDirName), packDirName);
        if ("pack" in result) {
            packs.push(result.pack);
            if (result.warning !== undefined)
                warnings.push(result.warning);
        }
        else {
            warnings.push(result.warning);
        }
    }
    return { packs, warnings };
}
//# sourceMappingURL=user-theme-packs.js.map