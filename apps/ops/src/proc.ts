import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  input?: string;
  env?: Record<string, string>;
  logFile?: string;
  allowFailure?: boolean;
  timeoutMs?: number;
  /** Keep stdout out of memory (large outputs); it is still streamed to the log file. */
  discardStdout?: boolean;
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly result: RunResult,
  ) {
    super(`${command} exited with ${result.code}${result.stderr ? `: ${result.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
  }
}

/** Run a program with an argument vector (never a shell string). Secrets go via files/stdin. */
export function run(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const log: WriteStream | null = opts.logFile ? createWriteStream(opts.logFile, { flags: 'a', mode: 0o640 }) : null;
    log?.write(`\n$ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
    }
    child.stdout.on('data', (d: Buffer) => {
      if (!opts.discardStdout) stdout += d.toString('utf8');
      log?.write(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
      log?.write(d);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      log?.end();
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      log?.end();
      const result = { code: code ?? -1, stdout, stderr };
      if (result.code !== 0 && !opts.allowFailure) reject(new CommandError(`${cmd} ${args.slice(0, 4).join(' ')}`, result));
      else resolve(result);
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** producer stdout -> consumer stdin, both argument vectors; both must succeed. */
export function pipe(a: { cmd: string; args: string[]; env?: Record<string, string> }, b: { cmd: string; args: string[]; env?: Record<string, string> }, logFile?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const log = logFile ? createWriteStream(logFile, { flags: 'a', mode: 0o640 }) : null;
    log?.write(`\n$ ${a.cmd} ${a.args.join(' ')} | ${b.cmd} ${b.args.join(' ')}\n`);
    const pa = spawn(a.cmd, a.args, { env: { ...process.env, ...a.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const pb = spawn(b.cmd, b.args, { env: { ...process.env, ...b.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    pa.stdout.pipe(pb.stdin);
    let errA = '';
    let errB = '';
    pa.stderr.on('data', (d: Buffer) => {
      errA += d.toString();
      log?.write(d);
    });
    pb.stderr.on('data', (d: Buffer) => {
      errB += d.toString();
      log?.write(d);
    });
    pb.stdout.on('data', (d: Buffer) => log?.write(d));
    let done = 0;
    let failed: Error | null = null;
    const finish = () => {
      if (++done < 2) return;
      log?.end();
      if (failed) reject(failed);
      else resolve();
    };
    pa.on('close', (code) => {
      if (code !== 0) failed ??= new Error(`${a.cmd} failed (${code}): ${errA.trim().split('\n').slice(-2).join(' | ')}`);
      finish();
    });
    pb.on('close', (code) => {
      if (code !== 0) failed ??= new Error(`${b.cmd} failed (${code}): ${errB.trim().split('\n').slice(-2).join(' | ')}`);
      finish();
    });
    pa.on('error', (e) => {
      failed ??= e;
      finish();
    });
    pb.on('error', (e) => {
      failed ??= e;
      finish();
    });
  });
}
