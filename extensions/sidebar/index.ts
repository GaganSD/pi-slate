import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  loadSidebarConfig,
  normalizeSidebarConfig,
  saveSidebarConfig,
  sidebarConfigPath,
  type SidebarSettings,
} from "./config.ts";
import { GitStatusPoller } from "./git-status.ts";
import { countSkillCommands, MCP_STATUS_EVENT, parseMcpConnectedCount } from "./layout.ts";
import { Sidebar } from "./sidebar.ts";
import { estimateAssistantTokens, TokenRateTracker } from "./token-rate.ts";
import { installTodoTool } from "./todo.ts";

class AttachHook implements Component {
  invalidate(): void {}
  render(): string[] {
    return [];
  }
}

export default function sidebarExtension(pi: ExtensionAPI): void {
  const sidebar = new Sidebar();
  const files = new GitStatusPoller((changes) => sidebar.setFiles(changes));
  const tokenRate = new TokenRateTracker();
  let loaded = loadSidebarConfig();
  let currentContext: ExtensionContext | undefined;
  let requestRender = (_force = false) => {};
  let warnedForeign = false;

  sidebar.setSettings(loaded.settings);

  const getContext = (): ExtensionContext => {
    if (!currentContext) throw new Error("sidebar has not received a session context");
    return currentContext;
  };

  const persist = (next: Record<string, unknown>, ctx: ExtensionContext): SidebarSettings | undefined => {
    try {
      const settings = saveSidebarConfig(next, sidebarConfigPath());
      loaded = { settings, stored: normalizeSidebarConfig(next) };
      sidebar.setSettings(settings);
      requestRender(true);
      return settings;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not save sidebar settings: ${message}`, "error");
      return undefined;
    }
  };

  const syncSidebar = (ctx: ExtensionContext): void => {
    let tokens: number | null = null;
    let percent: number | null = null;
    try {
      const usage = ctx.getContextUsage();
      if (usage) {
        tokens = usage.tokens;
        percent = usage.percent;
      }
    } catch {
      return;
    }
    sidebar.setContext({ tokens, percent, tokensPerSec: tokenRate.rate() });
    sidebar.setSkillsLoaded(countSkillCommands(pi.getCommands()));
  };

  const mount = (ctx: ExtensionContext, tui: TUI, theme: Theme): void => {
    requestRender = (force = false) => tui.requestRender(force);
    tokenRate.setOnChange(() => syncSidebar(getContext()));
    const result = sidebar.attach(tui, theme);
    if (result === "foreign" && !warnedForeign) {
      warnedForeign = true;
      ctx.ui.notify("Sidebar split not installed because another layout extension owns the root.", "warning");
    }
    syncSidebar(ctx);
  };

  installTodoTool(pi, sidebar, () => requestRender());
  pi.events.on(MCP_STATUS_EVENT, (data) => {
    sidebar.setMcpConnected(parseMcpConnectedCount(data) ?? 0);
  });
  pi.on("resources_discover", () => {
    queueMicrotask(() => sidebar.setSkillsLoaded(countSkillCommands(pi.getCommands())));
  });

  const install = (ctx: ExtensionContext): void => {
    currentContext = ctx;
    if (ctx.mode !== "tui") return;

    files.start(ctx.cwd);
    sidebar.setCwd(ctx.cwd);
    sidebar.setActions({
      copyPath: (filePath) => {
        void copyToClipboard(filePath).then(
          () => ctx.ui.notify("Copied file location", "info"),
          () => ctx.ui.notify("Could not copy file location", "error"),
        );
      },
    });
    ctx.ui.setWidget("pi-extensions.sidebar", (tui, theme) => {
      mount(ctx, tui, theme);
      return new AttachHook();
    });
    requestRender(true);
  };

  pi.on("session_start", (_event, ctx) => install(ctx));
  pi.on("message_start", (event, ctx) => {
    currentContext = ctx;
    if (event.message.role === "assistant") tokenRate.startMessage();
  });
  pi.on("message_update", (event, ctx) => {
    currentContext = ctx;
    if (event.message.role !== "assistant") return;
    tokenRate.observePartial(estimateAssistantTokens(event.message));
  });
  pi.on("message_end", (event, ctx) => {
    currentContext = ctx;
    if (event.message.role === "assistant") tokenRate.endMessage();
    syncSidebar(ctx);
  });
  pi.on("tool_execution_end", () => {
    void files.refresh();
  });
  pi.on("turn_end", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
    void files.refresh();
  });
  pi.on("agent_settled", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
    void files.refresh();
  });
  pi.on("session_shutdown", () => {
    tokenRate.dispose();
    files.dispose();
    sidebar.dispose();
    requestRender(true);
    requestRender = () => {};
  });

  pi.registerCommand("sidebar", {
    description: "Configure the session sidebar",
    handler: async (args, ctx) => {
      const apply = (patch: Record<string, unknown>, message: string) => {
        const stored = { ...loaded.stored, ...patch };
        if (!persist(stored, ctx)) return;
        ctx.ui.notify(message, "info");
      };

      const token = args.trim().toLowerCase();
      if (token === "on" || token === "enable") {
        apply({ enabled: true }, "Sidebar enabled");
        return;
      }
      if (token === "off" || token === "disable") {
        apply({ enabled: false }, "Sidebar disabled");
        return;
      }
      if (token === "reset") {
        const settings = persist({}, ctx);
        if (settings) ctx.ui.notify("Sidebar settings reset", "info");
        return;
      }
      if (token === "ascii") {
        apply({ ascii: !loaded.settings.ascii }, loaded.settings.ascii ? "Sidebar unicode marks" : "Sidebar ASCII marks");
        return;
      }

      const setting = await ctx.ui.select("Sidebar", [
        loaded.settings.enabled ? "Disable" : "Enable",
        "Width",
        "Files max",
        loaded.settings.ascii ? "Unicode marks" : "ASCII marks",
        "Reset",
      ]);
      if (!setting) return;

      if (setting === "Enable") {
        apply({ enabled: true }, "Sidebar enabled");
        return;
      }
      if (setting === "Disable") {
        apply({ enabled: false }, "Sidebar disabled");
        return;
      }
      if (setting === "Reset") {
        const settings = persist({}, ctx);
        if (settings) ctx.ui.notify("Sidebar settings reset", "info");
        return;
      }
      if (setting === "ASCII marks" || setting === "Unicode marks") {
        const ascii = setting === "ASCII marks";
        apply({ ascii }, ascii ? "Sidebar ASCII marks" : "Sidebar unicode marks");
        return;
      }
      if (setting === "Width") {
        const value = await ctx.ui.input("Sidebar width percent (10-40)", String(loaded.settings.widthPercent));
        if (value === undefined) return;
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          ctx.ui.notify("Width must be a number", "error");
          return;
        }
        apply({ widthPercent: parsed }, "Sidebar width updated");
        return;
      }
      const value = await ctx.ui.input("Files max lines (2-20)", String(loaded.settings.filesMaxLines));
      if (value === undefined) return;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        ctx.ui.notify("Files max must be a number", "error");
        return;
      }
      apply({ filesMaxLines: parsed }, "Sidebar files window updated");
    },
  });
}
