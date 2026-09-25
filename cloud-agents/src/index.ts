import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnInherit } from "./util.ts";
import {
  formatStartupFailure,
  runCloudStartup,
  type CloudRuntime,
  type StartupOutcome,
} from "./setup.ts";
import { formatCloudStatus, inspectCloudStatus } from "./status.ts";
import { DEFAULT_STATE_DIR, loadState } from "./state.ts";

export type { CloudRuntime };

export function registerCloudExtension(pi: ExtensionAPI, runtime: CloudRuntime = {}): void {
  pi.registerFlag("cloud", {
    description: "Attach to Pi Cloud on an Oracle A1 VM (setup on first use)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("repo", {
    description: "Remote repository (owner/repo or git URL) instead of local origin",
    type: "string",
  });
  pi.registerFlag("branch", {
    description: "Base branch for the isolated pi/<session> working branch",
    type: "string",
  });

  pi.registerCommand("cloud", {
    description: "Show read-only Pi Cloud status",
    handler: async (_args, ctx) => {
      const persisted = await loadState(runtime.stateDir ?? DEFAULT_STATE_DIR);
      const status = await inspectCloudStatus({
        cwd: ctx.cwd,
        run: runtime.run,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionName: ctx.sessionManager.getSessionName(),
        persisted,
      });
      const text = formatCloudStatus(status);
      ctx.ui.notify(text, status.connection === "ok" || status.mode === "local" ? "info" : "warning");
      pi.sendMessage({ customType: "pi-cloud/status", content: text, display: true });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!pi.getFlag("cloud")) return;
    await handleCloudFlag(pi, ctx, runtime);
  });
}

export default function (pi: ExtensionAPI): void {
  registerCloudExtension(pi);
}

async function handleCloudFlag(pi: ExtensionAPI, ctx: ExtensionContext, runtime: CloudRuntime): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(
      "pi --cloud requires an interactive TUI. Refusing to fall back to local tools.",
      "error",
    );
    ctx.shutdown();
    return;
  }

  const outcome = await runCloudStartup({
    cwd: ctx.cwd,
    repo: stringFlag(pi.getFlag("repo")),
    branch: stringFlag(pi.getFlag("branch")),
    ui: ctx.ui,
    runtime: {
      ...runtime,
      interactive: runtime.interactive ?? ((argv) => suspendTerminal(ctx, () => spawnInherit(argv))),
    },
  });

  if (outcome.status !== "ready") {
    await presentFailure(ctx, outcome);
    ctx.shutdown();
    return;
  }

  const attached = await suspendTerminal(ctx, () => outcome.prepared.attach());
  const message = describeAttach(attached.status, attached.blockers.map((blocker) => blocker.message));
  if (attached.status === "detached") ctx.ui.notify(message, "info");
  else ctx.ui.notify(message, "warning");
  ctx.shutdown();
}

async function presentFailure(
  ctx: ExtensionContext,
  outcome: Exclude<StartupOutcome, { status: "ready" }>,
): Promise<void> {
  const message = formatStartupFailure(outcome);
  ctx.ui.notify(message, "error");
  await ctx.ui.confirm("Pi Cloud blocked", message);
}

function describeAttach(status: string, blockers: string[]): string {
  if (status === "detached") {
    return "Detached from remote tmux. Pi is still running on the VM.";
  }
  if (status === "exited") {
    return "Remote Pi exited. The VM was not deleted.";
  }
  if (status === "rebooted") {
    return "VM boot id changed; in-flight resume is not promised. Connection blocked from assuming the same process.";
  }
  if (status === "unreachable") {
    return `Remote host is unreachable. ${blockers.join(" ")}`.trim();
  }
  return `Pi Cloud attach ended (${status}). ${blockers.join(" ")}`.trim();
}

export async function suspendTerminal<T>(ctx: ExtensionContext, work: () => Promise<T>): Promise<T> {
  if (ctx.mode !== "tui") return await work();
  const wrapped = await ctx.ui.custom<{ ok: true; value: T } | { ok: false; error: unknown }>(
    (tui, _theme, _keybindings, done) => {
      tui.stop();
      process.stdout.write("\x1b[2J\x1b[H");
      void work()
        .then((value) => {
          tui.start();
          tui.requestRender(true);
          done({ ok: true, value });
        })
        .catch((error: unknown) => {
          tui.start();
          tui.requestRender(true);
          done({ ok: false, error });
        });
      return { render: () => [], invalidate: () => {} };
    },
  );
  if (!wrapped.ok) throw wrapped.error;
  return wrapped.value;
}

function stringFlag(value: boolean | string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
