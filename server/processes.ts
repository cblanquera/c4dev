/** Project-scoped access to devmetrics-managed background servers. */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectProcess } from './types.ts';

const execute = promisify(execFile);
type DevmetricsCommand = (args: string[], signal: AbortSignal) => Promise<string>;

/** Use the CLI so process-group cleanup and registry updates remain owned by devmetrics. */
async function devmetrics(args: string[], signal: AbortSignal): Promise<string> {
  const { stdout } = await execute('devmetrics', args, { signal, timeout: 15_000, maxBuffer: 2_000_000 });
  signal.throwIfAborted();
  return stdout;
}

export interface ProcessManager {
  list(signal: AbortSignal): Promise<ProjectProcess[]>;
  stop(id: string, signal: AbortSignal): Promise<void>;
}

interface ManagedServer {
  port: number;
  cwd: string;
  summary: string;
  pid?: number;
  startedAt: string;
  stopsOn?: string;
}

/** Directory comparisons use path boundaries so sibling projects cannot match. */
export function belongsToProject(cwd: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), path.resolve(cwd));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

/** Read only registry metadata; commands and environment assignments stay private. */
export class DevmetricsProcesses implements ProcessManager {
  private roots: () => string[];
  private command: DevmetricsCommand;

  constructor(roots: () => string[], command: DevmetricsCommand = devmetrics) {
    this.roots = roots;
    this.command = command;
  }

  private async registry(signal: AbortSignal): Promise<ManagedServer[]> {
    try {
      const stdout = await this.command(['list', '--json'], signal);
      signal.throwIfAborted();
      const servers: unknown = JSON.parse(stdout);
      if (!Array.isArray(servers)) throw new Error('Invalid registry');
      return servers.filter((s): s is ManagedServer => !!s && typeof s.cwd === 'string' && typeof s.summary === 'string'
        && typeof s.startedAt === 'string' && Number.isInteger(s.port) && s.port >= 3000 && s.port <= 3020
        && belongsToProject(s.cwd, this.roots()));
    } catch (err) {
      if (signal.aborted) signal.throwIfAborted();
      throw new Error('Unable to read project processes. Check that devmetrics is installed and available.');
    }
  }

  async list(signal: AbortSignal): Promise<ProjectProcess[]> {
    const servers = await this.registry(signal);
    signal.throwIfAborted();
    return servers.map((server) => ({
      id: `${server.port}:${server.startedAt}`, summary: server.summary,
      pid: server.pid ?? null, url: `http://localhost:${server.port}`,
      startedAt: server.startedAt, stopsAt: server.stopsOn ?? null,
      currentServer: server.pid === process.pid || server.port === Number(process.env.PORT),
    }));
  }

  /** Re-read the scoped registry so a stale ID cannot stop a server that reused its port. */
  async stop(id: string, signal: AbortSignal): Promise<void> {
    const servers = await this.registry(signal);
    signal.throwIfAborted();
    const server = servers.find((item) => `${item.port}:${item.startedAt}` === id);
    if (!server) throw new Error('This process is no longer running in this project');
    await this.command(['stop', String(server.port)], signal);
    signal.throwIfAborted();
  }
}
