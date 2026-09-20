import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureQueryRequest } from '../src/api/client.js';
import type { AtlasFeatureCollection, Bbox } from '../src/api/types.js';
import { ViewportQueryController } from '../src/viewport/queryController.js';

const DEBOUNCE_MS = 50;

function bbox(west: number): Bbox {
  return [west, 35.68, west + 0.02, 35.7];
}

function request(west: number): FeatureQueryRequest {
  return { bbox: bbox(west), kind: 'road' };
}

function collection(datasetId: string): AtlasFeatureCollection {
  return {
    type: 'FeatureCollection',
    bbox: bbox(0),
    features: [],
    atlas: { apiVersion: '1', datasetId, returned: 0, limit: 1000, truncated: false },
  };
}

interface Deferred {
  signal: AbortSignal;
  resolve: (collection: AtlasFeatureCollection) => void;
  reject: (error: unknown) => void;
}

/** A runner that never settles on its own, so tests control the ordering. */
function deferredRunner() {
  const pending: Deferred[] = [];
  const run = vi.fn(
    (_request: FeatureQueryRequest, signal: AbortSignal) =>
      new Promise<AtlasFeatureCollection>((resolve, reject) => {
        pending.push({ signal, resolve, reject });
      }),
  );
  return { run, pending };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ViewportQueryController', () => {
  it('debounces a burst of viewports into a single query', async () => {
    const { run, pending } = deferredRunner();
    const onResult = vi.fn();
    const controller = new ViewportQueryController({ run, onResult, debounceMs: DEBOUNCE_MS });

    controller.request(request(51.3));
    controller.request(request(51.31));
    controller.request(request(51.32));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0].bbox[0]).toBe(51.32);

    pending[0]?.resolve(collection('ds-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('flush sends the queued query without waiting out the debounce', async () => {
    const { run, pending } = deferredRunner();
    const controller = new ViewportQueryController({
      run,
      onResult: vi.fn(),
      debounceMs: 10_000,
    });

    controller.request(request(51.3));
    expect(run).not.toHaveBeenCalled();
    controller.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    pending[0]?.resolve(collection('ds-1'));
    await vi.advanceTimersByTimeAsync(0);
    controller.dispose();
  });

  it('aborts a request that a newer viewport has superseded', async () => {
    const { run, pending } = deferredRunner();
    const controller = new ViewportQueryController({
      run,
      onResult: vi.fn(),
      debounceMs: DEBOUNCE_MS,
    });

    controller.request(request(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    controller.request(request(51.5));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    expect(run).toHaveBeenCalledTimes(2);
    expect(pending[0]?.signal.aborted).toBe(true);
    expect(pending[1]?.signal.aborted).toBe(false);
    controller.dispose();
  });

  it('ignores a stale response that arrives after a newer one', async () => {
    const { run, pending } = deferredRunner();
    const onResult = vi.fn();
    const controller = new ViewportQueryController({ run, onResult, debounceMs: DEBOUNCE_MS });

    controller.request(request(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    controller.request(request(51.5));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    // The newer query answers first, then the older one finally arrives.
    pending[1]?.resolve(collection('newer'));
    await vi.advanceTimersByTimeAsync(0);
    pending[0]?.resolve(collection('older'));
    await vi.advanceTimersByTimeAsync(0);

    expect(onResult).toHaveBeenCalledTimes(1);
    expect((onResult.mock.calls[0]?.[0] as AtlasFeatureCollection).atlas.datasetId).toBe('newer');
    controller.dispose();
  });

  it('reports a genuine failure', async () => {
    const { run, pending } = deferredRunner();
    const onError = vi.fn();
    const controller = new ViewportQueryController({
      run,
      onResult: vi.fn(),
      onError,
      debounceMs: DEBOUNCE_MS,
    });

    controller.request(request(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    pending[0]?.reject(new Error('server exploded'));
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('server exploded');
    controller.dispose();
  });

  it('does not report a cancellation as a failure', async () => {
    const { run, pending } = deferredRunner();
    const onError = vi.fn();
    const controller = new ViewportQueryController({
      run,
      onResult: vi.fn(),
      onError,
      debounceMs: DEBOUNCE_MS,
    });

    controller.request(request(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    pending[0]?.reject(abortError);
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('signals loading before each query goes out', async () => {
    const { run, pending } = deferredRunner();
    const onLoading = vi.fn();
    const controller = new ViewportQueryController({
      run,
      onResult: vi.fn(),
      onLoading,
      debounceMs: DEBOUNCE_MS,
    });

    controller.request(request(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    expect(onLoading).toHaveBeenCalledTimes(1);
    expect(controller.busy).toBe(true);

    pending[0]?.resolve(collection('ds-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.busy).toBe(false);
    controller.dispose();
  });

  it('drops everything once disposed', async () => {
    const { run, pending } = deferredRunner();
    const onResult = vi.fn();
    const controller = new ViewportQueryController({ run, onResult, debounceMs: DEBOUNCE_MS });

    controller.request(request(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
    controller.dispose();
    expect(pending[0]?.signal.aborted).toBe(true);

    pending[0]?.resolve(collection('ds-1'));
    controller.request(request(51.5));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);

    expect(onResult).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
