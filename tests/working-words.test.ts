import assert from "node:assert/strict";
import test from "node:test";
import { WORKING_WORDS, createWordPicker } from "../extensions/pi-minimal-ui/working-words.ts";

test("shuffle bag deals every word once before repeating", () => {
  let i = 0;
  const seq = [0.9, 0.1, 0.8, 0.2, 0.7, 0.3, 0.6, 0.4];
  const picker = createWordPicker(WORKING_WORDS, () => seq[i++ % seq.length]!);
  const first = Array.from({ length: WORKING_WORDS.length }, () => picker.next());
  assert.deepEqual(new Set(first).size, WORKING_WORDS.length);
  const second = Array.from({ length: WORKING_WORDS.length }, () => picker.next());
  assert.deepEqual(new Set(second).size, WORKING_WORDS.length);
  assert.notEqual(first[first.length - 1], second[0]);
});
