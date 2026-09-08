import { type JSONPath, type Node } from "jsonc-parser";
/**
 * Indentation given to a freshly inserted marked block. Cosmetic only —
 * JSON does not care, and this does not try to match a file's own indent
 * style.
 */
export declare const INSERTED_BLOCK_INDENT = "    ";
export declare const CRLF = "\r\n";
export declare const LF = "\n";
/**
 * The line ending already dominant in `text`. A tool's own writer may use
 * CRLF unconditionally, but a user's editor may have normalised a file to
 * LF (or vice versa). Every line an adapter writes must match whichever the
 * file already uses — see CHM-3, which hardcoded "\n" and stripped the
 * carriage return from the line it spliced into a CRLF file.
 */
export declare function detectLineEnding(text: string): string;
/** Parses `text` as JSONC, tolerating trailing commas. Throws naming `sourcePath` when the text is not valid JSON at all. */
export declare function parseJsonTree(sourcePath: string, text: string): Node;
/** The `property` node — key, colon and value — for `key` directly inside `container`, or undefined if it carries no such key. */
export declare function findPropertyNode(container: Node, key: string): Node | undefined;
/** Convenience wrapper over `findNodeAtLocation` that also asserts the node's JSON kind, throwing naming `sourcePath` and `description` when it is missing or the wrong shape. */
export declare function requireNode(sourcePath: string, tree: Node, jsonPath: JSONPath, type: Node["type"], description: string): Node;
/**
 * Renders `value` as the multi-line JSON literal an array expects for one
 * of its own entries, indented so it reads as one entry among siblings
 * rather than flush against the array's own indent level.
 */
export declare function buildArrayEntryBlockContent(value: unknown, eol: string): string;
/**
 * Renders `"key": value` as the property an object expects among its own
 * siblings. `value` may be a primitive (one line) or an object/array
 * (indented under the key, same shape as `buildArrayEntryBlockContent`).
 */
export declare function buildPropertyBlockContent(key: string, value: unknown, eol: string): string;
/**
 * Removes `node` — a property of an object or an element of an array — from
 * `text`, along with exactly the one comma separating it from its
 * siblings. Only the span `node` and that one comma occupy is touched, so a
 * neighbour's own indentation and any comment attached to it survive
 * untouched: a naive removal that reformats whatever happens to sit next to
 * the edit is the same class of bug that shipped CHM-3 broken.
 *
 * Exported alongside `dedupeConflict`'s own use of it: windows-terminal.ts's
 * dead-scheme-fork cleanup (CHM-91) also needs to drop one array element in
 * place, without touching a marked block or dedupe's own "container already
 * owns this" logic.
 */
export declare function removeNodeFromContainer(text: string, container: Node, node: Node): string;
/**
 * Removes `conflict` from `container` when it is a plain entry the user
 * already had — not Chameleon's own marked block. A container Chameleon
 * already owns is left alone: a rerun means "replace my own block", never
 * "hunt for a duplicate". This is what makes applying to a file that
 * already carries a conflicting key leave exactly one of it, instead of the
 * silent no-op CHM-3's attempt 1 shipped — JSON resolves last-wins, and the
 * user's untouched original always came last.
 */
export declare function dedupeConflict(text: string, container: Node, conflict: Node | undefined, key: string): string;
/**
 * Upserts `ownedContent` as `key`'s own marked block inside `container`,
 * wrapped in ch:begin/ch:end. A block already owned by `key` is replaced in
 * place; a brand new one is appended right after whichever Chameleon-owned
 * block currently sits last, or just inside `container`'s opening bracket
 * when this is the first block ever written there. Either way, everything
 * else in the file — a user's own comments, key order, and any other
 * property `key` this container already owns — never moves. This is what
 * makes upserting a value and applying the same theme twice idempotent: the
 * same input always produces the same marked block, and nothing outside it
 * is ever touched.
 *
 * A trailing comma is added only when there is real content left after the
 * block — an empty array or object with nothing else in it must not gain a
 * dangling comma before the closing bracket. Appending (rather than
 * replacing in place) first restores a missing comma after whichever block
 * currently comes last, when one is needed — see withLeadingCommaRestored.
 */
export declare function upsertMarkedBlock(text: string, container: Node, ownedContent: string, eol: string, key: string): string;
/**
 * Sets root-level `key` to `value` in place, with no ch:begin/ch:end wrapper
 * at all — the shape a config whose own parser rejects any comment needs.
 * Claude Code's settings.json is exactly that: wrapping the edit in
 * Chameleon's usual markers made its parser discard the entire file rather
 * than skip the one comment it did not recognise (see CHM-51). This is for a
 * target proven not to tolerate a `//` comment anywhere in the document —
 * `upsertMarkedBlock` remains correct for every target that does.
 *
 * jsonc-parser's own `modify` computes the minimal edit for `key` alone:
 * replacing just the existing value's own span when `key` is already
 * present — any trailing comment on that same line survives, since only the
 * value token is touched — or inserting one new property, in the file's own
 * line ending, when it is not. Every other byte in the document, a user's
 * own comments elsewhere included, is untouched.
 *
 * There is no marker left behind for a rerun to find, so there is nothing to
 * dedupe: this always simply sets `key` to `value`, which already is the
 * idempotent, no-growth result a marked block gives for a single scalar
 * property. A target that needs to know whether its own last write still
 * matches a pack does that by comparing values directly — see
 * claudeCodeMatchesAppearance — against whichever pack the active-pack state
 * file recorded (CHM-27), not by looking for a marker in this file.
 */
export declare function setUnmarkedTopLevelProperty(sourcePath: string, text: string, key: string, value: unknown): string;
