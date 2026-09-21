import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  copyToClipboard,
  CustomEditor,
  getAgentDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { installImagePlaceholders } from "./image-placeholders.ts";
import { GitStatusPoller } from "./git-status.ts";
import { fileKey, formatFileLabel } from "./files-modified.ts";
import { GitDiffPreviewLoader } from "./git-diff.ts";
import { Sidebar } from "./sidebar.ts";
import { DiffWorkspaceView } from "./workspace.ts";
import { TurnImpactTracker } from "./turn-impact.ts";
import { resolveContextTokens, sessionSpend } from "./context-usage.ts";
import { estimateAssistantTokens, TokenRateTracker } from "./token-rate.ts";
import { createWordPicker } from "./working-words.ts";
import {
  MCP_STATUS_EVENT,
  PI_LOGO,
  PI_LOGO_ASCII,
  centerOffset,
  compactPath,
  countSkillCommands,
  footerVisibility,
  mainColumnWidth,
  modelLabel,
  parseMcpConnectedCount,
  parseSidebarWidth,
  parseSidebarWidthArg,
  SIDEBAR_WIDTH_MEDIUM,
  SIDEBAR_WIDTH_NARROW,
  SIDEBAR_WIDTH_WIDE,
} from "./layout.ts";

type MinimalUiConfig = {
  density: "comfortable" | "compact";
  footer: "standard" | "minimal";
  sidebarWidth?: number;
};

const CONFIG_PATH = join(getAgentDir(), "pi-minimal-ui.json");
const DEFAULT_CONFIG: MinimalUiConfig = {
  density: "comfortable",
  footer: "standard",
};

function loadConfig(): MinimalUiConfig {
  try {
    const value = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<MinimalUiConfig>;
    const sidebarWidth = parseSidebarWidth(value.sidebarWidth);
    return {
      density: value.density === "compact" ? "compact" : "comfortable",
      footer: value.footer === "minimal" ? "minimal" : "standard",
      ...(sidebarWidth === undefined ? {} : { sidebarWidth }),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: MinimalUiConfig): void {
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, CONFIG_PATH);
}

function withSidebarWidth(current: MinimalUiConfig, columns: number | undefined): MinimalUiConfig {
  const next = { ...current };
  if (columns === undefined) delete next.sidebarWidth;
  else next.sidebarWidth = columns;
  return next;
}

function centeredLine(content: string, width: number): string {
  const clipped = truncateToWidth(content, width, "…");
  return `${" ".repeat(centerOffset(width, visibleWidth(clipped)))}${clipped}`;
}

class MinimalHeader implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly getContext: () => ExtensionContext,
    private readonly columnWidth: (width: number) => number,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 20) return [];
    const ctx = this.getContext();
    const path = compactPath(ctx.cwd, homedir());
    const model = modelLabel(ctx.model);
    const effort = ctx.thinkingLevel ? ` · ${ctx.thinkingLevel}` : "";
    const logoLines = process.env.TERM === "dumb" || process.env.PI_MINIMAL_UI_ASCII === "1"
      ? PI_LOGO_ASCII
      : PI_LOGO;
    const column = this.columnWidth(width);
    return [
      ...logoLines.map((line) => centeredLine(this.theme.fg("accent", line), column)),
      "",
      centeredLine(this.theme.fg("muted", `Pi Agent v${VERSION}`), column),
      centeredLine(
        this.theme.fg("muted", `${ctx.model?.provider ?? "provider"}/${model}${effort}`),
        column,
      ),
      centeredLine(this.theme.fg("dim", path), column),
    ];
  }
}

class MinimalFooter implements Component {
  private readonly unsubscribe: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly footerData: {
      getGitBranch(): string | null;
      onBranchChange(callback: () => void): () => void;
    },
    private readonly getContext: () => ExtensionContext,
    private readonly getConfig: () => MinimalUiConfig,
    private readonly columnWidth: (width: number) => number,
  ) {
    this.unsubscribe = footerData.onBranchChange(() => tui.requestRender());
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribe();
  }

  render(width: number): string[] {
    if (width < 12) return [];
    const ctx = this.getContext();
    const config = this.getConfig();
    const column = this.columnWidth(width);
    const visible = footerVisibility(column);
    const project = basename(ctx.cwd) || ctx.cwd;
    const branch = this.footerData.getGitBranch();

    const leftParts = [this.theme.fg("accent", project)];
    if (visible.showBranch && branch) {
      leftParts.push(this.theme.fg("muted", `on ${branch}`));
    }
    const left = leftParts.join(" ");

    const rightParts: string[] = [];
    if (config.footer === "standard" && visible.showModel) {
      rightParts.push(this.theme.fg("muted", modelLabel(ctx.model)));
    }
    if (config.footer === "standard" && visible.showThinking && ctx.thinkingLevel) {
      rightParts.push(this.theme.fg("dim", ctx.thinkingLevel));
    }
    const right = rightParts.join(this.theme.fg("borderMuted", " · "));

    const rightPad = 1;
    const available = Math.max(1, column - visibleWidth(right) - 1 - rightPad);
    const clippedLeft = truncateToWidth(left, available, "…");
    const gap = " ".repeat(
      Math.max(1, column - visibleWidth(clippedLeft) - visibleWidth(right) - rightPad),
    );
    return [`${clippedLeft}${gap}${right}${" ".repeat(rightPad)}`];
  }
}

export default function piMinimalUi(pi: ExtensionAPI): void {
  const sidebar = new Sidebar();
  const images = installImagePlaceholders(pi, sidebar);
  let fileSnapshot = "";
  const files = new GitStatusPoller((changes) => {
    fileSnapshot = changes.map((file) => `${file.index}${file.worktree}:${file.path}:${file.origPath ?? ""}`).join("\0");
    sidebar.setFiles(changes);
  });
  const diffs = new GitDiffPreviewLoader();
  const turnImpact = new TurnImpactTracker();
  let config = loadConfig();
  let currentContext: ExtensionContext | undefined;
  let activeEditor: CustomEditor | undefined;
  const tokenRate = new TokenRateTracker();
  let requestRender = (_force = false) => {};

  const getContext = (): ExtensionContext => {
    if (!currentContext) throw new Error("pi-minimal-ui has not received a session context");
    return currentContext;
  };

  const columnWidth = (width: number): number => {
    return sidebar.splitActive ? width : mainColumnWidth(width, sidebar.preferredWidth);
  };

  const syncSidebar = (ctx: ExtensionContext): void => {
    let tokens: number | null = null;
    let percent: number | null = null;
    let spend = 0;
    try {
      const resolved = resolveContextTokens(
        ctx.getContextUsage(),
        ctx.sessionManager.buildContextEntries(),
        ctx.model?.contextWindow,
      );
      tokens = resolved.tokens;
      percent = resolved.percent;
      spend = sessionSpend(ctx.sessionManager.getBranch());
    } catch {
      return;
    }
    sidebar.setContext({ tokens, percent, tokensPerSec: tokenRate.rate(), spend });
    sidebar.setSkillsLoaded(countSkillCommands(pi.getCommands()));
  };

  pi.events.on(MCP_STATUS_EVENT, (data) => {
    sidebar.setMcpConnected(parseMcpConnectedCount(data));
  });
  pi.on("resources_discover", () => {
    queueMicrotask(() => sidebar.setSkillsLoaded(countSkillCommands(pi.getCommands())));
  });

  const install = (ctx: ExtensionContext): void => {
    currentContext = ctx;
    if (ctx.mode !== "tui") return;

    files.start(ctx.cwd);
    diffs.clear();
    sidebar.setCwd(ctx.cwd);
    sidebar.setSelectedPreview(undefined);
    sidebar.setTurnImpact(turnImpact.reset());
    sidebar.setPreferredWidth(config.sidebarWidth);
    sidebar.setActions({
      persistWidth: (columns) => {
        try {
          const next = withSidebarWidth(config, columns);
          saveConfig(next);
          config = next;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not save sidebar width: ${message}`, "error");
        }
      },
      copyPath: (filePath) => {
        void copyToClipboard(filePath).then(
          () => ctx.ui.notify("Copied file location", "info"),
          () => ctx.ui.notify("Could not copy file location", "error"),
        );
      },
      selectFile: (file) => {
        const selectionId = fileKey(file);
        const title = formatFileLabel(file);
        const cached = diffs.peek(ctx.cwd, file, fileSnapshot);
        sidebar.setSelectedPreview(new DiffWorkspaceView(
          selectionId,
          cached?.state ?? "loading",
          cached?.text ?? "",
          ctx.ui.theme,
          title,
        ));
        void diffs.select(ctx.cwd, file, fileSnapshot, (result) => {
          sidebar.setSelectedPreview(new DiffWorkspaceView(selectionId, result.state, result.text, ctx.ui.theme, title));
        });
      },
    });
    ctx.ui.setTitle(`Pi · ${basename(ctx.cwd)}`);
    ctx.ui.setHeader((tui, theme) => {
      requestRender = (force = false) => tui.requestRender(force);
      sidebar.attach(tui, theme);
      tokenRate.setOnChange(() => syncSidebar(getContext()));
      syncSidebar(ctx);
      return new MinimalHeader(theme, getContext, columnWidth);
    });
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = (force = false) => tui.requestRender(force);
      return new MinimalFooter(tui, theme, footerData, getContext, () => config, columnWidth);
    });
    ctx.ui.setEditorComponent((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
      const minimalEditorTheme: EditorTheme = {
        ...editorTheme,
        borderColor: (text) => ctx.ui.theme.fg("borderMuted", text),
      };
      activeEditor = new CustomEditor(tui, minimalEditorTheme, keybindings, {
        paddingX: config.density === "compact" ? 0 : 1,
        autocompleteMaxVisible: 8,
        embedWorkingStatus: true,
      });
      images.attachEditor(activeEditor);
      return activeEditor;
    });
    ctx.ui.setWorkingIndicator({
      frames: [
        ctx.ui.theme.fg("dim", "·"),
        ctx.ui.theme.fg("muted", "•"),
        ctx.ui.theme.fg("accent", "●"),
        ctx.ui.theme.fg("muted", "•"),
      ],
      intervalMs: 240,
    });
    requestRender(true);
  };

  const workingWords = createWordPicker();

  pi.on("session_start", (_event, ctx) => install(ctx));
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingMessage(workingWords.next());
  });
  pi.on("model_select", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    currentContext = ctx;
    requestRender();
  });
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
  pi.on("before_agent_start", () => {
    // Last Turn is the last user prompt, not each LLM round inside it.
    sidebar.setTurnImpact(turnImpact.reset());
  });
  pi.on("tool_call", (event) => {
    sidebar.setTurnImpact(turnImpact.toolCall({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input as Record<string, unknown> | undefined,
    }));
  });
  pi.on("tool_execution_end", (event) => {
    sidebar.setTurnImpact(turnImpact.toolEnd({
      toolCallId: event.toolCallId,
      isError: event.isError,
      result: event.result,
      toolName: event.toolName,
    }));
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
  pi.on("session_compact", (event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    tokenRate.dispose();
    images.dispose();
    files.dispose();
    diffs.clear();
    sidebar.dispose();
    requestRender(true);
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setWorkingIndicator();
    ctx.ui.setWorkingMessage();
    activeEditor = undefined;
    requestRender = () => {};
  });

  pi.registerCommand("sidebar-width", {
    description: "Set the sidebar width, or reset to the default 20%",
    handler: async (args, ctx) => {
      let width: number | undefined;
      if (args.trim()) {
        const parsed = parseSidebarWidthArg(args);
        if (!parsed.ok) {
          ctx.ui.notify("Usage: /sidebar-width [default|narrow|medium|wide|<columns>]", "error");
          return;
        }
        width = parsed.width;
      } else {
        const choice = await ctx.ui.select("Sidebar width", [
          "Default (20%)",
          `Narrow (${SIDEBAR_WIDTH_NARROW})`,
          `Medium (${SIDEBAR_WIDTH_MEDIUM})`,
          `Wide (${SIDEBAR_WIDTH_WIDE})`,
        ]);
        if (!choice) return;
        if (choice.startsWith("Default")) width = undefined;
        else if (choice.startsWith("Narrow")) width = SIDEBAR_WIDTH_NARROW;
        else if (choice.startsWith("Medium")) width = SIDEBAR_WIDTH_MEDIUM;
        else width = SIDEBAR_WIDTH_WIDE;
      }

      try {
        const next = withSidebarWidth(config, width);
        saveConfig(next);
        config = next;
        sidebar.setPreferredWidth(width);
        requestRender();
        ctx.ui.notify(
          width === undefined ? "Sidebar width reset to default" : `Sidebar width set to ${width}`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not save sidebar width: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("minimal-ui", {
    description: "Configure the pi-minimal-ui appearance",
    handler: async (_args, ctx) => {
      const setting = await ctx.ui.select("Minimal UI", ["Density", "Footer"]);
      if (!setting) return;
      let nextConfig = { ...config };

      if (setting === "Density") {
        const value = await ctx.ui.select("Density", ["Comfortable", "Compact"]);
        if (!value) return;
        nextConfig = { ...nextConfig, density: value.toLowerCase() as MinimalUiConfig["density"] };
      } else {
        const value = await ctx.ui.select("Footer", ["Standard", "Minimal"]);
        if (!value) return;
        nextConfig = { ...nextConfig, footer: value.toLowerCase() as MinimalUiConfig["footer"] };
      }

      try {
        saveConfig(nextConfig);
        config = nextConfig;
        activeEditor?.setPaddingX(config.density === "compact" ? 0 : 1);
        requestRender();
        ctx.ui.notify("Minimal UI updated", "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not save Minimal UI settings: ${message}`, "error");
      }
    },
  });
}
