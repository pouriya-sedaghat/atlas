export interface ReleasePolicy {
  idleSessionMs: number;
  absoluteSessionMs: number;
  requestLeaseMs: number;
  retirementGraceMs: number;
  keepLatest: number;
}

export const DEFAULT_RELEASE_POLICY: Readonly<ReleasePolicy> = Object.freeze({
  idleSessionMs: 30 * 60_000,
  absoluteSessionMs: 24 * 60 * 60_000,
  requestLeaseMs: 150_000,
  retirementGraceMs: 60_000,
  keepLatest: 3,
});

export function validatePolicy(value: ReleasePolicy): Readonly<ReleasePolicy> {
  for (const [key, number] of Object.entries(value)) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${key} must be a positive safe integer`);
  }
  if (value.idleSessionMs > value.absoluteSessionMs) throw new Error('idle expiry cannot exceed absolute expiry');
  if (value.requestLeaseMs > 15 * 60_000) throw new Error('request lease must not exceed the reviewed 15-minute ceiling');
  if (value.keepLatest < 2) throw new Error('retain at least two releases for current and rollback');
  if (value.absoluteSessionMs > 7 * 24 * 60 * 60_000) throw new Error('session lifetime exceeds the reviewed seven-day ceiling');
  return Object.freeze({ ...value });
}

export function sessionExpiry(created: number, now: number, policy: ReleasePolicy): number {
  return Math.min(created + policy.absoluteSessionMs, now + policy.idleSessionMs);
}

export type ReleaseErrorCode = 'INVALID_RELEASE' | 'GENERATION_CONFLICT' | 'NOT_READY' | 'NO_DEFAULT' | 'SESSION_EXPIRED' | 'RELEASE_MISMATCH' | 'RELEASE_UNAVAILABLE' | 'RELEASE_PROTECTED' | 'INVALID_TRANSITION';
export class ReleaseError extends Error {
  constructor(readonly code: ReleaseErrorCode, message: string) { super(message); this.name = 'ReleaseError'; }
}

export const RELEASE_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
export function assertReleaseId(id: string): void {
  if (!RELEASE_ID.test(id)) throw new ReleaseError('INVALID_RELEASE', 'invalid release id');
}

export interface ProviderEndpoints {
  api: string;
  tiles: string;
  routing: string;
  geocoder: string;
  overpass: string;
}

/** Called by the trusted controller; end-user requests must never register endpoints. */
export function validateEndpoints(endpoints: ProviderEndpoints): void {
  for (const key of ['api', 'tiles', 'routing', 'geocoder', 'overpass'] as const) {
    const url = new URL(endpoints[key]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new ReleaseError('INVALID_RELEASE', 'provider endpoints must be credential-free HTTP(S) origins');
    }
  }
}
