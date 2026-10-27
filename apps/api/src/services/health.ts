import { existsSync } from 'node:fs';
import { MapServiceError, PROVIDER_IDS, type ProviderHealth, type ProviderId, type Readiness } from '@seyra/contracts';
import type { ActiveRelease } from '../release.js';
import { geocoderMarkerName, tegolaMapName } from '../release.js';

export interface ProviderProbes {
  tiles(expectedMap: string, signal: AbortSignal): Promise<{ identity: string | null }>;
  routing(signal: AbortSignal): Promise<{ identity: string | null }>;
  geocoder(markerName: string, signal: AbortSignal): Promise<{ identity: string | null }>;
  overpass(signal: AbortSignal): Promise<{ identity: string | null }>;
  controlDb(signal: AbortSignal): Promise<void>;
}

const IMPLEMENTATION: Record<ProviderId, string> = {
  tiles: 'tegola',
  routing: 'valhalla',
  geocoder: 'photon',
  overpass: 'overpass',
};

export interface HealthOptions {
  cacheMs: number;
  probeTimeoutMs: number;
  maintenanceFlagFile: string;
  /** A provider's identity counts as verified for this long after its last successful probe. */
  maxVerifiedAgeMs?: number;
  /** How long a request may wait for an in-flight/new verification of its provider. */
  gateWaitMs?: number;
  /** A failed verification is re-probed on demand after this long (faster recovery). */
  retryFailedAfterMs?: number;
}

/**
 * Readiness = every required provider answers a real probe AND reports the identity recorded
 * for the active release. Nothing here is hardcoded green; unknown means not ready.
 *
 * Request admission (review R4) is per provider: an operation may use a provider only while that
 * provider's identity was verified recently. Unknown (before the first probe), stale, unavailable
 * or mismatching state is never admitted; a missing/stale verification is refreshed for that
 * provider alone with a bounded wait, so an outage of an unrelated provider does not block it.
 */
export class HealthService {
  private snapshot: Readiness | null = null;
  private inflight: Promise<Readiness> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Latest completed verification per provider (checked_at = completion time). */
  private readonly verified = new Map<ProviderId, ProviderHealth>();
  private readonly probing = new Map<ProviderId, Promise<ProviderHealth>>();
  private readonly maxVerifiedAgeMs: number;
  private readonly gateWaitMs: number;
  private readonly retryFailedAfterMs: number;

  constructor(
    private readonly release: ActiveRelease,
    private readonly probes: ProviderProbes,
    private readonly opts: HealthOptions,
  ) {
    this.maxVerifiedAgeMs = opts.maxVerifiedAgeMs ?? Math.max(2 * opts.cacheMs, 1_000);
    this.gateWaitMs = opts.gateWaitMs ?? Math.min(opts.probeTimeoutMs + 500, 5_500);
    this.retryFailedAfterMs = opts.retryFailedAfterMs ?? 1_000;
  }

  get datasetId(): string {
    return this.release.dataset_id;
  }

  inMaintenance(): boolean {
    return existsSync(this.opts.maintenanceFlagFile);
  }

  start(): void {
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.opts.cacheMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async readiness(maxAgeMs = this.opts.cacheMs): Promise<Readiness> {
    const snap = this.snapshot;
    if (snap && Date.now() - Date.parse(snap.checked_at) < maxAgeMs) return this.withMaintenance(snap);
    return this.withMaintenance(await this.refresh());
  }

  /**
   * Admit an operation on `provider` only with a recent successful verification of the identity it
   * serves. Throws a typed MAINTENANCE / PROVIDER_UNAVAILABLE / PROVIDER_REVISION_MISMATCH error
   * otherwise; the caller must not invoke the provider adapter when this throws.
   */
  async gate(provider: ProviderId): Promise<void> {
    if (this.inMaintenance()) throw new MapServiceError('MAINTENANCE', 'map services are in a maintenance window; retry later');
    const now = Date.now();
    let entry = this.verified.get(provider);
    const age = entry?.checked_at ? now - Date.parse(entry.checked_at) : Infinity;
    if (!entry || age > this.maxVerifiedAgeMs || (entry.status !== 'ok' && age >= this.retryFailedAfterMs)) {
      entry = await this.verifyWithin(provider, this.gateWaitMs);
    }
    if (entry.status === 'revision_mismatch') {
      throw new MapServiceError('PROVIDER_REVISION_MISMATCH', `${provider} serves a different dataset revision than the active release`, {
        provider: IMPLEMENTATION[provider],
        details: { expected: entry.expected_identity, observed: entry.observed_identity },
      });
    }
    if (entry.status !== 'ok') {
      throw new MapServiceError('PROVIDER_UNAVAILABLE', `${provider} has no verified identity for the active release (${entry.error ?? entry.status}); retry later`, {
        provider: IMPLEMENTATION[provider],
      });
    }
  }

  private async verifyWithin(provider: ProviderId, waitMs: number): Promise<ProviderHealth> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ProviderHealth>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            provider,
            implementation: IMPLEMENTATION[provider],
            status: 'unknown',
            expected_identity: this.expected(provider),
            observed_identity: null,
            latency_ms: null,
            checked_at: new Date().toISOString(),
            error: `identity verification did not complete within ${waitMs} ms`,
          }),
        waitMs,
      );
    });
    try {
      return await Promise.race([this.probeProvider(provider), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private withMaintenance(r: Readiness): Readiness {
    return this.inMaintenance() ? { ...r, status: 'maintenance' } : r;
  }

  refresh(): Promise<Readiness> {
    this.inflight ??= this.probeAll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private expected(provider: ProviderId): string {
    return this.release.identities[provider];
  }

  private probeFn(provider: ProviderId): (s: AbortSignal) => Promise<{ identity: string | null }> {
    const ds = this.release.dataset_id;
    switch (provider) {
      case 'tiles':
        return (s) => this.probes.tiles(tegolaMapName(ds), s);
      case 'routing':
        return (s) => this.probes.routing(s);
      case 'geocoder':
        return (s) => this.probes.geocoder(geocoderMarkerName(ds), s);
      case 'overpass':
        return (s) => this.probes.overpass(s);
    }
  }

  /** One real identity probe per provider at a time; the result is recorded when it completes. */
  private probeProvider(provider: ProviderId): Promise<ProviderHealth> {
    const existing = this.probing.get(provider);
    if (existing) return existing;
    const p = (async (): Promise<ProviderHealth> => {
      const started = Date.now();
      const expected = this.expected(provider);
      const base = { provider, implementation: IMPLEMENTATION[provider], expected_identity: expected };
      let result: ProviderHealth;
      try {
        const { identity } = await this.probeFn(provider)(AbortSignal.timeout(this.opts.probeTimeoutMs));
        const latency = Date.now() - started;
        result =
          identity === expected
            ? { ...base, status: 'ok', observed_identity: identity, latency_ms: latency, checked_at: new Date().toISOString() }
            : {
                ...base,
                status: 'revision_mismatch',
                observed_identity: identity,
                latency_ms: latency,
                checked_at: new Date().toISOString(),
                error: identity === null ? 'release identity marker not found in the served data' : 'served data identity differs from the active release',
              };
      } catch (err) {
        result = { ...base, status: 'unavailable', observed_identity: null, latency_ms: null, checked_at: new Date().toISOString(), error: err instanceof Error ? err.message : 'probe failed' };
      }
      this.verified.set(provider, result);
      return result;
    })().finally(() => this.probing.delete(provider));
    this.probing.set(provider, p);
    return p;
  }

  private async probeAll(): Promise<Readiness> {
    const ds = this.release.dataset_id;
    const providers = await Promise.all(PROVIDER_IDS.map((p) => this.probeProvider(p)));
    let db: Readiness['dependencies'][number];
    try {
      await this.probes.controlDb(AbortSignal.timeout(this.opts.probeTimeoutMs));
      db = { name: 'control_db', status: 'ok' };
    } catch (err) {
      db = { name: 'control_db', status: 'unavailable', error: err instanceof Error ? err.message : 'probe failed' };
    }
    const allOk = providers.every((p) => p.status === 'ok') && db.status === 'ok';
    const snap: Readiness = {
      status: allOk ? 'ready' : 'not_ready',
      dataset_id: ds,
      providers,
      dependencies: [db],
      checked_at: new Date().toISOString(),
    };
    if (snap.providers.length !== PROVIDER_IDS.length) throw new Error('internal: provider list incomplete');
    this.snapshot = snap;
    return snap;
  }
}
