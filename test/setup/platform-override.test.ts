import { describe, expect, it } from "vitest";
import { DISCOVERY_ENV_VARS } from "./platform-override.js";

/**
 * CHM-72: the guarantee itself, not just the clearing mechanism. CHM-36,
 * CHM-59 and CHM-71 each shipped a discovery test that silently asserted
 * against whatever the developer's own machine happened to have exported,
 * because nothing enforced that these variables start every test file unset.
 * This is what makes a fourth occurrence fail loudly instead of quietly
 * passing on every maintainer's machine and failing on none of them — see
 * platform-override.ts for which variables these are and why.
 */
describe("environment cleared for discovery (CHM-72)", () => {
  it.each(DISCOVERY_ENV_VARS)("%s is unset before a test file's own module runs", (discoveryEnvVar) => {
    expect(process.env[discoveryEnvVar]).toBeUndefined();
  });
});
