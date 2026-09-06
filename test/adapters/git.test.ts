import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentGitBranch } from "../../src/adapters/git.js";

/** Runs a real git command in `cwd`, failing the test loudly if it does not exit 0 — setup only, never the behaviour under test. */
function runGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
}

describe("currentGitBranch", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(tmpdir(), "chameleon-git-branch-"));
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("names the checked-out branch of a real git repository", () => {
    runGit(repoDir, ["init", "--initial-branch=feature-xyz"]);
    runGit(repoDir, ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "--allow-empty", "-m", "initial"]);

    expect(currentGitBranch(repoDir)).toBe("feature-xyz");
  });

  it("follows a branch switch — the same live read `chm statusline` needs on every invocation", () => {
    runGit(repoDir, ["init", "--initial-branch=main"]);
    runGit(repoDir, ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "--allow-empty", "-m", "initial"]);
    runGit(repoDir, ["checkout", "-b", "other-branch"]);

    expect(currentGitBranch(repoDir)).toBe("other-branch");
  });

  it("returns undefined for a directory that is not a git repository at all", () => {
    expect(currentGitBranch(repoDir)).toBeUndefined();
  });

  it("returns undefined for a detached HEAD — checked out at a commit, on no branch at all", () => {
    runGit(repoDir, ["init", "--initial-branch=main"]);
    runGit(repoDir, ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "--allow-empty", "-m", "initial"]);
    runGit(repoDir, ["checkout", "--detach", "HEAD"]);

    expect(currentGitBranch(repoDir)).toBeUndefined();
  });

  it("returns undefined rather than throwing for a directory that does not even exist", () => {
    expect(currentGitBranch(path.join(repoDir, "does-not-exist"))).toBeUndefined();
  });

  // CHM-83: `chm statusline` reads .git directly rather than spawning git, and
  // must follow a linked worktree's own ".git" file — a "gitdir: <path>"
  // pointer, never a directory (git-worktree(1)) — to the real repository's
  // HEAD, the same as an ordinary checkout.
  it("follows a linked worktree's own gitdir indirection to the real repository's branch", () => {
    runGit(repoDir, ["init", "--initial-branch=main"]);
    runGit(repoDir, ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "--allow-empty", "-m", "initial"]);
    const worktreeDir = path.join(repoDir, "..", `${path.basename(repoDir)}-worktree`);
    try {
      runGit(repoDir, ["worktree", "add", "-b", "worktree-branch", worktreeDir]);
      expect(currentGitBranch(worktreeDir)).toBe("worktree-branch");
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("finds the repository root from a subdirectory, the same as `git branch --show-current` run there", () => {
    runGit(repoDir, ["init", "--initial-branch=main"]);
    runGit(repoDir, ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "--allow-empty", "-m", "initial"]);
    const subDir = path.join(repoDir, "nested", "deeper");
    mkdirSync(subDir, { recursive: true });

    expect(currentGitBranch(subDir)).toBe("main");
  });
});
