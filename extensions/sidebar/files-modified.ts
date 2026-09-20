export type FileChange = {
  index: string;
  worktree: string;
  path: string;
  origPath?: string;
};

export type FilesPanelLine =
  | { type: "heading"; count: number }
  | { type: "empty" }
  | { type: "file"; item: FileChange };

export type FileTone = "success" | "warning" | "error" | "accent" | "muted";

export type FileMark = {
  mark: string;
  tone: FileTone;
};

export type FileMarkStyle = {
  marks: {
    fileNew: string;
    fileModified: string;
    fileDeleted: string;
    fileRenamed: string;
    fileUnmerged: string;
  };
  tones: {
    fileNew: FileTone;
    fileModified: FileTone;
    fileDeleted: FileTone;
    fileRenamed: FileTone;
    fileUnmerged: FileTone;
  };
};

export const DEFAULT_FILE_MARK_STYLE: FileMarkStyle = {
  marks: {
    fileNew: "N",
    fileModified: "M",
    fileDeleted: "D",
    fileRenamed: "R",
    fileUnmerged: "U",
  },
  tones: {
    fileNew: "success",
    fileModified: "warning",
    fileDeleted: "error",
    fileRenamed: "accent",
    fileUnmerged: "error",
  },
};

export function parsePorcelain(output: string): FileChange[] {
  if (!output) return [];
  const parts = output.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part.length < 3) continue;
    const index = part[0] ?? "";
    const worktree = part[1] ?? "";
    if (!index || !worktree) continue;
    const path = part.slice(3);
    if (!path) continue;
    if (isRenameOrCopy(index, worktree)) {
      const next = parts[i + 1];
      if (next) {
        files.push({ index, worktree, path: next, origPath: path });
        i += 1;
        continue;
      }
    }
    files.push({ index, worktree, path });
  }
  return files;
}

export function formatFileCode(change: FileChange): string {
  return `${change.index}${change.worktree}`;
}

export function fileMark(change: FileChange, style: FileMarkStyle = DEFAULT_FILE_MARK_STYLE): FileMark {
  const index = change.index;
  const worktree = change.worktree;
  if (index === "?" || worktree === "?") return { mark: style.marks.fileNew, tone: style.tones.fileNew };
  if (index === "U" || worktree === "U" || index === "A" && worktree === "A") {
    return { mark: style.marks.fileUnmerged, tone: style.tones.fileUnmerged };
  }
  if (index === "R" || worktree === "R" || index === "C" || worktree === "C") {
    return { mark: style.marks.fileRenamed, tone: style.tones.fileRenamed };
  }
  if (index === "D" || worktree === "D") return { mark: style.marks.fileDeleted, tone: style.tones.fileDeleted };
  if (index === "A" || worktree === "A") return { mark: style.marks.fileNew, tone: style.tones.fileNew };
  return { mark: style.marks.fileModified, tone: style.tones.fileModified };
}

export function formatFileLabel(change: FileChange): string {
  return change.origPath ? `${change.origPath} \u2192 ${change.path}` : change.path;
}

export function clampFilesOffset(offset: number, fileCount: number, bodyHeight: number): number {
  const maxOffset = Math.max(0, fileCount - Math.max(0, bodyHeight));
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(maxOffset, Math.floor(offset)));
}

export function filesPanel(
  files: FileChange[],
  height: number,
  offset = 0,
): { lines: FilesPanelLine[]; offset: number } {
  const maxHeight = Math.max(0, Math.floor(height));
  if (maxHeight < 1) return { lines: [], offset: 0 };
  if (files.length === 0) {
    if (maxHeight === 1) return { lines: [{ type: "empty" }], offset: 0 };
    return { lines: [{ type: "heading", count: 0 }, { type: "empty" }], offset: 0 };
  }

  const showHeading = maxHeight > 1;
  const lines: FilesPanelLine[] = [];
  if (showHeading) lines.push({ type: "heading", count: files.length });
  const bodyHeight = maxHeight - lines.length;
  const nextOffset = clampFilesOffset(offset, files.length, bodyHeight);
  for (const item of files.slice(nextOffset, nextOffset + bodyHeight)) {
    lines.push({ type: "file", item });
  }
  return { lines, offset: nextOffset };
}

export function fileAtPanelRow(
  files: FileChange[],
  height: number,
  offset: number,
  row: number,
): FileChange | undefined {
  const line = filesPanel(files, height, offset).lines[row];
  return line?.type === "file" ? line.item : undefined;
}

export function sameFiles(left: FileChange[], right: FileChange[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((file, index) => {
    const other = right[index];
    return other !== undefined
      && file.index === other.index
      && file.worktree === other.worktree
      && file.path === other.path
      && file.origPath === other.origPath;
  });
}

function isRenameOrCopy(index: string, worktree: string): boolean {
  return index === "R" || index === "C" || worktree === "R" || worktree === "C";
}
