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
  parseMessageLength,
  parseMessageLengthArg,
  parseSidebarPercent,
  parseSidebarWidthArg,
  parseSlateArgs,
  resolveMessageLength,
  messageLengthMessage,
  slateArgumentCompletions,
  SLATE_USAGE,
  SLATE_VERSION,
  SIDEBAR_PERCENT_DEFAULT,
  SIDEBAR_PERCENT_MEDIUM,
  SIDEBAR_PERCENT_NARROW,
  SIDEBAR_PERCENT_WIDE,
  MESSAGE_LENGTH_DEFAULT,
  MESSAGE_LENGTH_LONG,
  MESSAGE_LENGTH_SHORT,
  withCurrent,
  withoutCurrent,
} from "./layout.ts";
import {
  ghCreateIssueArgs,
  issueTemplate,
  newIssueUrl,
  openUrlArgs,
  parseGhIssueUrl,
  SLATE_ISSUES_URL,
  SLATE_NEW_ISSUE_URL,
} from "./bug.ts";
import { syncMessageWindow, type MessageWindow } from "./message-window.ts";
import { applySlateTheme, shouldApplyInstallDefault } from "./install-defaults.ts";

type SlateConfig = {
  density: "comfortable" | "compact";
  footer: "standard" | "minimal";
  sidebarPercent?: number;
  messageLength?: number | "all";
  themeApplied?: boolean;
};

const CONFIG_PATH = join(getAgentDir(), "pi-slate.json");
const DEFAULT_CONFIG: SlateConfig = {
  density: "comfortable",
  footer: "standard",
};

function loadMessageLength(value: unknown): number | "all" | undefined {
  if (value === "all") return "all";
  return parseMessageLength(value);
}

function loadConfig(): SlateConfig {
  try {
    const value = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<SlateConfig>;
    const sidebarPercent = parseSidebarPercent(value.sidebarPercent);
    const messageLength = loadMessageLength(value.messageLength);
    return {
      density: value.density === "compact" ? "compact" : "comfortable",
      footer: value.footer === "minimal" ? "minimal" : "standard",
      ...(sidebarPercent === undefined ? {} : { sidebarPercent }),
      ...(messageLength === undefined ? {} : { messageLength }),
      ...(value.themeApplied === true ? { themeApplied: true } : {}),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function withMessageLength(current: SlateConfig, messageLength: number | "all" | undefined): SlateConfig {
  const next = { ...current };
  if (messageLength === undefined) delete next.messageLength;
  else next.messageLength = messageLength;
  return next;
}

function saveConfig(config: SlateConfig): void {
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, CONFIG_PATH);
}

function withSidebarPercent(current: SlateConfig, percent: number | undefined): SlateConfig {
  const next = { ...current };
  if (percent === undefined) delete next.sidebarPercent;
  else next.sidebarPercent = percent;
  return next;
}

function widthMessage(percent: number | undefined): string {
  if (percent === undefined) return "Sidebar width reset to default";
  if (percent === SIDEBAR_PERCENT_NARROW) return "Sidebar width set to minimum";
  return `Sidebar width set to ${percent}%`;
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
    const logoLines = process.env.TERM === "dumb" || process.env.PI_SLATE_ASCII === "1"
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
    private readonly getConfig: () => SlateConfig,
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

export default function piSlate(pi: ExtensionAPI): void {
  const sidebar = new Sidebar();
  const images = installImagePlaceholders(pi, sidebar);
  let fileSnapshot = "";
  const files = new GitStatusPoller((changes) => {
    fileSnapshot = changes.map((file) => `${file.index}${file.worktree}:${file.path}:${file.origPath ?? ""}`).join("\0");
    sidebar.setFiles(changes);
  });
  const diffs = new GitDiffPreviewLoader();
  const refreshFiles = (): void => {
    diffs.clear();
    void files.refresh();
  };
  const turnImpact = new TurnImpactTracker();
  let config = loadConfig();
  let currentContext: ExtensionContext | undefined;
  let activeEditor: CustomEditor | undefined;
  let activeTui: TUI | undefined;
  let messageWindow: MessageWindow | undefined;
  const tokenRate = new TokenRateTracker();
  let requestRender = (_force = false) => {};

  const syncVisibleMessages = (): void => {
    messageWindow = syncMessageWindow(messageWindow, activeTui, resolveMessageLength(config.messageLength));
  };

  const getContext = (): ExtensionContext => {
    if (!currentContext) throw new Error("pi-slate has not received a session context");
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
  pi.events.on("subagent:async-complete", refreshFiles);
  pi.on("resources_discover", () => {
    queueMicrotask(() => sidebar.setSkillsLoaded(countSkillCommands(pi.getCommands())));
  });

  const install = (ctx: ExtensionContext): void => {
    currentContext = ctx;
    if (ctx.mode !== "tui") return;
    if (shouldApplyInstallDefault(config.themeApplied) && applySlateTheme(ctx)) {
      const next = { ...config, themeApplied: true };
      try {
        saveConfig(next);
        config = next;
      } catch {
        // Retry on the next session if the marker cannot be saved.
      }
    }

    files.start(ctx.cwd);
    diffs.clear();
    sidebar.setCwd(ctx.cwd);
    sidebar.setSelectedPreview(undefined);
    sidebar.setTurnImpact(turnImpact.restore(ctx.sessionManager.getBranch()));
    sidebar.setPreferredWidth(config.sidebarPercent);
    sidebar.setActions({
      persistWidth: (percent) => {
        try {
          const next = withSidebarPercent(config, percent);
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
      activeTui = tui;
      requestRender = (force = false) => tui.requestRender(force);
      sidebar.attach(tui, theme);
      tokenRate.setOnChange(() => syncSidebar(getContext()));
      syncSidebar(ctx);
      queueMicrotask(syncVisibleMessages);
      return new MinimalHeader(theme, getContext, columnWidth);
    });
    ctx.ui.setFooter((tui, theme, footerData) => {
      activeTui = tui;
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
    syncVisibleMessages();
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
    refreshFiles();
  });
  pi.on("turn_end", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
    refreshFiles();
  });
  pi.on("agent_settled", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
    refreshFiles();
  });
  pi.on("session_compact", (_event, ctx) => {
    currentContext = ctx;
    syncSidebar(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    sidebar.setTurnImpact(turnImpact.restore(ctx.sessionManager.getBranch()));
    syncVisibleMessages();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    tokenRate.dispose();
    images.dispose();
    files.dispose();
    diffs.clear();
    messageWindow?.dispose();
    messageWindow = undefined;
    activeTui = undefined;
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

  const apply = (next: SlateConfig, message: string, ctx: ExtensionContext): void => {
    try {
      saveConfig(next);
      config = next;
      sidebar.setPreferredWidth(config.sidebarPercent);
      activeEditor?.setPaddingX(config.density === "compact" ? 0 : 1);
      syncVisibleMessages();
      requestRender();
      ctx.ui.notify(message, "info");
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not save Slate settings: ${messageText}`, "error");
    }
  };

  const pickDensity = async (ctx: ExtensionContext): Promise<SlateConfig["density"] | undefined> => {
    const value = await ctx.ui.select("Density", [
      withCurrent("Comfortable", config.density === "comfortable"),
      withCurrent("Compact", config.density === "compact"),
    ]);
    const key = value ? withoutCurrent(value) : undefined;
    if (key === "Comfortable") return "comfortable";
    if (key === "Compact") return "compact";
    return undefined;
  };

  const pickFooter = async (ctx: ExtensionContext): Promise<SlateConfig["footer"] | undefined> => {
    const value = await ctx.ui.select("Footer", [
      withCurrent("Standard", config.footer === "standard"),
      withCurrent("Minimal", config.footer === "minimal"),
    ]);
    const key = value ? withoutCurrent(value) : undefined;
    if (key === "Standard") return "standard";
    if (key === "Minimal") return "minimal";
    return undefined;
  };

  const pickWidth = async (ctx: ExtensionContext): Promise<{ picked: true; width?: number } | undefined> => {
    const percent = sidebar.preferredWidth ?? config.sidebarPercent;
    const defaultLabel = "Default (20%)";
    const narrowLabel = "Narrow (minimum)";
    const mediumLabel = "Medium (30%)";
    const wideLabel = "Wide (40%)";
    const customLabel = percent !== undefined
      && percent !== SIDEBAR_PERCENT_NARROW
      && percent !== SIDEBAR_PERCENT_DEFAULT
      && percent !== SIDEBAR_PERCENT_MEDIUM
      && percent !== SIDEBAR_PERCENT_WIDE
      ? `Custom (${percent}%)`
      : "Custom…";
    const choice = await ctx.ui.select("Sidebar width", [
      withCurrent(defaultLabel, percent === undefined || percent === SIDEBAR_PERCENT_DEFAULT),
      withCurrent(narrowLabel, percent === SIDEBAR_PERCENT_NARROW),
      withCurrent(mediumLabel, percent === SIDEBAR_PERCENT_MEDIUM),
      withCurrent(wideLabel, percent === SIDEBAR_PERCENT_WIDE),
      withCurrent(customLabel, customLabel.startsWith("Custom (")),
    ]);
    if (!choice) return undefined;
    const key = withoutCurrent(choice);
    if (key === defaultLabel) return { picked: true };
    if (key === narrowLabel) return { picked: true, width: SIDEBAR_PERCENT_NARROW };
    if (key === mediumLabel) return { picked: true, width: SIDEBAR_PERCENT_MEDIUM };
    if (key === wideLabel) return { picked: true, width: SIDEBAR_PERCENT_WIDE };
    if (key !== customLabel) return undefined;
    const typed = await ctx.ui.input(
      "Sidebar percent",
      percent !== undefined && percent > 0 ? String(percent) : "30",
    );
    if (!typed) return undefined;
    const parsed = parseSidebarWidthArg(typed);
    if (!parsed.ok || parsed.percent === undefined) {
      ctx.ui.notify(SLATE_USAGE, "error");
      return undefined;
    }
    return { picked: true, width: parsed.percent };
  };

  const pickMessageLength = async (ctx: ExtensionContext): Promise<{ picked: true; value?: number | "all" } | undefined> => {
    const current = config.messageLength;
    const defaultLabel = `Default (${MESSAGE_LENGTH_DEFAULT})`;
    const shortLabel = String(MESSAGE_LENGTH_SHORT);
    const longLabel = String(MESSAGE_LENGTH_LONG);
    const allLabel = "All";
    const customLabel = typeof current === "number"
      && current !== MESSAGE_LENGTH_DEFAULT
      && current !== MESSAGE_LENGTH_SHORT
      && current !== MESSAGE_LENGTH_LONG
      ? `Custom (${current})`
      : "Custom…";
    const choice = await ctx.ui.select("Message length", [
      withCurrent(defaultLabel, current === undefined || current === MESSAGE_LENGTH_DEFAULT),
      withCurrent(shortLabel, current === MESSAGE_LENGTH_SHORT),
      withCurrent(longLabel, current === MESSAGE_LENGTH_LONG),
      withCurrent(allLabel, current === "all"),
      withCurrent(customLabel, customLabel.startsWith("Custom (")),
    ]);
    if (!choice) return undefined;
    const key = withoutCurrent(choice);
    if (key === defaultLabel) return { picked: true };
    if (key === shortLabel) return { picked: true, value: MESSAGE_LENGTH_SHORT };
    if (key === longLabel) return { picked: true, value: MESSAGE_LENGTH_LONG };
    if (key === allLabel) return { picked: true, value: "all" };
    if (key !== customLabel) return undefined;
    const typed = await ctx.ui.input(
      "Visible messages",
      typeof current === "number" ? String(current) : String(MESSAGE_LENGTH_DEFAULT),
    );
    if (!typed) return undefined;
    const parsed = parseMessageLengthArg(typed);
    if (!parsed.ok) {
      ctx.ui.notify(SLATE_USAGE, "error");
      return undefined;
    }
    return { picked: true, value: parsed.value };
  };

  const openUrl = async (url: string): Promise<boolean> => {
    const { command, args } = openUrlArgs(url);
    const result = await pi.exec(command, args, { timeout: 5000 });
    return result.code === 0;
  };

  const fileBug = async (ctx: ExtensionContext): Promise<void> => {
    const title = (await ctx.ui.input("Issue title", "Short summary"))?.trim();
    if (!title) return;
    const body = await ctx.ui.editor(
      "Issue details",
      issueTemplate({
        slateVersion: SLATE_VERSION,
        piVersion: VERSION,
        platform: `${process.platform} ${process.arch}`,
      }),
    );
    if (body === undefined) return;
    const created = await pi.exec("gh", ghCreateIssueArgs(title, body), { timeout: 20000 });
    if (created.code === 0) {
      const url = parseGhIssueUrl(created.stdout) ?? SLATE_ISSUES_URL;
      ctx.ui.notify(`Filed ${url}`, "info");
      return;
    }
    const openForm = await ctx.ui.confirm("Could not file with gh", "Open a new issue in the browser?");
    if (!openForm) {
      ctx.ui.notify("Issue not filed", "warning");
      return;
    }
    const opened = await openUrl(newIssueUrl(title, body));
    ctx.ui.notify(opened ? "Opened GitHub issue form" : `Open ${SLATE_NEW_ISSUE_URL}`, opened ? "info" : "error");
  };

  const handleBug = async (ctx: ExtensionContext, action?: "file" | "open"): Promise<void> => {
    let next = action;
    if (!next) {
      const choice = await ctx.ui.select("Slate bug", ["File an issue", "Open issues page"]);
      if (choice === "File an issue") next = "file";
      else if (choice === "Open issues page") next = "open";
      else return;
    }
    if (next === "open") {
      const opened = await openUrl(SLATE_ISSUES_URL);
      ctx.ui.notify(opened ? "Opened GitHub issues" : `Open ${SLATE_ISSUES_URL}`, opened ? "info" : "error");
      return;
    }
    await fileBug(ctx);
  };

  pi.registerCommand("slate", {
    description: "Density, footer, sidebar width, message length, or file a bug",
    getArgumentCompletions: slateArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseSlateArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(SLATE_USAGE, "error");
        return;
      }

      let kind = parsed.kind;
      if (kind === "menu") {
        const setting = await ctx.ui.select("Slate", ["Density", "Footer", "Sidebar width", "Message length", "File a bug"]);
        if (setting === "Density") kind = "density";
        else if (setting === "Footer") kind = "footer";
        else if (setting === "Sidebar width") kind = "width-menu";
        else if (setting === "Message length") kind = "message-length-menu";
        else if (setting === "File a bug") kind = "bug-menu";
        else return;
      }

      if (kind === "density") {
        const density = (parsed.kind === "density" ? parsed.value : undefined) ?? await pickDensity(ctx);
        if (!density) return;
        apply({ ...config, density }, `Density set to ${density}`, ctx);
        return;
      }

      if (kind === "footer") {
        const footer = (parsed.kind === "footer" ? parsed.value : undefined) ?? await pickFooter(ctx);
        if (!footer) return;
        apply({ ...config, footer }, `Footer set to ${footer}`, ctx);
        return;
      }

      if (parsed.kind === "width") {
        apply(withSidebarPercent(config, parsed.width), widthMessage(parsed.width), ctx);
        return;
      }

      if (parsed.kind === "message-length") {
        apply(withMessageLength(config, parsed.value), messageLengthMessage(parsed.value), ctx);
        return;
      }

      if (kind === "message-length" || kind === "message-length-menu") {
        const picked = await pickMessageLength(ctx);
        if (!picked) return;
        apply(withMessageLength(config, picked.value), messageLengthMessage(picked.value), ctx);
        return;
      }

      if (kind === "bug" || kind === "bug-menu") {
        await handleBug(ctx, parsed.kind === "bug" ? parsed.action : undefined);
        return;
      }

      const picked = await pickWidth(ctx);
      if (!picked) return;
      apply(withSidebarPercent(config, picked.width), widthMessage(picked.width), ctx);
    },
  });
}
