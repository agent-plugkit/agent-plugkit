import { spawn } from 'node:child_process';

export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly captureOutput: boolean;
  readonly signal?: AbortSignal;
}

interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessResult =
  | (ProcessOutput & { readonly status: 'completed'; readonly exitCode: 0 })
  | (ProcessOutput & { readonly status: 'missing'; readonly message: string })
  | (ProcessOutput & {
      readonly status: 'failed';
      readonly exitCode: number | null;
      readonly message: string;
    })
  | (ProcessOutput & { readonly status: 'interrupted'; readonly signal: NodeJS.Signals });

export interface ProcessRunner {
  run(request: ProcessRequest): ProcessResult | Promise<ProcessResult>;
}

const INTERRUPT_ESCALATION_DELAY_MS = 500;

function outputText(value: string | Buffer | null | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  return value ? value.toString('utf8') : '';
}

export const systemProcessRunner: ProcessRunner = {
  async run(request): Promise<ProcessResult> {
    if (request.signal?.aborted) {
      return { status: 'interrupted', signal: 'SIGINT', stdout: '', stderr: '' };
    }
    return await new Promise<ProcessResult>((resolveResult) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let aborted = false;
      let escalationTimer: NodeJS.Timeout | undefined;
      const child = spawn(request.executable, [...request.args], {
        shell: false,
        stdio: request.captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        windowsHide: true,
      });

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrChunks.push(Buffer.from(chunk));
      });

      const output = (): ProcessOutput => ({
        stdout: outputText(Buffer.concat(stdoutChunks)),
        stderr: outputText(Buffer.concat(stderrChunks)),
      });
      const cleanup = (): void => {
        request.signal?.removeEventListener('abort', onAbort);
        if (escalationTimer) {
          clearTimeout(escalationTimer);
          escalationTimer = undefined;
        }
      };
      const settle = (result: ProcessResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolveResult(result);
      };
      const onAbort = (): void => {
        if (aborted || settled) {
          return;
        }
        aborted = true;
        try {
          child.kill('SIGINT');
        } catch {
          // The close/error event below owns the final result.
        }
        escalationTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          try {
            child.kill('SIGKILL');
          } catch {
            // A child that has already exited will still emit close/error.
          }
        }, INTERRUPT_ESCALATION_DELAY_MS);
        escalationTimer.unref();
      };

      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.signal?.aborted) {
        onAbort();
      }

      child.once('error', (rawError) => {
        const error = rawError as NodeJS.ErrnoException;
        if (aborted) {
          settle({ status: 'interrupted', signal: 'SIGINT', ...output() });
          return;
        }
        if (error.code === 'ENOENT') {
          settle({
            status: 'missing',
            ...output(),
            message: `未找到 executable: ${request.executable}`,
          });
          return;
        }
        settle({
          status: 'failed',
          exitCode: null,
          ...output(),
          message: error.message,
        });
      });

      child.once('close', (exitCode, signal) => {
        if (aborted) {
          settle({
            status: 'interrupted',
            signal: 'SIGINT',
            ...output(),
          });
          return;
        }
        if (signal) {
          settle({
            status: 'interrupted',
            signal,
            ...output(),
          });
          return;
        }
        if (exitCode === 0) {
          settle({ status: 'completed', exitCode: 0, ...output() });
          return;
        }
        settle({
          status: 'failed',
          exitCode,
          ...output(),
          message: `${request.executable} 退出码 ${exitCode ?? 'unknown'}`,
        });
      });
    });
  },
};
