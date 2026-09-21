import assert from "node:assert/strict";
import test from "node:test";
import {
  eventTitle,
  eventsForFilter,
  formatDetail,
  formatResult,
  formatTurnImpact,
  TurnImpactTracker,
} from "../extensions/pi-slate/turn-impact.ts";

test("turn impact counts tools, shells, reads, and subagents", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "r1", toolName: "read", input: { path: "a.ts" } });
  impact.toolCall({ toolCallId: "r2", toolName: "read", input: { path: "a.ts" } });
  impact.toolCall({ toolCallId: "s1", toolName: "bash", input: { command: "ls" } });
  impact.toolCall({ toolCallId: "a1", toolName: "subagent", input: { agent: "reviewer", task: "check" } });
  assert.equal(impact.snapshot().toolsCalled, 4);
  assert.equal(impact.snapshot().shellCommands, 1);
  assert.equal(impact.snapshot().subagentsSpawned, 1);
  assert.equal(impact.snapshot().filesRead, 0);

  impact.toolEnd({ toolCallId: "r1", isError: false, result: "ok" });
  impact.toolEnd({ toolCallId: "r2", isError: true, result: "nope" });
  impact.toolEnd({ toolCallId: "s1", isError: false, result: "files" });
  impact.toolEnd({ toolCallId: "a1", isError: false, result: "done" });
  assert.equal(impact.snapshot().filesRead, 1);
  assert.equal(impact.snapshot().events.length, 4);
});

test("later LLM rounds keep last-prompt impact until reset", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "s1", toolName: "bash", input: { command: "rm gone.ts" } });
  impact.toolEnd({ toolCallId: "s1", isError: false, result: "" });
  impact.toolCall({ toolCallId: "r1", toolName: "read", input: { path: "a.ts" } });
  impact.toolEnd({ toolCallId: "r1", isError: false, result: "src" });
  assert.equal(impact.snapshot().shellCommands, 1);
  assert.equal(impact.snapshot().filesRead, 1);
  assert.equal(impact.snapshot().toolsCalled, 2);
});

test("reset clears the current turn and keeps moving the revision", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "r1", toolName: "read", input: { path: "a.ts" } });
  impact.toolEnd({ toolCallId: "r1", isError: false });
  const afterReset = impact.reset();
  assert.equal(afterReset.filesRead, 0);
  assert.equal(afterReset.toolsCalled, 0);
  assert.equal(afterReset.events.length, 0);
  assert.ok(afterReset.revision > 0);
});

test("formatTurnImpact prints the last-turn facts", () => {
  assert.deepEqual(formatTurnImpact({
    revision: 1,
    filesRead: 0,
    toolsCalled: 0,
    shellCommands: 0,
    subagentsSpawned: 0,
    events: [],
  }), [
    "0 tools called",
    "0 shell commands",
  ]);
  assert.deepEqual(formatTurnImpact({
    revision: 2,
    filesRead: 1,
    toolsCalled: 6,
    shellCommands: 5,
    subagentsSpawned: 2,
    events: [],
  }), [
    "6 tools called",
    "5 shell commands",
  ]);
});

test("eventsForFilter slices the unified log", () => {
  const events = [
    { id: "1", toolName: "read", title: "read a.ts", detail: "", isError: false, pending: false },
    { id: "2", toolName: "bash", title: "bash ls", detail: "", isError: false, pending: false },
    { id: "3", toolName: "subagent", title: "reviewer", detail: "", isError: false, pending: false },
  ];
  assert.equal(eventsForFilter(events, "tool").length, 3);
  assert.deepEqual(eventsForFilter(events, "shell").map((event) => event.id), ["2"]);
});

test("event titles and details stay auditable", () => {
  assert.equal(eventTitle("bash", { command: "ls -la" }), "bash ls -la");
  assert.equal(eventTitle("subagent", { agent: "reviewer", task: "check" }), "reviewer · check");
  assert.equal(formatResult([{ type: "text", text: "hello" }]), "hello");
  assert.match(formatDetail("read", { path: "a.ts" }, "src", false, false), /^ok\na\.ts\nsrc$/);
});
