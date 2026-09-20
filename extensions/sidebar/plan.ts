export type PlanStatus = "pending" | "in_progress" | "done";

export type PlanItem = {
  id: number;
  text: string;
  status: PlanStatus;
  parentId: number | null;
};

export type PlanState = {
  items: PlanItem[];
  nextId: number;
};

export type PlanAction = "set" | "list" | "add" | "update" | "toggle" | "clear";

export type PlanDetails = {
  action: PlanAction;
  items: PlanItem[];
  nextId: number;
  error?: string;
};

export type PlanInputItem = {
  id?: number;
  text: string;
  status?: PlanStatus;
  children?: PlanInputItem[];
};

export type PlanMutation = {
  state: PlanState;
  error?: string;
};

export type PlanPanelLine =
  | { type: "heading"; done: number; total: number }
  | { type: "item"; item: PlanItem; depth: number }
  | { type: "overflow"; count: number };

const STATUSES = new Set<PlanStatus>(["pending", "in_progress", "done"]);
const MARK: Record<PlanStatus, string> = {
  pending: "○",
  in_progress: "◐",
  done: "✓",
};

export function emptyPlan(): PlanState {
  return { items: [], nextId: 1 };
}

export function addPlanItem(
  state: PlanState,
  text: string,
  parentId: number | null = null,
  status: PlanStatus = "pending",
): PlanMutation {
  if (!text) return fail(state, "text required");
  if (!STATUSES.has(status)) return fail(state, "invalid status");
  const parent = normalizeParentId(parentId);
  if (parent !== null && !findItem(state.items, parent)) return fail(state, `#${parent} not found`);
  const item: PlanItem = { id: state.nextId, text, status, parentId: parent };
  return ok(enforceOneInProgress({
    items: [...state.items, item],
    nextId: state.nextId + 1,
  }, status === "in_progress" ? item.id : undefined));
}

export function updatePlanItem(
  state: PlanState,
  id: number,
  patch: { text?: string; parentId?: number | null; status?: PlanStatus },
): PlanMutation {
  const current = findItem(state.items, id);
  if (!current) return fail(state, `#${id} not found`);
  if (patch.text === undefined && patch.parentId === undefined && patch.status === undefined) {
    return fail(state, "update requires text, parentId, or status");
  }
  if (patch.text !== undefined && !patch.text) return fail(state, "text required");
  if (patch.status !== undefined && !STATUSES.has(patch.status)) return fail(state, "invalid status");

  let parentId = current.parentId;
  if (patch.parentId !== undefined) {
    parentId = normalizeParentId(patch.parentId);
    if (parentId === id) return fail(state, "cycle");
    if (parentId !== null && !findItem(state.items, parentId)) return fail(state, `#${parentId} not found`);
    if (parentId !== null && isDescendant(state.items, id, parentId)) return fail(state, "cycle");
  }

  const next: PlanItem = {
    ...current,
    text: patch.text ?? current.text,
    status: patch.status ?? current.status,
    parentId,
  };
  const items = state.items.map((item) => (item.id === id ? next : item));
  return ok(enforceOneInProgress({ ...state, items }, next.status === "in_progress" ? id : undefined));
}

export function togglePlanItem(state: PlanState, id: number): PlanMutation {
  const current = findItem(state.items, id);
  if (!current) return fail(state, `#${id} not found`);
  const status: PlanStatus = current.status === "done" ? "pending" : "done";
  const items = state.items.map((item) => (item.id === id ? { ...item, status } : item));
  return ok({ ...state, items });
}

export function setPlanItems(input: unknown): PlanMutation {
  if (!Array.isArray(input)) return fail(emptyPlan(), "items required");

  const items: PlanItem[] = [];
  const used = new Set<number>();
  let cursor = 1;
  let lastInProgress: number | undefined;

  const takeId = (value: unknown): number | string => {
    if (value === undefined) {
      while (used.has(cursor)) cursor += 1;
      const id = cursor;
      used.add(id);
      cursor += 1;
      return id;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return "invalid id";
    if (used.has(value)) return `duplicate id #${value}`;
    used.add(value);
    if (value >= cursor) cursor = value + 1;
    return value;
  };

  const walk = (node: unknown, parentId: number | null): string | undefined => {
    if (!node || typeof node !== "object") return "invalid item";
    const rec = node as Record<string, unknown>;
    if (typeof rec.text !== "string" || rec.text.length === 0) return "text required";
    if (rec.status !== undefined && !isStatus(rec.status)) return "invalid status";
    const id = takeId(rec.id);
    if (typeof id === "string") return id;
    const status = isStatus(rec.status) ? rec.status : "pending";
    items.push({ id, text: rec.text, status, parentId });
    if (status === "in_progress") lastInProgress = id;
    if (rec.children === undefined) return undefined;
    if (!Array.isArray(rec.children)) return "children must be an array";
    for (const child of rec.children) {
      const error = walk(child, id);
      if (error) return error;
    }
    return undefined;
  };

  for (const node of input) {
    const error = walk(node, null);
    if (error) return fail(emptyPlan(), error);
  }

  const nextId = used.size === 0 ? 1 : Math.max(...used) + 1;
  return ok(enforceOneInProgress({ items, nextId }, lastInProgress));
}

export function clearPlan(): PlanState {
  return emptyPlan();
}

export function snapshotPlan(action: PlanAction, state: PlanState, error?: string): PlanDetails {
  return {
    action,
    items: state.items.map((item) => ({ ...item })),
    nextId: state.nextId,
    ...(error ? { error } : {}),
  };
}

export function planFromDetails(details: unknown, fallback: PlanState): PlanState {
  if (!details || typeof details !== "object") return fallback;
  const rec = details as { items?: unknown; nextId?: unknown };
  if (!Array.isArray(rec.items)) return fallback;

  const items: PlanItem[] = [];
  const used = new Set<number>();
  for (const raw of rec.items) {
    const item = readStoredItem(raw);
    if (!item || used.has(item.id)) continue;
    used.add(item.id);
    items.push(item);
  }

  const known = new Set(items.map((item) => item.id));
  for (const item of items) {
    if (item.parentId !== null && !known.has(item.parentId)) item.parentId = null;
  }

  const lastInProgress = [...items].reverse().find((item) => item.status === "in_progress")?.id;
  const maxId = items.reduce((max, item) => Math.max(max, item.id), 0);
  const nextId = typeof rec.nextId === "number" && Number.isInteger(rec.nextId) && rec.nextId > maxId
    ? rec.nextId
    : maxId + 1;
  return enforceOneInProgress({ items, nextId }, lastInProgress);
}

export function formatPlanTree(state: PlanState): string {
  if (state.items.length === 0) return "No plan items";
  return flattenTree(state.items)
    .map((item) => `${"  ".repeat(itemDepth(state.items, item.id))}#${item.id} ${item.status} ${item.text}`)
    .join("\n");
}

export function planPanel(items: PlanItem[], maxHeight: number): PlanPanelLine[] {
  if (items.length === 0 || maxHeight < 1) return [];
  const done = items.filter((item) => item.status === "done").length;
  const lines: PlanPanelLine[] = [{ type: "heading", done, total: items.length }];
  const rows = planDisplayRows(items);
  const bodyBudget = Math.max(0, maxHeight - 1);
  if (rows.length <= bodyBudget) {
    lines.push(...rows);
    return lines;
  }
  if (bodyBudget === 0) return lines;
  if (bodyBudget === 1) {
    if (rows[0]) lines.push(rows[0]);
    return lines;
  }
  const visible = rows.slice(0, bodyBudget - 1);
  lines.push(...visible);
  lines.push({ type: "overflow", count: rows.length - visible.length });
  return lines;
}

export function formatPlanPanel(items: PlanItem[], maxHeight: number): string[] {
  return planPanel(items, maxHeight).map((line) => {
    if (line.type === "heading") return `Plan ${line.done}/${line.total}`;
    if (line.type === "overflow") return `+${line.count} more`;
    return `${" ".repeat(line.depth)}${MARK[line.item.status]} ${line.item.text}`;
  });
}

function planDisplayRows(items: PlanItem[]): Extract<PlanPanelLine, { type: "item" }>[] {
  const tree = flattenTree(items);
  const current = tree.find((item) => item.status === "in_progress") ?? tree.find((item) => item.status === "pending");
  const rows: Extract<PlanPanelLine, { type: "item" }>[] = [];
  if (current) rows.push({ type: "item", item: current, depth: 0 });
  const rest = tree.filter((item) => item.id !== current?.id);
  const open = rest.filter((item) => item.status !== "done");
  const done = rest.filter((item) => item.status === "done");
  for (const item of [...open, ...done]) {
    rows.push({ type: "item", item, depth: Math.min(itemDepth(items, item.id), 3) });
  }
  return rows;
}

function flattenTree(items: PlanItem[]): PlanItem[] {
  const known = new Set(items.map((item) => item.id));
  const children = new Map<number | null, PlanItem[]>();
  for (const item of items) {
    const parentId = item.parentId !== null && known.has(item.parentId) ? item.parentId : null;
    const bucket = children.get(parentId);
    if (bucket) bucket.push(item);
    else children.set(parentId, [item]);
  }
  const walk = (parentId: number | null): PlanItem[] => {
    const list: PlanItem[] = [];
    for (const item of children.get(parentId) ?? []) {
      list.push(item, ...walk(item.id));
    }
    return list;
  };
  return walk(null);
}

function itemDepth(items: PlanItem[], id: number): number {
  const byId = new Map(items.map((item) => [item.id, item]));
  let depth = 0;
  let cursor = byId.get(id)?.parentId ?? null;
  const seen = new Set<number>();
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return depth;
}

function isDescendant(items: PlanItem[], ancestorId: number, maybeDescendantId: number): boolean {
  const byId = new Map(items.map((item) => [item.id, item]));
  let cursor: number | null = maybeDescendantId;
  const seen = new Set<number>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ancestorId) return true;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

function enforceOneInProgress(state: PlanState, keepId?: number): PlanState {
  const target = keepId ?? [...state.items].reverse().find((item) => item.status === "in_progress")?.id;
  if (target === undefined) return state;
  let changed = false;
  const items = state.items.map((item) => {
    if (item.id === target || item.status !== "in_progress") return item;
    changed = true;
    return { ...item, status: "pending" as const };
  });
  return changed ? { ...state, items } : state;
}

function readStoredItem(raw: unknown): PlanItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as { id?: unknown; text?: unknown; status?: unknown; done?: unknown; parentId?: unknown };
  if (typeof rec.id !== "number" || !Number.isInteger(rec.id) || rec.id < 1) return undefined;
  if (typeof rec.text !== "string") return undefined;
  const parentId = typeof rec.parentId === "number" && Number.isInteger(rec.parentId) && rec.parentId > 0
    ? rec.parentId
    : null;
  return {
    id: rec.id,
    text: rec.text,
    status: normalizeStatus(rec.status, rec.done),
    parentId,
  };
}

function normalizeStatus(status: unknown, done?: unknown): PlanStatus {
  return isStatus(status) ? status : done === true ? "done" : "pending";
}

function isStatus(value: unknown): value is PlanStatus {
  return typeof value === "string" && STATUSES.has(value as PlanStatus);
}

function normalizeParentId(parentId: number | null | undefined): number | null {
  if (parentId === undefined || parentId === null || parentId === 0) return null;
  return parentId;
}

function findItem(items: PlanItem[], id: number): PlanItem | undefined {
  return items.find((item) => item.id === id);
}

function ok(state: PlanState): PlanMutation {
  return { state };
}

function fail(state: PlanState, error: string): PlanMutation {
  return { state, error };
}
