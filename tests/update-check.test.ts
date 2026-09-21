import assert from "node:assert/strict";
import test from "node:test";
import { isNewerVersion, parseVersion, updateAvailableMessage } from "../extensions/pi-minimal-ui/update-version.ts";

test("parses dotted versions and ignores a leading v", () => {
  assert.deepEqual(parseVersion("0.85.1"), [0, 85, 1]);
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.equal(parseVersion("latest"), undefined);
});

test("detects a newer package version", () => {
  assert.equal(isNewerVersion("0.86.0", "0.85.1"), true);
  assert.equal(isNewerVersion("0.85.1", "0.85.1"), false);
  assert.equal(isNewerVersion("0.84.9", "0.85.1"), false);
});

test("formats a minimal update notice", () => {
  assert.equal(updateAvailableMessage("0.86.0"), "0.86.0 is available. Use /update to update");
});
