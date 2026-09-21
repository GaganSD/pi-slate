import assert from "node:assert/strict";
import test from "node:test";
import {
  applySlateTheme,
  shouldApplyInstallDefault,
  SLATE_THEME,
} from "../extensions/pi-slate/install-defaults.ts";

test("install defaults apply once", () => {
  assert.equal(shouldApplyInstallDefault(undefined), true);
  assert.equal(shouldApplyInstallDefault(false), true);
  assert.equal(shouldApplyInstallDefault(true), false);
});

test("theme selection reports success from the UI", () => {
  assert.equal(applySlateTheme({ ui: { setTheme: (name) => {
    assert.equal(name, SLATE_THEME);
    return { success: true };
  } } }), true);
  assert.equal(applySlateTheme({ ui: { setTheme: () => ({ success: false, error: "missing" }) } }), false);
});
