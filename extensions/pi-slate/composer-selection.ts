import {
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export type ComposerSelectionEditor = {
  getText(): string;
  setText(text: string): void;
  getExpandedText(): string;
  getCursor(): { line: number; col: number };
  handleInput(data: string): void;
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  render(width: number): string[];
  isShowingAutocomplete(): boolean;
};

export type ComposerSelectionOptions = {
  copy(text: string): void;
  onCopyError?(error: unknown): void;
};

type InstalledEditor = {
  editor: ComposerSelectionEditor;
  originalHandleInput: ComposerSelectionEditor["handleInput"];
  originalHandleMouse: ComposerSelectionEditor["handleMouse"];
  originalRender: ComposerSelectionEditor["render"];
  handleInput: ComposerSelectionEditor["handleInput"];
  handleMouse: ComposerSelectionEditor["handleMouse"];
  render: ComposerSelectionEditor["render"];
};

const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|_[^\x07]*(?:\x07|$)|\][^\x07]*(?:\x07|\x1b\\|$))/y;
const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";
const RESET = "\x1b[0m";

function selectedLine(line: string): string {
  let firstText = -1;
  let lastTextEnd = -1;

  for (let index = 0; index < line.length;) {
    ESCAPE_SEQUENCE.lastIndex = index;
    const escape = ESCAPE_SEQUENCE.exec(line);
    if (escape) {
      index += escape[0].length;
      continue;
    }

    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (!/\s/u.test(character)) {
      if (firstText === -1) firstText = index;
      lastTextEnd = index + character.length;
    }
    index += character.length;
  }

  // Whitespace-only rendered rows are editor padding/chrome, not prompt text.
  if (firstText === -1) return line;
  const before = line.slice(0, firstText);
  const text = line.slice(firstText, lastTextEnd).replaceAll(RESET, `${RESET}${REVERSE_ON}`);
  const after = line.slice(lastTextEnd);
  return `${before}${REVERSE_ON}${text}${REVERSE_OFF}${after}`;
}

function isSelectAll(data: string): boolean {
  return matchesKey(data, "super+a") || matchesKey(data, "ctrl+shift+a");
}

function isCopy(data: string): boolean {
  return data === "\x03" || matchesKey(data, "ctrl+c") || matchesKey(data, "super+c");
}

function isArrow(data: string): boolean {
  const modifiers = ["", "shift+", "ctrl+", "alt+", "super+"] as const;
  const arrows = ["up", "down", "left", "right"] as const;
  return modifiers.some((modifier) => arrows.some((arrow) => matchesKey(data, `${modifier}${arrow}`)));
}

function isPrintable(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}

function isReplace(data: string): boolean {
  return isPrintable(data)
    || data.includes("\x1b[200~")
    || matchesKey(data, "shift+enter")
    || matchesKey(data, "ctrl+j");
}

/** Adds Phase 1 all-or-nothing selection semantics to one composer editor. */
export class ComposerSelectionController {
  private installed?: InstalledEditor;
  private selectedLength?: number;
  private escapeArmed = false;
  private escapeArmedAt = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  attach(editor: ComposerSelectionEditor, options: ComposerSelectionOptions): void {
    this.dispose();

    // Attach this before ImagePeek so peek stays outermost and still sees
    // setText replacements via its handleInput wrapper.
    const originalHandleInput = editor.handleInput;
    const originalHandleMouse = editor.handleMouse;
    const originalRender = editor.render;

    const collapse = (): void => {
      this.selectedLength = undefined;
    };

    const handleInput = (data: string): void => {
      if (matchesKey(data, "escape")) {
        const timestamp = this.now();
        if (
          this.escapeArmed &&
          timestamp - this.escapeArmedAt <= 500 &&
          editor.getText().trim()
        ) {
          editor.setText("");
          collapse();
          this.escapeArmed = false;
          return;
        }

        if (this.selectedLength !== undefined) collapse();
        const before = editor.getText();
        originalHandleInput.call(editor, data);
        const after = editor.getText();
        this.escapeArmed = after === before && after.trim().length > 0;
        this.escapeArmedAt = this.now();
        return;
      }

      this.escapeArmed = false;

      if (isSelectAll(data)) {
        const length = editor.getText().length;
        this.selectedLength = length > 0 ? length : undefined;
        return;
      }

      if (this.selectedLength === undefined) {
        originalHandleInput.call(editor, data);
        return;
      }

      if (isCopy(data)) {
        const text = editor.getExpandedText();
        try {
          options.copy(text);
        } catch (error) {
          options.onCopyError?.(error);
        } finally {
          collapse();
        }
        return;
      }

      if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
        editor.setText("");
        collapse();
        return;
      }

      if (isReplace(data)) {
        editor.setText("");
        try {
          originalHandleInput.call(editor, data);
        } finally {
          collapse();
        }
        return;
      }

      collapse();
      originalHandleInput.call(editor, data);
    };

    const handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
      collapse();
      return originalHandleMouse.call(editor, event);
    };

    const render = (width: number): string[] => {
      const lines = originalRender.call(editor, width);
      // Autocomplete is appended after the bottom border. Do not invert that chrome.
      if (this.selectedLength === undefined || lines.length < 3 || editor.isShowingAutocomplete()) {
        return lines;
      }
      return lines.map((line, index) => {
        if (index === 0 || index === lines.length - 1) return line;
        return selectedLine(line);
      });
    };

    editor.handleInput = handleInput;
    editor.handleMouse = handleMouse;
    editor.render = render;
    this.installed = {
      editor,
      originalHandleInput,
      originalHandleMouse,
      originalRender,
      handleInput,
      handleMouse,
      render,
    };
  }

  dispose(): void {
    const installed = this.installed;
    if (installed) {
      if (installed.editor.handleInput === installed.handleInput) {
        installed.editor.handleInput = installed.originalHandleInput;
      }
      if (installed.editor.handleMouse === installed.handleMouse) {
        installed.editor.handleMouse = installed.originalHandleMouse;
      }
      if (installed.editor.render === installed.render) {
        installed.editor.render = installed.originalRender;
      }
    }
    this.installed = undefined;
    this.selectedLength = undefined;
    this.escapeArmed = false;
  }
}
