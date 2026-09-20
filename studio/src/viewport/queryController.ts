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
  private queued: FeatureQueryRequest | null = null;
  private dispatched = 0;
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
    this.queued = request;
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
    const request = this.queued;
    this.queued = null;
    if (this.disposed || !request) {
      return;
    }

    // Anything still running is now obsolete.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const ticket = ++this.dispatched;

    this.options.onLoading?.(request);

    try {
      const collection = await this.options.run(request, controller.signal);
      if (this.isStale(ticket)) {
        return;
      }
      this.inFlight = null;
      this.options.onResult(collection, request);
    } catch (error) {
      if (this.isStale(ticket) || isAbort(error) || controller.signal.aborted) {
        return;
      }
      this.inFlight = null;
      this.options.onError?.(error, request);
    }
  }

  /** A response is stale if a newer query went out, or the map went away. */
  private isStale(ticket: number): boolean {
    return this.disposed || ticket !== this.dispatched;
  }
}
