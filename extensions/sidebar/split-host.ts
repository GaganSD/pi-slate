export const SET_LAYOUT_ROOT = Symbol.for("pi-extensions.sidebar.setLayoutRoot");
export const SPLIT_OWNER = Symbol.for("pi-extensions.sidebar.split-owner");

const FOREIGN_SET_LAYOUT_ROOT = Symbol.for("pi-minimal-ui.setLayoutRoot");
const FOREIGN_SPLIT_OWNER = Symbol.for("pi-minimal-ui.sidebar-split-owner");

export type SplitHost<T> = {
  layoutRoot?: T;
  setLayoutRoot(component: T | undefined): void;
  [SET_LAYOUT_ROOT]?: (component: T | undefined) => void;
  [SPLIT_OWNER]?: object;
};

export function hasForeignSplitOwner(host: object): boolean {
  const rec = host as Record<symbol, unknown>;
  const ours = rec[SPLIT_OWNER] !== undefined || rec[SET_LAYOUT_ROOT] !== undefined;
  if (ours) return false;
  return rec[FOREIGN_SPLIT_OWNER] !== undefined || rec[FOREIGN_SET_LAYOUT_ROOT] !== undefined;
}

export function bindSplitHost<T>(
  host: SplitHost<T>,
  wrap: (component: T | undefined) => T | undefined,
  unwrap: (component: T | undefined) => T | undefined,
): (() => void) | undefined {
  if (hasForeignSplitOwner(host)) return undefined;

  const originalSet = host[SET_LAYOUT_ROOT] ?? host.setLayoutRoot.bind(host);
  const owner = {};
  host[SET_LAYOUT_ROOT] = originalSet;
  host[SPLIT_OWNER] = owner;
  host.setLayoutRoot = (component) => originalSet(wrap(component));
  if (host.layoutRoot !== undefined) originalSet(wrap(host.layoutRoot));

  return () => {
    if (host[SPLIT_OWNER] !== owner) return;
    host.setLayoutRoot = originalSet;
    delete host[SET_LAYOUT_ROOT];
    delete host[SPLIT_OWNER];
    originalSet(unwrap(host.layoutRoot));
  };
}
