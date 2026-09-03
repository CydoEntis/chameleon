import { createScanner, findNodeAtLocation, parseTree, type JSONPath, type Node } from "jsonc-parser";

/**
 * Every edit any adapter makes to a JSONC config is wrapped in this pair, so
 * a rerun can find and replace its own work, and a human can see at a glance
 * what Chameleon owns. Shared across adapters so two config files never
 * disagree on what a Chameleon-owned block looks like.
 */
const MARKER_BEGIN = "// ch:begin";
const MARKER_END = "// ch:end";

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

/**
 * Whether `container`'s own content already starts with Chameleon's marker
 * — i.e. the last apply's marked block is already the first thing inside
 * this container, rather than a plain key the user wrote.
 */
function containerOwnsMarkedBlock(text: string, container: Node): boolean {
  const start = container.offset + 1;
  const end = container.offset + container.length - 1;
  return text.slice(start, end).trimStart().startsWith(MARKER_BEGIN);
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
 */
function removeNodeFromContainer(text: string, container: Node, node: Node): string {
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
export function dedupeConflict(text: string, container: Node, conflict: Node | undefined): string {
  if (!conflict || containerOwnsMarkedBlock(text, container)) {
    return text;
  }
  return removeNodeFromContainer(text, container, conflict);
}

/**
 * Inserts `ownedContent` just inside `container`'s opening bracket, wrapped
 * in ch:begin/ch:end. If Chameleon's own marked block is already the first
 * thing in the container — from an earlier apply — only that block is
 * replaced; everything else in the file, including a user's own comments
 * and key order, never moves. This is what makes upserting a value and
 * applying the same theme twice idempotent: the same input always produces
 * the same marked block, and nothing outside it is ever touched.
 *
 * A trailing comma is added only when there is real content left after the
 * block — an empty array or object with nothing else in it must not gain a
 * dangling comma before the closing bracket.
 */
export function upsertMarkedBlock(text: string, container: Node, ownedContent: string, eol: string): string {
  const containerStart = container.offset + 1;
  const containerEnd = container.offset + container.length - 1;
  const hasExistingBlock = containerOwnsMarkedBlock(text, container);

  // Replacing an existing block removes it, the whitespace we left before
  // it, and the one line ending we left after it — all three are ours to
  // redraw — so this never leaves a stray blank line behind from one apply
  // to the next.
  const markerEndOffset = hasExistingBlock ? text.indexOf(MARKER_END, containerStart) : -1;
  const rightAfterMarkerEnd = markerEndOffset + MARKER_END.length;
  const afterBlockOffset = hasExistingBlock
    ? rightAfterMarkerEnd + (text.startsWith(eol, rightAfterMarkerEnd) ? eol.length : 0)
    : containerStart;

  const hasContentAfterBlock = text.slice(afterBlockOffset, containerEnd).trim().length > 0;
  const separator = hasContentAfterBlock ? "," : "";
  // MARKER_END is always followed by a line ending of our own — `//` is a
  // line comment, so without one it would silently swallow whatever the
  // original file put right after the container's opening bracket.
  const replacement = `${eol}${INSERTED_BLOCK_INDENT}${MARKER_BEGIN}${eol}${ownedContent}${separator}${eol}${INSERTED_BLOCK_INDENT}${MARKER_END}${eol}`;

  return text.slice(0, containerStart) + replacement + text.slice(afterBlockOffset);
}
