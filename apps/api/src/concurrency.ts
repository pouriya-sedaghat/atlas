import { MapServiceError } from '@seyra/contracts';

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}

/**
 * Per-provider bounded concurrency with a bounded FIFO queue. Work beyond queue capacity is
 * rejected immediately (OVERLOADED) instead of piling up; queued work honours cancellation.
 */
export class BoundedLimiter {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    readonly name: string,
    readonly concurrency: number,
    readonly queueSize: number,
  ) {
    if (concurrency < 1 || queueSize < 0) throw new Error('invalid limiter configuration');
  }

  get stats(): { active: number; queued: number; concurrency: number; queueSize: number } {
    return { active: this.active, queued: this.queue.length, concurrency: this.concurrency, queueSize: this.queueSize };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.queueSize) {
      return Promise.reject(
        new MapServiceError('OVERLOADED', `${this.name} provider queue is full; retry later`, { provider: this.name }),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(abortError(signal!));
        },
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next.signal?.removeEventListener('abort', next.onAbort);
      // The slot passes directly to the next waiter; `active` stays unchanged.
      next.resolve();
    } else {
      this.active--;
    }
  }
}

export function abortError(signal: AbortSignal): MapServiceError {
  const reason: unknown = signal.reason;
  if (reason instanceof MapServiceError) return reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    return new MapServiceError('DEADLINE_EXCEEDED', 'operation deadline exceeded');
  }
  return new MapServiceError('CANCELLED', 'request cancelled');
}

/** Combine a client-cancellation signal with an operation deadline. */
export function deadlineSignal(parent: AbortSignal | undefined, deadlineMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(deadlineMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** Run tasks with at most `parallel` in flight; stops scheduling after the first failure. */
export async function mapBounded<I, O>(items: readonly I[], parallel: number, fn: (item: I, index: number) => Promise<O>): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  let failed: unknown;
  const worker = async (): Promise<void> => {
    while (failed === undefined) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));
  if (failed !== undefined) throw failed;
  return results;
}
