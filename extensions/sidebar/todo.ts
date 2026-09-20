import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  addPlanItem,
  clearPlan,
  emptyPlan,
  formatPlanTree,
  planFromDetails,
  setPlanItems,
  snapshotPlan,
  togglePlanItem,
  updatePlanItem,
  type PlanDetails,
  type PlanMutation,
  type PlanState,
  type PlanStatus,
} from "./plan.ts";
import type { Sidebar } from "./sidebar.ts";

const PlanStatusSchema = StringEnum(["pending", "in_progress", "done"] as const);

const TodoParams = Type.Object({
  action: StringEnum(["set", "list", "add", "update", "toggle", "clear"] as const),
  text: Type.Optional(Type.String({ description: "Todo text (for add/update)" })),
  id: Type.Optional(Type.Number({ description: "Todo ID (for update/toggle)" })),
  parentId: Type.Optional(Type.Number({ description: "Parent todo ID; 0 for root" })),
  status: Type.Optional(PlanStatusSchema),
  items: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Optional(Type.Number()),
        text: Type.String(),
        status: Type.Optional(PlanStatusSchema),
        children: Type.Optional(Type.Array(Type.Any())),
      }),
      { description: "Nested tree for set" },
    ),
  ),
});

export function reconstructPlan(ctx: ExtensionContext): PlanState {
  let state = emptyPlan();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "toolResult" || !("toolName" in message) || message.toolName !== "todo") continue;
    state = planFromDetails(message.details, state);
  }
  return state;
}

export function installTodoTool(
  pi: ExtensionAPI,
  sidebar: Sidebar,
  onChange: (state: PlanState) => void,
): void {
  let state = emptyPlan();

  const publish = (next: PlanState): void => {
    state = next;
    sidebar.setTodos(state.items);
    onChange(state);
  };

  pi.on("session_start", (_event, ctx) => {
    publish(reconstructPlan(ctx));
  });
  pi.on("session_tree", (_event, ctx) => {
    publish(reconstructPlan(ctx));
  });

  pi.registerTool({
    name: "todo",
    label: "Plan",
    description:
      "Maintain the nested session plan in the sidebar. set/add/update/toggle/clear return a one-line ack; list returns the tree.",
    promptSnippet: "Keep a nested plan in the sidebar for multi-step work",
    parameters: TodoParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      switch (params.action) {
        case "list":
          return reply("list", state, formatPlanTree(state));
        case "set":
          return mutate(publish, state, "set", setPlanItems(params.items));
        case "add": {
          if (!params.text) return fail("add", state, "text required");
          return mutate(
            publish,
            state,
            "add",
            addPlanItem(state, params.text, params.parentId ?? null, params.status as PlanStatus | undefined),
          );
        }
        case "update": {
          if (params.id === undefined) return fail("update", state, "id required");
          return mutate(
            publish,
            state,
            "update",
            updatePlanItem(state, params.id, {
              text: params.text,
              parentId: params.parentId,
              status: params.status as PlanStatus | undefined,
            }),
          );
        }
        case "toggle": {
          if (params.id === undefined) return fail("toggle", state, "id required");
          return mutate(publish, state, "toggle", togglePlanItem(state, params.id));
        }
        case "clear":
          return mutate(publish, state, "clear", { state: clearPlan() });
        default:
          return fail("list", state, `unknown action: ${String(params.action)}`);
      }
    },
    renderCall(args, theme) {
      let text = `${theme.fg("toolTitle", theme.bold("plan "))}${theme.fg("muted", args.action)}`;
      if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
      if (args.parentId !== undefined) text += ` ${theme.fg("dim", `parent #${args.parentId}`)}`;
      if (args.status) text += ` ${theme.fg("muted", args.status)}`;
      if (Array.isArray(args.items)) text += ` ${theme.fg("dim", `${args.items.length} items`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as PlanDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      const text = result.content[0];
      return new Text(theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
    },
  });
}

function mutate(
  publish: (state: PlanState) => void,
  current: PlanState,
  action: PlanDetails["action"],
  result: PlanMutation,
) {
  if (result.error) return fail(action, current, result.error);
  publish(result.state);
  return reply(action, result.state, summarize(action, current, result.state));
}

function reply(action: PlanDetails["action"], state: PlanState, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: snapshotPlan(action, state),
  };
}

function fail(action: PlanDetails["action"], state: PlanState, error: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${error}` }],
    details: snapshotPlan(action, state, error),
  };
}

function summarize(action: PlanDetails["action"], before: PlanState, after: PlanState): string {
  if (action === "clear") return `Cleared ${before.items.length} plan items`;
  if (action === "set") return `Set ${after.items.length} items`;
  if (action === "add") {
    const added = after.items[after.items.length - 1];
    return added ? `Added #${added.id}` : "Added";
  }
  const changed = after.items.find((item) => {
    const prev = before.items.find((entry) => entry.id === item.id);
    return !prev || prev.status !== item.status || prev.text !== item.text || prev.parentId !== item.parentId;
  });
  if (action === "toggle") return changed ? `#${changed.id} ${changed.status}` : "Toggled";
  return changed ? `Updated #${changed.id}` : "Updated";
}
