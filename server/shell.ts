/** Child-process helpers with streaming output and cancellation. */
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  output: string;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Called with each complete output line (stdout and stderr interleaved). */
  onLine?: (line: string) => void;
  timeoutMs?: number;
}

/** Runs a shell command line, collecting combined output. Never throws on non-zero exit. */
export function run(command: string, opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    // NODE_TEST_CONTEXT would make a child `node --test` report to our runner instead of stdout.
    const { NODE_TEST_CONTEXT: _ignored, ...parentEnv } = process.env;
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env: { ...parentEnv, CI: '1', FORCE_COLOR: '0', ...opts.env },
      detached: process.platform !== 'win32',
    });
    // Nothing is ever piped in; an open stdin makes some CLIs (e.g. `codex exec`) wait for input forever.
    child.stdin?.end();
    let output = '';
    let partial = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (!opts.onLine) return;
      const lines = (partial + text).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) opts.onLine(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    opts.signal?.addEventListener('abort', kill, { once: true });
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : undefined;

    child.on('error', (err) => {
      output += `\n${err.message}`;
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      if (partial && opts.onLine) opts.onLine(partial);
      resolve({ code: code ?? 1, output });
    });
  });
}

/** Quotes one argument for the shell, so user-supplied names can't inject commands. */
export const shellQuote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

/** Runs a git command; throws with output on failure. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const quoted = args.map(shellQuote).join(' ');
  const res = await run(`git ${quoted}`, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${res.output.trim()}`);
  return res.output.trim();
}

/** Last `n` lines of output, for prompts and logs. */
export function tail(text: string, n = 80): string {
  const lines = text.trimEnd().split('\n');
  return lines.length <= n ? lines.join('\n') : `…(${lines.length - n} lines omitted)\n${lines.slice(-n).join('\n')}`;
}
