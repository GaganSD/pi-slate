export const WORKSPACE_CAPTION_LINES = 1;
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

export function workspacePaneSlots(height: number): {
  imageHeight: number;
  captionHeight: number;
} {
  const paneHeight = Math.max(0, Math.floor(height));
  if (paneHeight === 0) return { imageHeight: 0, captionHeight: 0 };
  if (paneHeight === 1) return { imageHeight: 0, captionHeight: 1 };
  const captionHeight = Math.min(WORKSPACE_CAPTION_LINES, paneHeight - 1);
  return { imageHeight: paneHeight - captionHeight, captionHeight };
}

export function fitImageCells(
  imageWidthPx: number,
  imageHeightPx: number,
  maxCols: number,
  maxRows: number,
  cellWidthPx = 9,
  cellHeightPx = 18,
): { columns: number; rows: number } {
  const maxWidth = Math.max(0, Math.floor(maxCols));
  const maxHeight = Math.max(0, Math.floor(maxRows));
  if (maxWidth < 1 || maxHeight < 1) return { columns: 0, rows: 0 };
  const widthPx = Math.max(1, imageWidthPx);
  const heightPx = Math.max(1, imageHeightPx);
  const cellW = Math.max(1, cellWidthPx);
  const cellH = Math.max(1, cellHeightPx);
  const scale = Math.min(1, (maxWidth * cellW) / widthPx, (maxHeight * cellH) / heightPx);
  return {
    columns: Math.max(1, Math.min(maxWidth, Math.ceil((widthPx * scale) / cellW))),
    rows: Math.max(1, Math.min(maxHeight, Math.ceil((heightPx * scale) / cellH))),
  };
}

export function placeWorkspaceImage(
  paneHeight: number,
  imageRows: number,
  captionLines: string[],
): { lines: string[]; imageStart: number; imageRows: number; captionStart: number } {
  const pane = Math.max(0, Math.floor(paneHeight));
  const captions = captionLines.slice(0, pane);
  const usedImageRows = Math.min(Math.max(0, imageRows), Math.max(0, pane - captions.length));
  const imageStart = pane - usedImageRows - captions.length;
  const captionStart = imageStart + usedImageRows;
  const lines = Array.from({ length: pane }, () => "");
  for (let i = 0; i < captions.length; i++) {
    lines[captionStart + i] = captions[i] ?? "";
  }
  return { lines, imageStart, imageRows: usedImageRows, captionStart };
}
