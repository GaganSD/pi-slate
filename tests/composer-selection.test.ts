import assert from "node:assert/strict";
import test from "node:test";
import { Editor, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  ComposerSelectionController,
  type ComposerSelectionEditor,
} from "../extensions/pi-slate/composer-selection.ts";

class FakeEditor implements ComposerSelectionEditor {
  text: string;
  expandedText?: string;
  setTextCalls: string[] = [];
  inputCalls: string[] = [];
  pasteCalls: string[] = [];
  mouseCalls = 0;
  cursor?: { line: number; col: number };
  renderedLines = ["TOP", "prompt", "BOTTOM"];
  autocomplete = false;
  onInput?: (data: string, editor: FakeEditor) => void;

  constructor(text = "") {
    this.text = text;
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.setTextCalls.push(text);
    this.text = text;
  }

  getExpandedText(): string {
    return this.expandedText ?? this.text;
  }

  getCursor(): { line: number; col: number } {
    return this.cursor ?? { line: 0, col: this.text.length };
  }

  handlePaste = (text: string): void => {
    this.pasteCalls.push(text);
    this.text += text;
  };

  handleInput = (data: string): void => {
    this.inputCalls.push(data);
    if (this.onInput) {
      this.onInput(data, this);
    } else if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
      this.text += data;
    }
  };

  handleMouse = (_event: TuiMouseEvent): TuiMouseEventResult | undefined => {
    this.mouseCalls += 1;
    return { handled: true };
  };

  render = (_width: number): string[] => [...this.renderedLines];

  isShowingAutocomplete(): boolean {
    return this.autocomplete;
  }
}

function attach(
  editor: FakeEditor,
  copy: (text: string) => void = () => {},
  now: () => number = Date.now,
  imagePath?: (number: string) => string | undefined,
): ComposerSelectionController {
  const selection = new ComposerSelectionController(now);
  selection.attach(editor, { copy, imagePath });
  return selection;
}

const SELECT_ALL = "\x1b[97;9u";

test("Kitty super+a selects all without inserting a", () => {
  const editor = new FakeEditor("hello");
  editor.renderedLines = ["TOP", "hello", "BOTTOM"];
  attach(editor);

  editor.handleInput(SELECT_ALL);

  assert.equal(editor.getText(), "hello");
  assert.deepEqual(editor.inputCalls, []);
  assert.match(editor.render(20)[1]!, /\x1b\[7mhello\x1b\[27m/);
});

test("ctrl+a remains an editor key and is not intercepted", () => {
  const editor = new FakeEditor("hello");
  attach(editor);
  editor.handleInput(SELECT_ALL);

  editor.handleInput("\x01");

  assert.deepEqual(editor.inputCalls, ["\x01"]);
  assert.deepEqual(editor.setTextCalls, []);
  assert.equal(editor.getText(), "hello");
});

test("Backspace and printable input replace a select-all range", async (t) => {
  await t.test("Backspace clears", () => {
    const editor = new FakeEditor("hello");
    attach(editor);
    editor.handleInput(SELECT_ALL);

    editor.handleInput("\x7f");

    assert.deepEqual(editor.setTextCalls, [""]);
    assert.deepEqual(editor.inputCalls, []);
    assert.equal(editor.getText(), "");
  });

  await t.test("printable input clears then inserts through the editor", () => {
    const editor = new FakeEditor("hello");
    attach(editor);
    editor.handleInput(SELECT_ALL);

    editor.handleInput("x");

    assert.deepEqual(editor.setTextCalls, [""]);
    assert.deepEqual(editor.inputCalls, ["x"]);
    assert.equal(editor.getText(), "x");
  });
});

test("Enter, Tab, and Ctrl+D keep selected text and pass through", () => {
  for (const key of ["\r", "\t", "\x04"]) {
    const editor = new FakeEditor("keep me");
    attach(editor);
    editor.handleInput(SELECT_ALL);
    editor.handleInput(key);
    assert.equal(editor.getText(), "keep me", key);
    assert.deepEqual(editor.setTextCalls, [], key);
    assert.deepEqual(editor.inputCalls, [key], key);
  }
});

test("ctrl+shift+a selects all and super+c copies expanded text", () => {
  const editor = new FakeEditor("[paste #1]");
  editor.expandedText = "full pasted text";
  const copied: string[] = [];
  attach(editor, (text) => copied.push(text));

  editor.handleInput("\x1b[97;6u");
  editor.handleInput("\x1b[99;9u");

  assert.deepEqual(copied, ["full pasted text"]);
  assert.deepEqual(editor.inputCalls, []);
  assert.equal(editor.getText(), "[paste #1]");
});

test("ctrl+c copies expanded selected text without calling the editor", () => {
  const editor = new FakeEditor("[paste #1]");
  editor.expandedText = "full pasted text";
  const copied: string[] = [];
  attach(editor, (text) => copied.push(text));
  editor.handleInput(SELECT_ALL);

  editor.handleInput("\x03");

  assert.deepEqual(copied, ["full pasted text"]);
  assert.deepEqual(editor.inputCalls, []);
  assert.equal(editor.getText(), "[paste #1]");
});

test("a first unchanged Escape passes through and a second within 500ms clears", () => {
  let time = 1_000;
  const editor = new FakeEditor("hello");
  attach(editor, () => {}, () => time);

  editor.handleInput("\x1b");
  assert.equal(editor.getText(), "hello");
  assert.deepEqual(editor.inputCalls, ["\x1b"]);

  time = 1_500;
  editor.handleInput("\x1b");
  assert.equal(editor.getText(), "");
  assert.deepEqual(editor.setTextCalls, [""]);
  assert.deepEqual(editor.inputCalls, ["\x1b"]);
});

test("an Escape that changes the text does not arm clear", () => {
  let time = 2_000;
  const editor = new FakeEditor("hello");
  editor.onInput = (data, target) => {
    if (data === "\x1b") target.setText("");
  };
  attach(editor, () => {}, () => time);

  editor.handleInput("\x1b");
  time += 100;
  editor.handleInput("\x1b");

  assert.deepEqual(editor.inputCalls, ["\x1b", "\x1b"]);
  assert.deepEqual(editor.setTextCalls, ["", ""]);
});

test("Escape passes through every time for an empty editor", () => {
  let time = 3_000;
  const editor = new FakeEditor("");
  attach(editor, () => {}, () => time);

  editor.handleInput("\x1b");
  time += 100;
  editor.handleInput("\x1b");

  assert.deepEqual(editor.inputCalls, ["\x1b", "\x1b"]);
  assert.deepEqual(editor.setTextCalls, []);
});

test("an outer wrapper still forwards select-all into the selection controller", () => {
  const editor = new FakeEditor("hello");
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  const selectedHandleInput = editor.handleInput;
  const outerCalls: string[] = [];
  editor.handleInput = (data: string): void => {
    outerCalls.push(`outer:${data}`);
    selectedHandleInput.call(editor, data);
  };

  editor.handleInput(SELECT_ALL);
  assert.deepEqual(outerCalls, [`outer:${SELECT_ALL}`]);
  assert.match(editor.render(20)[1]!, /\x1b\[7m/);
  selection.dispose();
});

test("selected rendering leaves borders and padding-only rows unchanged", () => {
  const editor = new FakeEditor("hello world");
  editor.renderedLines = [
    "TOP BORDER",
    "  hello\x1b[0m world  ",
    "    ",
    "BOTTOM BORDER",
  ];
  attach(editor);
  editor.handleInput(SELECT_ALL);

  const lines = editor.render(30);

  assert.equal(lines[0], "TOP BORDER");
  assert.equal(lines[3], "BOTTOM BORDER");
  assert.equal(lines[2], "    ");
  assert.equal(lines[1], "  \x1b[7mhello\x1b[0m\x1b[7m world\x1b[27m  ");
});

test("selected rendering skips invert while autocomplete is open", () => {
  const editor = new FakeEditor("/help");
  editor.autocomplete = true;
  editor.renderedLines = ["TOP", "/help", "BOTTOM", "  help"];
  attach(editor);
  editor.handleInput(SELECT_ALL);

  assert.deepEqual(editor.render(20), ["TOP", "/help", "BOTTOM", "  help"]);
});

test("dispose restores only wrappers installed by the selection controller", () => {
  const editor = new FakeEditor("hello");
  const originalInput = editor.handleInput;
  const originalMouse = editor.handleMouse;
  const selection = attach(editor);
  const laterRender = (_width: number): string[] => ["later"];
  editor.render = laterRender;

  selection.dispose();

  assert.equal(editor.handleInput, originalInput);
  assert.equal(editor.handleMouse, originalMouse);
  assert.equal(editor.render, laterRender);
});

test("a second paste on a collapsed paste marker expands it", () => {
  const editor = new FakeEditor("[paste #1 +18 lines]");
  editor.expandedText = "line\n".repeat(18).trimEnd();
  attach(editor);

  editor.handlePaste("line\n".repeat(18));

  assert.equal(editor.getText(), editor.expandedText);
  assert.deepEqual(editor.pasteCalls, []);
});

test("Cmd+V on an image token expands the stored path", () => {
  const editor = new FakeEditor("see [image-1]");
  editor.cursor = { line: 0, col: 13 };
  attach(editor, () => {}, Date.now, (number) => number === "1" ? "/tmp/shot.png" : undefined);

  editor.handleInput("\x1b[118;9u");

  assert.equal(editor.getText(), "see /tmp/shot.png");
  assert.deepEqual(editor.inputCalls, []);
});

test("paste away from a collapsed token still inserts", () => {
  const editor = new FakeEditor("hello [paste #1 +18 lines]");
  editor.expandedText = "hello hidden paste body";
  editor.cursor = { line: 0, col: 1 };
  attach(editor);

  editor.handlePaste("more");

  assert.deepEqual(editor.pasteCalls, ["more"]);
  assert.equal(editor.getText(), "hello [paste #1 +18 lines]more");
});

test("select-all then Enter submits the prompt instead of erasing it", () => {
  const submitted: string[] = [];
  const editor = new Editor({
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
  } as TUI, { borderColor: (text) => text } as EditorTheme);
  editor.onSubmit = (text) => submitted.push(text);
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  editor.setText("keep this prompt");
  editor.handleInput(SELECT_ALL);
  editor.handleInput("\r");
  assert.deepEqual(submitted, ["keep this prompt"]);
  selection.dispose();
});

test("a second large paste on the real editor expands the collapse marker", () => {
  const editor = new Editor({
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
  } as TUI, { borderColor: (text) => text } as EditorTheme);
  const selection = new ComposerSelectionController();
  selection.attach(editor, { copy() {} });
  const pasted = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");
  editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  assert.match(editor.getText(), /\[paste #1 \+18 lines\]/);
  editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  assert.equal(editor.getText(), pasted);
  selection.dispose();
});
