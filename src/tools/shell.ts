import { spawn } from "node:child_process";

export class ShellToolError extends Error {}

export interface ShellCommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ShellToolOptions {
  cwd: string;
  shell?: boolean;
}

export class ShellTool {
  private readonly cwd: string;
  private readonly shell: boolean;

  constructor(options: ShellToolOptions) {
    this.cwd = options.cwd;
    this.shell = Boolean(options.shell);
  }

  async run(command: string, args: string[] = [], options?: { timeout?: number }): Promise<ShellCommandResult> {
    return await new Promise<ShellCommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.cwd,
        shell: this.shell,
        windowsHide: true
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

      let timer: NodeJS.Timeout | undefined;
      if (options?.timeout) {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new ShellToolError(`Command timed out after ${options.timeout}ms: ${command}`));
        }, options.timeout);
      }

      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        reject(new ShellToolError(`Failed to run command: ${(error as Error).message}`));
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const result: ShellCommandResult = {
          command,
          args,
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8")
        };

        if (result.exitCode !== 0) {
          reject(new ShellToolError(`Command failed (${result.exitCode}): ${command} ${args.join(" ")}\n${result.stderr}`));
          return;
        }

        resolve(result);
      });
    });
  }
}
