import { defineConfig } from "vitest/config";

// CHM-35: always loaded, but a no-op unless CHAMELEON_TEST_PLATFORM is set —
// see test/setup/platform-override.ts. vitest.config.linux.ts and
// vitest.config.darwin.ts both set that env var; this bare config, the one
// `npm test` runs, never does.
export default defineConfig({
  test: {
    setupFiles: ["./test/setup/platform-override.ts"],
  },
});
