import { applyEdits, createScanner, findNodeAtLocation, modify, parseTree, type JSONPath, type Node } from "jsonc-parser";

/**
 * Every edit any adapter makes to a JSONC config is wrapped in this pair, so
 * a rerun can find and replace its own work, and a human can see at a glance
 * what Chameleon owns. Shared across adapters so two config files never
 * disagree on what a Chameleon-owned block looks like.
 *
 * `key` names which property the block belongs to — "palette", "blocks",
 * "colorScheme" — because a container can hold more than one Chameleon-owned
 * property (Oh My Posh's root carries both a palette and, once `ch edit` has
 * touched it, a blocks array) and each needs its own marker pair to be found
 * and replaced without disturbing its sibling's.
 */
function markerBegin(key: string): string {
  return `// ch:begin ${key}`;
}

function markerEnd(key: string): string {
  return `// ch:end ${key}`;
}

/**
 * Indentation given to a freshly inserted marked block. Cosmetic only —
 * JSON does not care, and this does not try to match a file's own indent
 * style.
 */
export const INSERTED_BLOCK_INDENT = "    ";

export const CRLF = "\r\n";
export const LF = "\n";

/**
 * jsonc-parser's `SyntaxKind.CommaToken`. `SyntaxKind` is a `const enum`,
 * which this project's `verbatimModuleSyntax` forbids importing — it can
 * only be inlined by a compiler that sees the enum's own declaration, and
 * ambient `.d.ts` types do not qualify. The numeric value is fixed by
 * jsonc-parser's public API, not a tuning knob.
 */
const COMMA_TOKEN = 5;

/**
 * The line ending already dominant in `text`. A tool's own writer may use
 * CRLF unconditionally, but a user's editor may have normalised a file to
 * LF (or vice versa). Every line an adapter writes must match whichever the
 * file already uses — see CHM-3, which hardcoded "\n" and stripped the
 * carriage return from the line it spliced into a CRLF file.
 */
export function detectLineEnding(text: string): string {
  return text.includes(CRLF) ? CRLF : LF;
}

/** Parses `text` as JSONC, tolerating trailing commas. Throws naming `sourcePath` when the text is not valid JSON at all. */
export function parseJsonTree(sourcePath: string, text: string): Node {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  if (!tree) {
    throw new Error(`${sourcePath} could not be parsed as JSON`);
  }
  return tree;
}

/** The `property` node — key, colon and value — for `key` directly inside `container`, or undefined if it carries no such key. */
export function findPropertyNode(container: Node, key: string): Node | undefined {
  return container.children?.find(
    (child) => child.type === "property" && child.children?.[0]?.value === key,
  );
}

/** Convenience wrapper over `findNodeAtLocation` that also asserts the node's JSON kind, throwing naming `sourcePath` and `description` when it is missing or the wrong shape. */
export function requireNode(
  sourcePath: string,
  tree: Node,
  jsonPath: JSONPath,
  type: Node["type"],
  description: string,
): Node {
  const node = findNodeAtLocation(tree, jsonPath);
  if (!node || node.type !== type) {
    throw new Error(`${sourcePath} is missing ${description}`);
  }
  return node;
}

/**
 * Renders `value` as the multi-line JSON literal an array expects for one
 * of its own entries, indented so it reads as one entry among siblings
 * rather than flush against the array's own indent level.
 */
export function buildArrayEntryBlockContent(value: unknown, eol: string): string {
  return JSON.stringify(value, null, 2)
    .split(LF)
    .map((line) => `${INSERTED_BLOCK_INDENT}${line}`)
    .join(eol);
}

/**
 * Renders `"key": value` as the property an object expects among its own
 * siblings. `value` may be a primitive (one line) or an object/array
 * (indented under the key, same shape as `buildArrayEntryBlockContent`).
 */
export function buildPropertyBlockContent(key: string, value: unknown, eol: string): string {
  const [firstLine, ...restLines] = JSON.stringify(value, null, 2).split(LF);
  const indentedFirstLine = `${INSERTED_BLOCK_INDENT}${JSON.stringify(key)}: ${firstLine}`;
  return [indentedFirstLine, ...restLines.map((line) => `${INSERTED_BLOCK_INDENT}${line}`)].join(eol);
}

/** One Chameleon-owned marked block already inside a container: which property it belongs to, and the full span — its own begin-marker line through its own end-marker line, line endings included. */
interface MarkedBlockSpan {
  readonly key: string;
  readonly startOffset: number;
  readonly endOffsetInclusive: number;
}

/**
 * Whether `offset` falls inside one of `container`'s own children — i.e. a
 * marker found there belongs to a block nested in a deeper container (an
 * array element, a nested object's own property) and is not one of
 * `container`'s own direct siblings.
 */
function isInsideChild(container: Node, offset: number): boolean {
  return (container.children ?? []).some((child) => offset >= child.offset && offset < child.offset + child.length);
}

/**
 * Every Chameleon-owned marked block directly inside `container` — never one
 * belonging to a nested container that happens to sit within the same text
 * range, such as the "scheme" entry marker living inside root's own
 * "schemes" array — in document order. jsonc-parser does not expose
 * comments as AST nodes, so finding these is necessarily a text scan for
 * the marker comments themselves, not a walk over parsed properties; the
 * child-range check is what keeps that scan from wandering into a
 * descendant container's own markers.
 */
function ownedBlockSpans(text: string, container: Node): MarkedBlockSpan[] {
  const containerStart = container.offset + 1;
  const containerEnd = container.offset + container.length - 1;
  const beginPattern = /\/\/ ch:begin (\S+)/g;
  const spans: MarkedBlockSpan[] = [];

  for (const match of text.slice(containerStart, containerEnd).matchAll(beginPattern)) {
    const key = match[1];
    if (key === undefined || match.index === undefined) continue;
    const beginOffset = containerStart + match.index;
    if (isInsideChild(container, beginOffset)) continue;
    const endTokenOffset = text.indexOf(markerEnd(key), beginOffset);
    if (endTokenOffset === -1 || endTokenOffset >= containerEnd) {
      throw new Error(`a ${markerBegin(key)} marker has no matching ${markerEnd(key)} — refusing to guess where Chameleon's block ends`);
    }
    spans.push({
      key,
      startOffset: lineStartOffset(text, beginOffset),
      endOffsetInclusive: lineEndOffsetInclusive(text, endTokenOffset),
    });
  }
  return spans;
}

/** Whether `container` already carries a Chameleon-owned marked block for `key` — i.e. a rerun should replace that block in place, rather than dedupe a plain key the user wrote. */
function containerOwnsMarkedBlock(text: string, container: Node, key: string): boolean {
  return ownedBlockSpans(text, container).some((span) => span.key === key);
}

/**
 * The offset of the next comma token after `offset`, skipping whitespace
 * and comments — or null when the next real token is not a comma, i.e.
 * `offset` sits right before the container's closing bracket.
 */
function commaOffsetAfter(text: string, offset: number): number | null {
  const scanner = createScanner(text, true);
  scanner.setPosition(offset);
  return scanner.scan() === COMMA_TOKEN ? scanner.getTokenOffset() : null;
}

/** The offset right after the newline nearest at-or-before `offset` — i.e. where `offset`'s own line begins. */
function lineStartOffset(text: string, offset: number): number {
  const precedingNewline = text.lastIndexOf(LF, offset - 1);
  return precedingNewline === -1 ? 0 : precedingNewline + 1;
}

/** The offset right after the newline nearest at-or-after `offset` — i.e. where `offset`'s own line ends, newline included. */
function lineEndOffsetInclusive(text: string, offset: number): number {
  const followingNewline = text.indexOf(LF, offset);
  return followingNewline === -1 ? text.length : followingNewline + 1;
}

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
export function removeNodeFromContainer(text: string, container: Node, node: Node): string {
  const siblings = container.children ?? [];
  const index = siblings.indexOf(node);
  const previousSibling = index > 0 ? siblings[index - 1] : undefined;

  // Deleting whole lines — from the start of `node`'s own first line
  // through the end of its own last line — is what keeps a sibling's
  // trailing same-line comment out of the blast radius: that comment
  // reads, lexically, as trivia in the *next* sibling's leading gap, not
  // as part of the sibling it actually annotates.
  const withoutNode =
    text.slice(0, lineStartOffset(text, node.offset)) + text.slice(lineEndOffsetInclusive(text, node.offset + node.length));

  if (commaOffsetAfter(text, node.offset + node.length) !== null || !previousSibling) {
    // Either a sibling still follows `node` (its own comma left with its
    // own line, nothing else needs touching), or `node` had no previous
    // sibling to leave a dangling comma behind.
    return withoutNode;
  }

  // `node` was the container's last child: the previous sibling's own
  // trailing comma is now dangling before the closing bracket and has to
  // go too — but nothing else on that sibling's line does.
  const leadingComma = commaOffsetAfter(withoutNode, previousSibling.offset + previousSibling.length);
  if (leadingComma === null) {
    return withoutNode;
  }
  return withoutNode.slice(0, leadingComma) + withoutNode.slice(leadingComma + 1);
}

/**
 * Removes `conflict` from `container` when it is a plain entry the user
 * already had — not Chameleon's own marked block. A container Chameleon
 * already owns is left alone: a rerun means "replace my own block", never
 * "hunt for a duplicate". This is what makes applying to a file that
 * already carries a conflicting key leave exactly one of it, instead of the
 * silent no-op CHM-3's attempt 1 shipped — JSON resolves last-wins, and the
 * user's untouched original always came last.
 */
export function dedupeConflict(text: string, container: Node, conflict: Node | undefined, key: string): string {
  if (!conflict || containerOwnsMarkedBlock(text, container, key)) {
    return text;
  }
  return removeNodeFromContainer(text, container, conflict);
}

/**
 * Restores a comma right after `lastSpan`'s own JSON property value, in
 * `text`, when one is not already there — CHM-74's own latent bug:
 * `lastSpan`'s own trailing comma was decided when *it* was written, based
 * on whatever followed it *then*. When that block owns the very last
 * property in `container` and something this same overall edit is about to
 * dedupe and replace used to sit right after it, that comma can already be
 * gone by the time a sibling key's own upsertMarkedBlock call runs — see
 * removeNodeFromContainer's own "previous sibling's trailing comma is now
 * dangling" cleanup, which has no way to know a sibling block is about to
 * land right back there. `text` is returned unchanged when `lastSpan` is
 * undefined (nothing precedes the block about to be appended) or the comma
 * is already there.
 *
 * Inserted right after the real JSON value, never after the `// ch:end`
 * marker's own comment text — a comma placed after a `//` comment is not a
 * token at all, just more comment.
 */
function withLeadingCommaRestored(text: string, container: Node, lastSpan: MarkedBlockSpan | undefined): string {
  if (!lastSpan) return text;
  const lastKeyProperty = findPropertyNode(container, lastSpan.key);
  if (!lastKeyProperty) return text;
  const propertyEndOffset = lastKeyProperty.offset + lastKeyProperty.length;
  if (commaOffsetAfter(text, propertyEndOffset) !== null) return text;
  return `${text.slice(0, propertyEndOffset)},${text.slice(propertyEndOffset)}`;
}

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
export function upsertMarkedBlock(text: string, container: Node, ownedContent: string, eol: string, key: string): string {
  const spans = ownedBlockSpans(text, container);
  const existingSpan = spans.find((span) => span.key === key);
  const lastSpan = spans[spans.length - 1];
  const workingText = existingSpan ? text : withLeadingCommaRestored(text, container, lastSpan);
  const insertedCommaLength = workingText.length - text.length;

  const containerStart = container.offset + 1;
  const containerEnd = container.offset + container.length - 1 + insertedCommaLength;
  const lastSpanEndOffsetInclusive = lastSpan !== undefined ? lastSpan.endOffsetInclusive + insertedCommaLength : undefined;

  // Replacing an existing block removes it, and only it, in place. A brand
  // new block is inserted right after the last block this container already
  // owns — so a second Chameleon-owned property never collides with the
  // first's — or at the very start when the container owns none yet.
  //
  // Every splice point below except the very-first-block case sits right
  // after an eol Chameleon itself wrote — the one trailing the block being
  // replaced, or the one trailing whichever block currently comes last. That
  // eol is consumed here (`- eol.length`) and regenerated by `replacement`'s
  // own leading eol below, so neither replacing nor appending a block ever
  // leaves a blank line in its wake.
  const replaceStart = existingSpan
    ? existingSpan.startOffset - eol.length
    : lastSpanEndOffsetInclusive !== undefined
      ? lastSpanEndOffsetInclusive - eol.length
      : containerStart;
  const replaceEnd = existingSpan ? existingSpan.endOffsetInclusive : (lastSpanEndOffsetInclusive ?? containerStart);

  const hasContentAfterBlock = workingText.slice(replaceEnd, containerEnd).trim().length > 0;
  const separator = hasContentAfterBlock ? "," : "";
  // The end marker is always followed by a line ending of our own — `//` is
  // a line comment, so without one it would silently swallow whatever
  // originally followed the block's own position.
  const replacement = `${eol}${INSERTED_BLOCK_INDENT}${markerBegin(key)}${eol}${ownedContent}${separator}${eol}${INSERTED_BLOCK_INDENT}${markerEnd(key)}${eol}`;

  return workingText.slice(0, replaceStart) + replacement + workingText.slice(replaceEnd);
}

/**
 * Indent width given to a root-level property freshly inserted by
 * setUnmarkedTopLevelProperty, when the file did not already carry that key
 * — cosmetic only, the same "does not try to match a file's own indent
 * style" contract INSERTED_BLOCK_INDENT carries for a marked block. Two
 * spaces, not INSERTED_BLOCK_INDENT's four, because a root-level property
 * sits one level shallower than a marked block always does.
 */
const UNMARKED_INSERT_INDENT_WIDTH = 2;

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
export function setUnmarkedTopLevelProperty(sourcePath: string, text: string, key: string, value: unknown): string {
  const root = parseJsonTree(sourcePath, text);
  if (root.type !== "object") {
    throw new Error(`${sourcePath}'s root is not a JSON object`);
  }

  const eol = detectLineEnding(text);
  const edits = modify(text, [key], value, {
    formattingOptions: { insertSpaces: true, tabSize: UNMARKED_INSERT_INDENT_WIDTH, eol },
  });
  return applyEdits(text, edits);
}
