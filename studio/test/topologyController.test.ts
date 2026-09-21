import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureQueryRequest, TopologyQueryRequest } from '../src/api/client.js';
import type { AtlasFeatureCollection, Bbox, TopologyCollection } from '../src/api/types.js';
import { ViewportQueryController } from '../src/viewport/queryController.js';

const DEBOUNCE_MS = 50;

function bbox(west: number): Bbox {
  return [west, 35.68, west + 0.02, 35.7];
}

function topologyRequest(west: number): TopologyQueryRequest {
  return { bbox: bbox(west), limit: 2000 };
}

function featureRequest(west: number): FeatureQueryRequest {
  return { bbox: bbox(west), kind: 'road' };
}

function collection(datasetId: string): TopologyCollection {
  return { apiVersion: '1', datasetId, bbox: bbox(0), nodes: [], segments: [] };
}

interface Deferred<T> {
  signal: AbortSignal;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferredRunner<TRequest, TResult>() {
  const pending: Deferred<TResult>[] = [];
  const run = vi.fn(
    (_request: TRequest, signal: AbortSignal) =>
      new Promise<TResult>((resolve, reject) => {
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

describe('the topology query lifecycle', () => {
  it('debounces a burst of viewports into a single topology query', async () => {
    const { run, pending } = deferredRunner<TopologyQueryRequest, TopologyCollection>();
    const onResult = vi.fn();
    const controller = new ViewportQueryController<TopologyQueryRequest, TopologyCollection>({
      run,
      onResult,
      debounceMs: DEBOUNCE_MS,
    });

    controller.request(topologyRequest(51.3));
    controller.request(topologyRequest(51.31));
    controller.request(topologyRequest(51.32));
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual(topologyRequest(51.32));

    pending[0]?.resolve(collection('ds-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight topology query when a newer viewport arrives', async () => {
    const { run, pending } = deferredRunner<TopologyQueryRequest, TopologyCollection>();
    const onResult = vi.fn();
    const controller = new ViewportQueryController<TopologyQueryRequest, TopologyCollection>({
      run,
      onResult,
      debounceMs: DEBOUNCE_MS,
    });

    controller.request(topologyRequest(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(pending[0]?.signal.aborted).toBe(false);

    controller.request(topologyRequest(51.4));
    expect(pending[0]?.signal.aborted).toBe(true);

    // The superseded answer arriving late must not reach the UI.
    pending[0]?.resolve(collection('ds-stale'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    pending[1]?.resolve(collection('ds-current'));
    await vi.advanceTimersByTimeAsync(0);

    expect(onResult).toHaveBeenCalledTimes(1);
    expect((onResult.mock.calls[0]?.[0] as TopologyCollection | undefined)?.datasetId).toBe(
      'ds-current',
    );
  });

  it('cancel stops everything in flight and leaves the controller usable', async () => {
    const { run, pending } = deferredRunner<TopologyQueryRequest, TopologyCollection>();
    const onResult = vi.fn();
    const onError = vi.fn();
    const controller = new ViewportQueryController<TopologyQueryRequest, TopologyCollection>({
      run,
      onResult,
      onError,
      debounceMs: DEBOUNCE_MS,
    });

    controller.request(topologyRequest(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);

    // Switching the overlay off.
    controller.cancel();
    expect(pending[0]?.signal.aborted).toBe(true);
    pending[0]?.resolve(collection('ds-1'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(controller.busy).toBe(false);

    // Switching it back on: the controller still works.
    controller.request(topologyRequest(51.4));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);
    pending[1]?.resolve(collection('ds-2'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('cancel drops a query that has not gone out yet', async () => {
    const { run } = deferredRunner<TopologyQueryRequest, TopologyCollection>();
    const controller = new ViewportQueryController<TopologyQueryRequest, TopologyCollection>({
      run,
      onResult: vi.fn(),
      debounceMs: DEBOUNCE_MS,
    });

    controller.request(topologyRequest(51.3));
    controller.cancel();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);
    expect(run).not.toHaveBeenCalled();
  });

  it('a topology failure is reported and nothing else is disturbed', async () => {
    const { run, pending } = deferredRunner<TopologyQueryRequest, TopologyCollection>();
    const onResult = vi.fn();
    const onError = vi.fn();
    const controller = new ViewportQueryController<TopologyQueryRequest, TopologyCollection>({
      run,
      onResult,
      onError,
      debounceMs: DEBOUNCE_MS,
    });

    controller.request(topologyRequest(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    pending[0]?.reject(new Error('topology exploded'));
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
    // The controller is still usable afterwards.
    controller.request(topologyRequest(51.4));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('an aborted topology query is silent, not an error', async () => {
    const { run, pending } = deferredRunner<TopologyQueryRequest, TopologyCollection>();
    const onError = vi.fn();
    const controller = new ViewportQueryController<TopologyQueryRequest, TopologyCollection>({
      run,
      onResult: vi.fn(),
      onError,
      debounceMs: DEBOUNCE_MS,
    });

    controller.request(topologyRequest(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    controller.cancel();
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    pending[0]?.reject(abort);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('the feature and topology queries are independent', () => {
  it('a topology request never cancels a feature request, or the other way round', async () => {
    const features = deferredRunner<FeatureQueryRequest, AtlasFeatureCollection>();
    const topology = deferredRunner<TopologyQueryRequest, TopologyCollection>();
    const onFeatures = vi.fn();
    const onTopology = vi.fn();

    const featureController = new ViewportQueryController({
      run: features.run,
      onResult: onFeatures,
      debounceMs: DEBOUNCE_MS,
    });
    const topologyController = new ViewportQueryController<
      TopologyQueryRequest,
      TopologyCollection
    >({
      run: topology.run,
      onResult: onTopology,
      debounceMs: DEBOUNCE_MS,
    });

    featureController.request(featureRequest(51.3));
    topologyController.request(topologyRequest(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(features.run).toHaveBeenCalledTimes(1);
    expect(topology.run).toHaveBeenCalledTimes(1);

    // Switching the overlay off cancels topology and nothing else.
    topologyController.cancel();
    expect(topology.pending[0]?.signal.aborted).toBe(true);
    expect(features.pending[0]?.signal.aborted).toBe(false);

    features.pending[0]?.resolve({
      type: 'FeatureCollection',
      bbox: bbox(51.3),
      features: [],
      atlas: {
        apiVersion: '1',
        datasetId: 'ds-1',
        returned: 0,
        limit: 1000,
        truncated: false,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onFeatures).toHaveBeenCalledTimes(1);
    expect(onTopology).not.toHaveBeenCalled();
  });

  it('a feature controller built the old way still infers its own types', async () => {
    // The generic parameters have defaults, so every existing call site reads
    // and behaves exactly as it did before topology existed.
    const { run, pending } = deferredRunner<FeatureQueryRequest, AtlasFeatureCollection>();
    const onResult = vi.fn();
    const controller = new ViewportQueryController({ run, onResult, debounceMs: DEBOUNCE_MS });

    controller.request(featureRequest(51.3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    pending[0]?.resolve({
      type: 'FeatureCollection',
      bbox: bbox(51.3),
      features: [],
      atlas: {
        apiVersion: '1',
        datasetId: 'ds-1',
        returned: 0,
        limit: 1000,
        truncated: false,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledTimes(1);
  });
});
