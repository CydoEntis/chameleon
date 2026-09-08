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
export declare function currentGitBranch(cwd: string): string | undefined;
