import assert from "node:assert/strict";
import test from "node:test";
import {
  addPlanItem,
  clearPlan,
  emptyPlan,
  formatPlanPanel,
  formatPlanTree,
  planFromDetails,
  setPlanItems,
  snapshotPlan,
  togglePlanItem,
  updatePlanItem,
  type PlanMutation,
  type PlanState,
} from "../extensions/pi-minimal-ui/plan.ts";

function must(result: PlanMutation): PlanState {
  assert.equal(result.error, undefined, result.error);
  return result.state;
}

test("plan items add, toggle, and clear", () => {
  let state = must(addPlanItem(emptyPlan(), "inspect wrap"));
  state = must(addPlanItem(state, "add context"));
  assert.deepEqual(state.items.map((item) => item.text), ["inspect wrap", "add context"]);
  const toggled = must(togglePlanItem(state, 1));
  assert.equal(toggled.items[0]?.status, "done");
  assert.equal(togglePlanItem(state, 99).error, "#99 not found");
  assert.deepEqual(clearPlan().items, []);
});

test("set builds a nested tree, assigns ids, and preserves explicit ids", () => {
  const assigned = must(setPlanItems([
    {
      text: "Auth",
      children: [
        { text: "JWT", status: "in_progress" },
        { text: "Tests" },
      ],
    },
    { text: "Docs" },
  ]));
  assert.deepEqual(assigned.items.map((item) => ({
    id: item.id,
    text: item.text,
    status: item.status,
    parentId: item.parentId,
  })), [
    { id: 1, text: "Auth", status: "pending", parentId: null },
    { id: 2, text: "JWT", status: "in_progress", parentId: 1 },
    { id: 3, text: "Tests", status: "pending", parentId: 1 },
    { id: 4, text: "Docs", status: "pending", parentId: null },
  ]);
  assert.equal(assigned.nextId, 5);

  const preserved = must(setPlanItems([
    { id: 10, text: "Root", children: [{ id: 2, text: "Child" }] },
  ]));
  assert.deepEqual(preserved.items.map((item) => item.id), [10, 2]);
  assert.equal(preserved.nextId, 11);
});

test("set rejects invalid payloads and leaves no partial state", () => {
  assert.equal(setPlanItems({ text: "nope" } as never).error, "items required");
  assert.equal(setPlanItems([{ text: "" }]).error, "text required");
  assert.equal(setPlanItems([{ id: 1, text: "A" }, { id: 1, text: "B" }]).error, "duplicate id #1");
  assert.equal(setPlanItems([{ text: "A", status: "blocked" }]).error, "invalid status");
  assert.equal(setPlanItems([]).state.items.length, 0);
});

test("second in_progress demotes the first", () => {
  let state = must(setPlanItems([
    { text: "One", status: "in_progress" },
    { text: "Two" },
  ]));
  state = must(updatePlanItem(state, 2, { status: "in_progress" }));
  assert.equal(state.items[0]?.status, "pending");
  assert.equal(state.items[1]?.status, "in_progress");

  state = must(setPlanItems([
    { text: "One", status: "in_progress" },
    { text: "Two", status: "in_progress" },
  ]));
  assert.equal(state.items[0]?.status, "pending");
  assert.equal(state.items[1]?.status, "in_progress");
});

test("add under a parent, update reparents, toggle flips done", () => {
  let state = must(setPlanItems([{ text: "Auth" }, { text: "Docs" }]));
  state = must(addPlanItem(state, "JWT", 1, "in_progress"));
  assert.equal(state.items[2]?.parentId, 1);
  assert.equal(state.items[2]?.status, "in_progress");

  state = must(updatePlanItem(state, 3, { parentId: 2 }));
  assert.equal(state.items[2]?.parentId, 2);

  state = must(updatePlanItem(state, 3, { parentId: 0 }));
  assert.equal(state.items[2]?.parentId, null);

  const nested = must(setPlanItems([{ text: "Auth", children: [{ text: "JWT" }] }]));
  assert.equal(updatePlanItem(nested, 1, { parentId: 2 }).error, "cycle");
  assert.equal(updatePlanItem(nested, 1, { parentId: 1 }).error, "cycle");
  assert.equal(addPlanItem(state, "Nope", 99).error, "#99 not found");

  state = must(togglePlanItem(state, 3));
  assert.equal(state.items[2]?.status, "done");
  state = must(togglePlanItem(state, 3));
  assert.equal(state.items[2]?.status, "pending");
});

test("old done snapshots restore as status done", () => {
  const restored = planFromDetails({
    action: "add",
    items: [{ id: 1, text: "rename sidebar", done: true }],
    nextId: 2,
  }, emptyPlan());
  assert.deepEqual(restored.items[0], {
    id: 1,
    text: "rename sidebar",
    status: "done",
    parentId: null,
  });
  assert.equal(restored.nextId, 2);
});

test("plan snapshots restore after session reload", () => {
  const state = must(addPlanItem(emptyPlan(), "rename sidebar"));
  const details = snapshotPlan("add", state);
  assert.equal(details.items[0]?.text, "rename sidebar");
  assert.deepEqual(planFromDetails(details, emptyPlan()), state);
  assert.deepEqual(planFromDetails(undefined, emptyPlan()), emptyPlan());
});

test("formatPlanTree and the sticky panel keep the current step visible", () => {
  const state = must(setPlanItems([
    {
      text: "Auth",
      children: [
        { text: "JWT", status: "in_progress" },
        { text: "Tests" },
      ],
    },
    { text: "Docs", status: "done" },
  ]));
  assert.equal(
    formatPlanTree(state),
    ["#1 pending Auth", "  #2 in_progress JWT", "  #3 pending Tests", "#4 done Docs"].join("\n"),
  );
  assert.deepEqual(formatPlanPanel(state.items, 10), [
    "Plan 1/4",
    "◐ JWT",
    "○ Auth",
    " ○ Tests",
    "✓ Docs",
  ]);
  assert.deepEqual(formatPlanPanel(state.items, 3), [
    "Plan 1/4",
    "◐ JWT",
    "+3 more",
  ]);
});
