import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SLATE_THEME = "pi-slate";

export function shouldApplyInstallDefault(applied: boolean | undefined): boolean {
  return applied !== true;
}

export function applySlateTheme(ctx: Pick<ExtensionContext, "ui">): boolean {
  return ctx.ui.setTheme(SLATE_THEME).success === true;
}
