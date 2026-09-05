import { defineConfig } from "vitest/config";

// CHM-35: runs the whole suite as though process.platform were "darwin" —
// see test/setup/platform-override.ts for how `test.env` below reaches it.
// Invoke with `npm run test:darwin`.
export default defineConfig({
  test: {
    setupFiles: ["./test/setup/platform-override.ts"],
    env: {
      CHAMELEON_TEST_PLATFORM: "darwin",
    },
  },
});
