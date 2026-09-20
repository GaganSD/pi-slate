export const SIDEBAR_DOCK_LINES = 4;
export const FILES_WIDGET_MAX_LINES = 5;

export function sidebarDockLines(): number {
  return SIDEBAR_DOCK_LINES;
}

export function sidebarRowSlots(
  height: number,
  dockLines = SIDEBAR_DOCK_LINES,
): {
  contentHeight: number;
  dockHeight: number;
} {
  const paneHeight = Math.max(0, Math.floor(height));
  const dockHeight = Math.min(Math.max(0, dockLines), paneHeight);
  return {
    contentHeight: paneHeight - dockHeight,
    dockHeight,
  };
}

export function splitContentSlot(
  height: number,
  planCount: number,
  hasPeek: boolean,
): { planHeight: number; peekHeight: number; dividerHeight: number } {
  const slotHeight = Math.max(0, Math.floor(height));
  if (slotHeight === 0) return { planHeight: 0, peekHeight: 0, dividerHeight: 0 };
  if (planCount === 0) return { planHeight: 0, peekHeight: slotHeight, dividerHeight: 0 };
  if (!hasPeek) return { planHeight: slotHeight, peekHeight: 0, dividerHeight: 0 };
  if (slotHeight === 1) return { planHeight: 1, peekHeight: 0, dividerHeight: 0 };
  if (slotHeight === 2) return { planHeight: 1, peekHeight: 1, dividerHeight: 0 };

  const remaining = slotHeight - 1;
  const planHeight = Math.floor(remaining / 2);
  return {
    planHeight,
    peekHeight: remaining - planHeight,
    dividerHeight: 1,
  };
}

export function filesWidgetDesiredHeight(
  fileCount: number,
  maxLines = FILES_WIDGET_MAX_LINES,
): number {
  const cap = Math.max(2, Math.floor(maxLines));
  if (fileCount <= 0) return 2;
  return Math.min(cap, 1 + fileCount);
}

export function splitSidebarContent(
  height: number,
  filesDesired: number,
  filesMaxLines = FILES_WIDGET_MAX_LINES,
): {
  filesHeight: number;
  filesDivider: number;
  planHeight: number;
  dividerHeight: number;
  peekHeight: number;
} {
  const slotHeight = Math.max(0, Math.floor(height));
  const cap = Math.max(2, Math.floor(filesMaxLines));
  const filesWant = Math.max(0, Math.min(cap, Math.floor(filesDesired)));
  if (slotHeight === 0) {
    return { filesHeight: 0, filesDivider: 0, planHeight: 0, dividerHeight: 0, peekHeight: 0 };
  }

  const minRest = 2;
  let filesHeight = Math.min(filesWant, slotHeight);
  if (slotHeight > filesHeight && slotHeight - filesHeight < minRest) {
    filesHeight = Math.max(0, slotHeight - minRest);
  }

  let filesDivider = 0;
  const rest = slotHeight - filesHeight;
  if (filesHeight > 0 && rest >= 3) filesDivider = 1;

  const upper = splitContentSlot(slotHeight - filesHeight - filesDivider, 1, true);
  return {
    filesHeight,
    filesDivider,
    ...upper,
  };
}
