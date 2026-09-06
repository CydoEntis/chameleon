import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Walks upward from `startDir` looking for a `.git` entry — a directory for
 * an ordinary repository, or a file for a linked worktree (see
 * resolveGitDir) — the same walk `git` itself does to find a repository
 * root. Undefined once the walk reaches the filesystem root without finding
 * one: `startDir` is not inside a git repository at all.
 */
function findDotGitPath(startDir: string): string | undefined {
  let currentDir = startDir;
  for (;;) {
    const candidatePath = path.join(currentDir, ".git");
    if (existsSync(candidatePath)) return candidatePath;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return undefined;
    currentDir = parentDir;
  }
}

/** `gitdir: <path>`'s own path, resolved against `dotGitFile`'s directory when it is relative — a linked worktree's own `.git` file always points with a path relative to itself. */
function resolveWorktreeGitDir(dotGitFile: string, contents: string): string | undefined {
  const match = /^gitdir: (.+)$/.exec(contents);
  if (!match) return undefined;

  const gitDirPath = match[1]!;
  return path.isAbsolute(gitDirPath) ? gitDirPath : path.resolve(path.dirname(dotGitFile), gitDirPath);
}

/**
 * The real git directory `dotGitPath` names — itself, when it is already a
 * directory, or the target of a linked worktree's own "gitdir:" indirection
 * when it is a file (see git-worktree(1): a worktree's own `.git` is never a
 * directory). Undefined for a `.git` file in a format this does not
 * recognise, rather than guessing.
 */
function resolveGitDir(dotGitPath: string): string | undefined {
  if (statSync(dotGitPath).isDirectory()) return dotGitPath;
  return resolveWorktreeGitDir(dotGitPath, readFileSync(dotGitPath, "utf8").trim());
}

/** The branch `HEAD` (inside `gitDir`) names, or undefined for a detached HEAD — a raw commit SHA rather than a `ref:` line — since there is no branch name to give. */
function readHeadBranch(gitDir: string): string | undefined {
  const headContents = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  const match = /^ref: refs\/heads\/(.+)$/.exec(headContents);
  return match?.[1];
}

/**
 * The current branch of the git repository containing `cwd`, or undefined
 * when `cwd` is not inside a git repository, or the repository is in a
 * detached-HEAD state with no branch name to give. Reads `.git` directly —
 * walking up for the repository root and following a linked worktree's own
 * "gitdir:" indirection — rather than spawning `git` itself: `chm
 * statusline` calls this on every repaint, and CHM-83's own reporter measured
 * shelling out to git at ~30ms each time, the same cost the reporter's own
 * ~/.claude/statusline.js already avoided this same way.
 */
export function currentGitBranch(cwd: string): string | undefined {
  try {
    const dotGitPath = findDotGitPath(cwd);
    if (!dotGitPath) return undefined;

    const gitDir = resolveGitDir(dotGitPath);
    if (!gitDir) return undefined;

    return readHeadBranch(gitDir);
  } catch {
    return undefined;
  }
}
