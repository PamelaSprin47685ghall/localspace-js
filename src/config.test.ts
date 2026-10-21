import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const baseEnv = {
  LOCALSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-for-unit-tests-only",
  LOCALSPACE_ALLOWED_ROOTS: "/tmp",
  LOCALSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
  LOCALSPACE_AUTH_MODE: "none",
};

{
  const config = loadConfig(baseEnv as NodeJS.ProcessEnv);
  assert.equal(config.authMode, "none");
  assert.equal(config.port, 7676);
  assert.ok(config.configDir);
  console.log("config.test.ts: ok");
}
