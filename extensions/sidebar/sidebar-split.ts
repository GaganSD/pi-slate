import {
  HStack,
  isViewportTUI,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_WIDTH_LAYOUT,
  workspaceColumnWidth,
  type WidthLayout,
} from "./layout.ts";
import { bindSplitHost, hasForeignSplitOwner } from "./split-host.ts";

const SIDEBAR_SPLIT = Symbol("sidebar-split");

class SidebarGutter implements Component {
  private readonly pane: Component;

  constructor(pane: Component) {
    this.pane = pane;
  }

  invalidate(): void {
    this.pane.invalidate();
  }

  render(width: number): string[] {
    return this.pane.render(width);
  }

  handleInput?(data: string): void {
    this.pane.handleInput?.(data);
  }

  handleMouse?(event: TuiMouseEvent) {
    return this.pane.handleMouse?.(event);
  }
}

class SidebarSplit extends HStack {
  constructor(chat: Component, pane: Component, getWidth: () => WidthLayout) {
    const gutter = new SidebarGutter(pane);
    const initial = getWidth();
    super([
      // Skip full-width intrinsic measurement: switching widths thrashes leaf render caches.
      { component: chat, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      {
        component: gutter,
        grow: 0,
        shrink: 0,
        minSize: initial.minWidth,
        basis: initial.minWidth,
        visible: (viewport) => {
          const layout = getWidth();
          const width = workspaceColumnWidth(viewport.width, layout);
          const entry = this.entries[1];
          if (entry && entry.basis !== width) entry.basis = Math.max(layout.minWidth, width);
          if (entry) entry.minSize = layout.minWidth;
          return width > 0;
        },
      },
    ]);
    Object.assign(this, { [SIDEBAR_SPLIT]: true });
  }
}

function isSplit(component: Component | undefined): component is SidebarSplit {
  return Boolean(component && (component as { [SIDEBAR_SPLIT]?: boolean })[SIDEBAR_SPLIT]);
}

export function splitChat(component: Component | undefined): Component | undefined {
  if (!component) return undefined;
  if (!isSplit(component)) return component;
  return component.entries[0]?.component ?? component.children[0];
}

export function installSidebarSplit(
  tui: TUI,
  pane: Component,
  getWidth: () => WidthLayout = () => DEFAULT_WIDTH_LAYOUT,
): (() => void) | undefined {
  if (!isViewportTUI(tui) || hasForeignSplitOwner(tui)) return undefined;

  return bindSplitHost(
    tui,
    (component) => {
      const chat = splitChat(component);
      return chat ? new SidebarSplit(chat, pane, getWidth) : component;
    },
    splitChat,
  );
}

export function sidebarVisible(totalWidth: number, layout: WidthLayout = DEFAULT_WIDTH_LAYOUT): boolean {
  return totalWidth >= layout.minTerminalWidth;
}
