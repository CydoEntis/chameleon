/**
 * The slice of node:child_process's SpawnSyncReturns this project ever
 * inspects for a failure. Typed by hand instead of importing the generic
 * SpawnSyncReturns<T> so a caller running with `stdio: "inherit"` — every
 * installer this project shells out to — doesn't have to fight a type
 * parameter for stdout/stderr it deliberately never captures.
 */
interface SpawnOutcome {
  readonly error?: Error;
  readonly status: number | null;
}

/**
 * Renders why a spawned installer command did not succeed — either it could
 * not be started at all (`outcome.error`, e.g. the binary is not on PATH)
 * or it ran and exited non-zero. Shared by every adapter that shells out to
 * an external installer (`installOhMyPosh`, `installNerdFont`) so a failure
 * always names the exact command that was tried, never a generic "it didn't
 * work".
 */
export function describeSpawnFailure(command: string, args: readonly string[], outcome: SpawnOutcome): string {
  const commandLine = [command, ...args].join(" ");
  if (outcome.error) {
    return `could not run "${commandLine}": ${outcome.error.message}`;
  }
  return `"${commandLine}" exited with status ${String(outcome.status)}`;
}
