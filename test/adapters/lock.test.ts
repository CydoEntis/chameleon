import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, currentLockHolder } from "../../src/adapters/lock.js";

let scratchDir: string;
let lockPath: string;

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(tmpdir(), "chameleon-lock-"));
  lockPath = path.join(scratchDir, "lock.json");
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

/** A pid guaranteed not to name a running process on this machine — every real pid is far smaller than this. */
const DEAD_PID = 2_147_483_000;

describe("acquireLock", () => {
  it("acquires a lock nothing else holds", () => {
    const result = acquireLock("chm themes", lockPath);
    expect(result.status).toBe("acquired");
  });

  it("creates the lock directory when it does not exist yet", () => {
    const nestedLockPath = path.join(scratchDir, "nested", "lock.json");
    const result = acquireLock("chm themes", nestedLockPath);
    expect(result.status).toBe("acquired");
  });

  it("records this process's own pid and the command it was acquired for", () => {
    acquireLock("chm dracula-dark", lockPath);
    const written: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(written).toMatchObject({ pid: process.pid, command: "chm dracula-dark" });
  });

  it("reports held, naming the holder, when a live process already holds it", () => {
    // process.ppid — this test's own parent process — is guaranteed alive for
    // the test's duration, and guaranteed not to be process.pid itself, which
    // is exactly the "someone else, still running" case this covers.
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, command: "chm themes", acquiredAtMs: Date.now() }), "utf8");

    const result = acquireLock("chm dracula-dark", lockPath);

    expect(result).toEqual({ status: "held", holder: { pid: process.ppid, command: "chm themes", acquiredAtMs: expect.any(Number) } });
  });

  // CHM-56's own acceptance criterion: a lock left by a killed process must
  // be treated as free by the next invocation, not require manual cleanup.
  it("treats a lock naming a pid that no longer exists as free", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, command: "chm themes", acquiredAtMs: Date.now() }), "utf8");

    const result = acquireLock("chm dracula-dark", lockPath);

    expect(result.status).toBe("acquired");
    const written: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(written).toMatchObject({ pid: process.pid, command: "chm dracula-dark" });
  });

  it("treats an unreadable lock file as free", () => {
    writeFileSync(lockPath, "{ not json", "utf8");

    const result = acquireLock("chm dracula-dark", lockPath);

    expect(result.status).toBe("acquired");
  });

  // The picker's own session lock (held from open to close) must let its own
  // debounced preview writes and its own final restore proceed without ever
  // reporting itself as the thing blocking it.
  it("is re-entrant: a second acquisition by the same process succeeds without disturbing the first", () => {
    const outer = acquireLock("chm themes", lockPath);
    expect(outer.status).toBe("acquired");

    const inner = acquireLock("chm themes preview", lockPath);
    expect(inner.status).toBe("acquired");

    const writtenBeforeInnerRelease: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (inner.status === "acquired") inner.release();
    const writtenAfterInnerRelease: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    // The nested release did not free the lock — it is still the outer session's.
    expect(writtenAfterInnerRelease).toEqual(writtenBeforeInnerRelease);
  });

  describe("release", () => {
    it("removes the lock file", () => {
      const result = acquireLock("chm themes", lockPath);
      if (result.status !== "acquired") throw new Error("unreachable");

      result.release();

      expect(acquireLock("chm dracula-dark", lockPath).status).toBe("acquired");
    });

    it("does nothing when another process has since taken the lock over", () => {
      const result = acquireLock("chm themes", lockPath);
      if (result.status !== "acquired") throw new Error("unreachable");

      // Simulate the lock having gone stale and been reclaimed by someone else.
      writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID + 1, command: "chm gruvbox-dark", acquiredAtMs: Date.now() }), "utf8");

      result.release();

      const stillThere: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
      expect(stillThere).toMatchObject({ pid: DEAD_PID + 1 });
    });
  });
});

describe("currentLockHolder", () => {
  it("is undefined when nothing has ever acquired the lock", () => {
    expect(currentLockHolder(lockPath)).toBeUndefined();
  });

  it("names the live process holding the lock", () => {
    acquireLock("chm themes", lockPath);
    expect(currentLockHolder(lockPath)).toMatchObject({ pid: process.pid, command: "chm themes" });
  });

  it("is undefined for a lock naming a pid that no longer exists — the same 'gone means free' rule acquireLock applies", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, command: "chm themes", acquiredAtMs: Date.now() }), "utf8");
    expect(currentLockHolder(lockPath)).toBeUndefined();
  });

  it("never clears or claims a stale lock file — only acquireLock acts on the lock", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, command: "chm themes", acquiredAtMs: Date.now() }), "utf8");

    currentLockHolder(lockPath);

    expect(readFileSync(lockPath, "utf8")).toContain(String(DEAD_PID));
  });
});
