import { execFile } from "node:child_process";

export class SnapshotGitError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SnapshotGitError";
  }
}

export interface GitCommandOptions {
  cwd?: string;
  allowLazyFetch?: boolean;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

/** Execute git without a shell, interactive credentials, or unbounded output. */
export function runGit(args: string[], options: GitCommandOptions = {}): Promise<Buffer> {
  const maxBuffer = options.maxBufferBytes ?? 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: options.cwd,
      encoding: "buffer",
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: options.allowLazyFetch ? "0" : "1",
      },
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      const detail = stderr.toString("utf8").trim().slice(0, 500);
      const code = /maxBuffer|stdout length/i.test(error.message) ? "git_output_limit" : "git_command_failed";
      reject(new SnapshotGitError(code, `Git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`));
    });
  });
}

export function gitText(buffer: Buffer) {
  return buffer.toString("utf8").trim();
}
