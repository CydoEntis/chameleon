import { defineConfig } from "vitest/config";

// CHM-35: runs the whole suite as though process.platform were "linux" —
// see test/setup/platform-override.ts for how `test.env` below reaches it.
// This is what makes CHM-25's own acceptance criterion, "the suite passes on
// Linux as well as Windows", checkable in CI without an actual Linux host.
// Invoke with `npm run test:linux`.
export default defineConfig({
  test: {
    setupFiles: ["./test/setup/platform-override.ts"],
    env: {
      CHAMELEON_TEST_PLATFORM: "linux",
    },
  },
});
