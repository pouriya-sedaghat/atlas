/**
 * Debounced, cancellable viewport querying.
 *
 * Panning a map produces a stream of viewports. Studio must not ask the server
 * about every one of them, must not leave obsolete requests running, and must
 * never render an older answer over a newer one. That is all this class does,
 * and it does it without touching the DOM or MapLibre so it can be tested
 * directly.
 */

import type { FeatureQueryRequest } from '../api/client.js';
import type { AtlasFeatureCollection } from '../api/types.js';

export type QueryRunner = (
  request: FeatureQueryRequest,
  signal: AbortSignal,
) => Promise<AtlasFeatureCollection>;

export interface ViewportQueryControllerOptions {
  run: QueryRunner;
  onLoading?: (request: FeatureQueryRequest) => void;
  onResult: (collection: AtlasFeatureCollection, request: FeatureQueryRequest) => void;
  onError?: (error: unknown, request: FeatureQueryRequest) => void;
  debounceMs?: number;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class ViewportQueryController {
  private readonly options: ViewportQueryControllerOptions;
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private queued: { request: FeatureQueryRequest; generation: number } | null = null;
  /**
   * Bumped the moment a new viewport is asked for, not when its query is
   * finally sent. Anything carrying an older generation is answering a view
   * nobody is looking at any more.
   */
  private generation = 0;
  private disposed = false;

  constructor(options: ViewportQueryControllerOptions) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? 250;
  }

  /** Schedules a query, replacing any query that has not gone out yet. */
  request(request: FeatureQueryRequest): void {
    if (this.disposed) {
      return;
    }

    // Claim a generation now. Waiting until dispatch would leave a window,
    // the length of the debounce, in which an in-flight request still counts
    // as current and can render its answer over a newer viewport.
    this.generation += 1;
    this.queued = { request, generation: this.generation };

    // Whatever is running has just been superseded, so stop paying for it.
    this.inFlight?.abort();
    this.inFlight = null;

    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.dispatch();
    }, this.debounceMs);
  }

  /** Sends the queued query now, skipping the remaining debounce delay. */
  flush(): void {
    if (this.disposed || this.timer === null) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
    void this.dispatch();
  }

  /** Cancels everything; the controller accepts no further requests. */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inFlight?.abort();
    this.inFlight = null;
    this.queued = null;
  }

  /** Whether a request is currently in flight. Exposed for tests and the UI. */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  private async dispatch(): Promise<void> {
    const queued = this.queued;
    this.queued = null;
    if (this.disposed || !queued) {
      return;
    }
    const { request, generation } = queued;
    // A newer viewport was queued between this one being scheduled and the
    // timer firing, so this query is obsolete before it is even sent.
    if (generation !== this.generation) {
      return;
    }

    const controller = new AbortController();
    this.inFlight = controller;

    this.options.onLoading?.(request);

    try {
      const collection = await this.options.run(request, controller.signal);
      if (this.isStale(generation, controller)) {
        return;
      }
      this.inFlight = null;
      this.options.onResult(collection, request);
    } catch (error) {
      if (this.isStale(generation, controller) || isAbort(error)) {
        return;
      }
      this.inFlight = null;
      this.options.onError?.(error, request);
    }
  }

  /**
   * Whether an answer may still be delivered.
   *
   * Stale means the map went away, a newer viewport was asked for, or this
   * request was cancelled. The abort check is belt and braces: a runner that
   * ignores its signal and resolves anyway must still not reach the UI.
   */
  private isStale(generation: number, controller: AbortController): boolean {
    return this.disposed || generation !== this.generation || controller.signal.aborted;
  }
}
