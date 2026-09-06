import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

  it("returns undefined rather than throwing when spawning git fails outright — a directory that does not even exist", () => {
    expect(currentGitBranch(path.join(repoDir, "does-not-exist"))).toBeUndefined();
  });
});
