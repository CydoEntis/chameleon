import { spawnSync } from "node:child_process";

/**
 * The current branch of the git repository containing `cwd`, or undefined
 * when `cwd` is not inside a git repository, git itself is not on PATH, or
 * the repository is in a detached-HEAD state with no branch name to give.
 * Not a themeable target of its own — `ch` never themes git — this is a data
 * source `chm statusline` reads the same way Claude Code's own documented
 * status line scripts do (see CHM-68): `git branch --show-current`, run in
 * `cwd`, printing nothing when there is no current branch.
 */
export function currentGitBranch(cwd: string): string | undefined {
  const result = spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;

  const branchName = result.stdout.trim();
  return branchName === "" ? undefined : branchName;
}
