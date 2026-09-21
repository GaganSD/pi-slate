import assert from "node:assert/strict";
import test from "node:test";
import {
  deletedPathsFromCommand,
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
    filesDeleted: 0,
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

test("bash deletions count after a successful tool end", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "d1", toolName: "bash", input: { command: "rm -rf missions/a.json missions/b.json" } });
  impact.toolCall({ toolCallId: "d2", toolName: "bash", input: { command: "git rm old.ts" } });
  assert.equal(impact.snapshot().filesDeleted, 0);
  assert.equal(impact.snapshot().shellCommands, 2);
  impact.toolEnd({ toolCallId: "d1", isError: false });
  impact.toolEnd({ toolCallId: "d2", isError: true });
  assert.equal(impact.snapshot().filesDeleted, 2);
  assert.equal(impact.snapshot().filesModified, 0);
});

test("later LLM rounds keep last-prompt impact until reset", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "s1", toolName: "bash", input: { command: "rm gone.ts" } });
  impact.toolEnd({ toolCallId: "s1", isError: false });
  impact.toolCall({ toolCallId: "r1", toolName: "read", input: { path: "a.ts" } });
  impact.toolEnd({ toolCallId: "r1", isError: false });
  assert.equal(impact.snapshot().filesDeleted, 1);
  assert.equal(impact.snapshot().filesRead, 1);
  assert.equal(impact.snapshot().shellCommands, 1);
});

test("deletedPathsFromCommand reads rm/git rm args and ignores other commands", () => {
  assert.deepEqual(deletedPathsFromCommand("rm -rf missions/a.json missions/b.json"), [
    "missions/a.json",
    "missions/b.json",
  ]);
  assert.deepEqual(deletedPathsFromCommand("sudo git rm old.ts"), ["old.ts"]);
  assert.deepEqual(deletedPathsFromCommand("ls && rm gone.ts"), ["gone.ts"]);
  assert.deepEqual(deletedPathsFromCommand("rm"), ["(deleted)"]);
  assert.deepEqual(deletedPathsFromCommand("ls missions"), []);
});

test("reset clears the current turn and keeps moving the revision", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "r1", toolName: "read", input: { path: "a.ts" } });
  impact.toolEnd({ toolCallId: "r1", isError: false });
  const afterReset = impact.reset();
  assert.equal(afterReset.filesRead, 0);
  assert.equal(afterReset.filesDeleted, 0);
  assert.equal(afterReset.shellCommands, 0);
  assert.ok(afterReset.revision > 0);
});

test("formatTurnImpact prints compact factual lines", () => {
  assert.deepEqual(formatTurnImpact({
    revision: 1,
    filesRead: 0,
    filesModified: 0,
    filesDeleted: 0,
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
    filesDeleted: 3,
    shellCommands: 1,
    testsPassed: 1,
    testsFailed: 2,
    testsUnknown: 1,
  }), [
    "1 file read · 2 files modified",
    "3 files deleted",
    "1 shell command",
    "1 test passed · 2 tests failed · 1 test running/unknown",
  ]);
});
