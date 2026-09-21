import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTurnImpact,
  isTestCommand,
  TurnImpactTracker,
} from "../extensions/pi-minimal-ui/turn-impact.ts";

test("isTestCommand recognizes runner invocations only", () => {
  assert.equal(isTestCommand("npm test"), true);
  assert.equal(isTestCommand("pnpm run test"), true);
  assert.equal(isTestCommand("cd pkg && yarn test"), true);
  assert.equal(isTestCommand("vitest run"), true);
  assert.equal(isTestCommand("cargo test"), true);
  assert.equal(isTestCommand("node --test"), true);
  assert.equal(isTestCommand("echo test"), false);
  assert.equal(isTestCommand("cat latest.test.ts"), false);
  assert.equal(isTestCommand("npm testing"), false);
});

test("turn impact counts distinct successful reads and writes", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "r1", toolName: "read", input: { path: "a.ts" } });
  impact.toolCall({ toolCallId: "r2", toolName: "read", input: { path: "a.ts" } });
  impact.toolCall({ toolCallId: "r3", toolName: "read", input: { path: "b.ts" } });
  impact.toolCall({ toolCallId: "e1", toolName: "edit", input: { path: "a.ts" } });
  impact.toolCall({ toolCallId: "w1", toolName: "write", input: { path: "c.ts" } });
  assert.deepEqual(impact.snapshot(), {
    revision: 5,
    filesRead: 0,
    filesModified: 0,
    shellCommands: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsUnknown: 0,
  });

  impact.toolEnd({ toolCallId: "r1", isError: false });
  impact.toolEnd({ toolCallId: "r2", isError: false });
  impact.toolEnd({ toolCallId: "r3", isError: true });
  impact.toolEnd({ toolCallId: "e1", isError: false });
  impact.toolEnd({ toolCallId: "w1", isError: true });
  assert.equal(impact.snapshot().filesRead, 1);
  assert.equal(impact.snapshot().filesModified, 1);
});

test("turn impact counts shells and resolves test pass/fail", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "s1", toolName: "bash", input: { command: "ls" } });
  impact.toolCall({ toolCallId: "t1", toolName: "bash", input: { command: "npm test" } });
  impact.toolCall({ toolCallId: "t2", toolName: "powershell", input: { command: "npm test" } });
  assert.equal(impact.snapshot().shellCommands, 3);
  assert.equal(impact.snapshot().testsUnknown, 2);

  impact.toolEnd({ toolCallId: "t1", isError: false });
  impact.toolEnd({ toolCallId: "t2", isError: true });
  assert.equal(impact.snapshot().testsPassed, 1);
  assert.equal(impact.snapshot().testsFailed, 1);
  assert.equal(impact.snapshot().testsUnknown, 0);
});

test("reset clears the current turn and keeps moving the revision", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "r1", toolName: "read", input: { path: "a.ts" } });
  impact.toolEnd({ toolCallId: "r1", isError: false });
  const afterReset = impact.reset();
  assert.equal(afterReset.filesRead, 0);
  assert.equal(afterReset.shellCommands, 0);
  assert.ok(afterReset.revision > 0);
});

test("formatTurnImpact prints compact factual lines", () => {
  assert.deepEqual(formatTurnImpact({
    revision: 1,
    filesRead: 0,
    filesModified: 0,
    shellCommands: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsUnknown: 0,
  }), [
    "0 files read · 0 files modified",
    "0 shell commands",
  ]);
  assert.deepEqual(formatTurnImpact({
    revision: 2,
    filesRead: 1,
    filesModified: 2,
    shellCommands: 1,
    testsPassed: 1,
    testsFailed: 2,
    testsUnknown: 1,
  }), [
    "1 file read · 2 files modified",
    "1 shell command",
    "1 test passed · 2 tests failed · 1 test running/unknown",
  ]);
});
