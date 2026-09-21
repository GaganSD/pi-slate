import {
  HStack,
  isViewportTUI,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  SIDEBAR_MIN_TERMINAL_WIDTH,
  SIDEBAR_MIN_WIDTH,
  workspaceColumnWidth,
} from "./layout.ts";
import { bindSplitHost } from "./split-host.ts";

const SIDEBAR_SPLIT = Symbol.for("pi-minimal-ui.sidebar-split");

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
  chat(): Component {
    return this.entries[0]?.component ?? this.children[0]!;
  }

  constructor(chat: Component, pane: Component, preferredWidth?: () => number | undefined) {
    const gutter = new SidebarGutter(pane);
    super([
      // Skip full-width intrinsic measurement: switching widths thrashes leaf render caches.
      { component: chat, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      {
        component: gutter,
        grow: 0,
        shrink: 0,
        minSize: SIDEBAR_MIN_WIDTH,
        basis: SIDEBAR_MIN_WIDTH,
        visible: (viewport) => {
          const width = workspaceColumnWidth(viewport.width, preferredWidth?.());
          const entry = this.entries[1];
          if (entry && entry.basis !== width) entry.basis = Math.max(SIDEBAR_MIN_WIDTH, width);
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
  return component.chat();
}

export function installSidebarSplit(
  tui: TUI,
  pane: Component,
  preferredWidth?: () => number | undefined,
): (() => void) | undefined {
  if (!isViewportTUI(tui)) return undefined;

  return bindSplitHost(
    tui,
    (component) => {
      const chat = splitChat(component);
      return chat ? new SidebarSplit(chat, pane, preferredWidth) : component;
    },
    splitChat,
  );
}

export function sidebarVisible(totalWidth: number): boolean {
  return totalWidth >= SIDEBAR_MIN_TERMINAL_WIDTH;
}
