export const ORIGINAL_SET_LAYOUT_ROOT = Symbol.for("pi-slate.setLayoutRoot");
export const SPLIT_OWNER = Symbol.for("pi-slate.sidebar-split-owner");

export type SplitHost<T> = {
  layoutRoot?: T;
  setLayoutRoot(component: T | undefined): void;
  [ORIGINAL_SET_LAYOUT_ROOT]?: (component: T | undefined) => void;
  [SPLIT_OWNER]?: object;
};

export function bindSplitHost<T>(
  host: SplitHost<T>,
  wrap: (component: T | undefined) => T | undefined,
  unwrap: (component: T | undefined) => T | undefined,
): () => void {
  const originalSet = host[ORIGINAL_SET_LAYOUT_ROOT] ?? host.setLayoutRoot.bind(host);
  const owner = {};
  host[ORIGINAL_SET_LAYOUT_ROOT] = originalSet;
  host[SPLIT_OWNER] = owner;
  host.setLayoutRoot = (component) => originalSet(wrap(component));
  if (host.layoutRoot !== undefined) originalSet(wrap(host.layoutRoot));

  return () => {
    if (host[SPLIT_OWNER] !== owner) return;
    host.setLayoutRoot = originalSet;
    delete host[ORIGINAL_SET_LAYOUT_ROOT];
    delete host[SPLIT_OWNER];
    originalSet(unwrap(host.layoutRoot));
  };
}
