import { execFile, type ExecFileException } from "node:child_process";
import { parsePorcelain, sameFiles, type FileChange } from "./files-modified.ts";

export const GIT_STATUS_POLL_MS = 2000;
export const GIT_STATUS_TIMEOUT_MS = 2000;

export type GitPorcelainRunner = (cwd: string) => Promise<string>;

type PorcelainExecFile = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    encoding: "utf8";
    timeout: number;
    windowsHide: boolean;
    maxBuffer: number;
  },
  callback: (error: ExecFileException | null, stdout: string) => void,
) => unknown;

export function createGitPorcelainRunner(
  timeoutMs = GIT_STATUS_TIMEOUT_MS,
  runExecFile: PorcelainExecFile = execFile as PorcelainExecFile,
): GitPorcelainRunner {
  return (cwd) => new Promise((resolve, reject) => {
    runExecFile(
      "git",
      ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(typeof stdout === "string" ? stdout : "");
      },
    );
  });
}

export class GitStatusPoller {
  private cwd = "";
  private timer?: ReturnType<typeof setInterval>;
  private inflight?: Promise<void>;
  private trailing = false;
  private last: FileChange[] = [];
  private started = false;
  private readonly onChange: (files: FileChange[]) => void;
  private readonly run: GitPorcelainRunner;
  private readonly intervalMs: number;

  constructor(
    onChange: (files: FileChange[]) => void,
    run: GitPorcelainRunner = createGitPorcelainRunner(),
    intervalMs = GIT_STATUS_POLL_MS,
  ) {
    this.onChange = onChange;
    this.run = run;
    this.intervalMs = intervalMs;
  }

  setCwd(cwd: string): void {
    if (this.cwd === cwd) return;
    this.cwd = cwd;
    this.last = [];
    if (this.started) void this.refresh();
  }

  start(cwd: string): void {
    this.cwd = cwd;
    this.last = [];
    this.started = true;
    void this.refresh();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  refresh(): Promise<void> {
    if (!this.started || !this.cwd) return this.inflight ?? Promise.resolve();
    if (this.inflight) {
      this.trailing = true;
      return this.inflight;
    }
    this.inflight = this.runCycle().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  dispose(): void {
    this.started = false;
    this.trailing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runCycle(): Promise<void> {
    do {
      this.trailing = false;
      await this.pull();
    } while (this.trailing && this.started && this.cwd);
  }

  private async pull(): Promise<void> {
    if (!this.started || !this.cwd) return;
    const cwd = this.cwd;
    try {
      const next = parsePorcelain(await this.run(cwd));
      if (!this.started || this.cwd !== cwd) return;
      if (sameFiles(this.last, next)) return;
      this.last = next;
      this.onChange(next);
    } catch {
      // Timeouts, kills, nonzero exits, and maxBuffer keep the last successful snapshot.
    }
  }
}
