/**
 * Renders why a spawned installer command did not succeed — either it could
 * not be started at all (`outcome.error`, e.g. the binary is not on PATH)
 * or it ran and exited non-zero. Shared by every adapter that shells out to
 * an external installer (`installOhMyPosh`, `installNerdFont`) so a failure
 * always names the exact command that was tried, never a generic "it didn't
 * work".
 */
export function describeSpawnFailure(command, args, outcome) {
    const commandLine = [command, ...args].join(" ");
    if (outcome.error) {
        return `could not run "${commandLine}": ${outcome.error.message}`;
    }
    return `"${commandLine}" exited with status ${String(outcome.status)}`;
}
//# sourceMappingURL=spawn-result.js.map