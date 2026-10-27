import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { assertReleaseId, DEFAULT_RELEASE_POLICY, ReleaseError, validateEndpoints, validatePolicy, type ProviderEndpoints, type ReleasePolicy } from './policy.js';

// All publication, session admission and GC transitions share the same short lock.
// It is transaction-scoped: a crashed controller cannot leave an abandoned mutex.
const LOCK = 70620527;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const digest = /^[0-9a-f]{64}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export interface SessionLease { token: string; releaseId: string; expiresAt: string; absoluteExpiresAt: string; generation: string; }
interface SessionRow { release_id: string; expires_at: Date; absolute_expires_at: Date; state: string; }

export class ReleaseRegistry {
  readonly policy: Readonly<ReleasePolicy>;
  constructor(private readonly pool: Pool, policy: ReleasePolicy = DEFAULT_RELEASE_POLICY) { this.policy = validatePolicy(policy); }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally { client.release(); }
  }

  /** Controller-only: register only after artifact verification and all mandatory quality gates. */
  async registerReady(input: { id: string; sourceSha256: string; manifestSha256: string; endpoints: ProviderEndpoints }): Promise<void> {
    assertReleaseId(input.id);
    if (!digest.test(input.sourceSha256) || !digest.test(input.manifestSha256)) throw new ReleaseError('INVALID_RELEASE', 'full SHA-256 digests are required');
    validateEndpoints(input.endpoints);
    await this.transaction(async (c) => {
      // Deliberately no upsert: release contents and endpoints cannot be replaced in place.
      await c.query("INSERT INTO atlas_control.releases(id,source_sha256,manifest_sha256,endpoints,state) VALUES($1,$2,$3,$4,'ready')",
        [input.id, input.sourceSha256, input.manifestSha256, JSON.stringify(input.endpoints)]);
      await c.query("INSERT INTO atlas_control.events(event,release_id) VALUES('registered_ready',$1)", [input.id]);
    });
  }

  async defaultRelease(): Promise<{ generation: string; current_id: string | null; previous_id: string | null }> {
    const r = await this.pool.query('SELECT generation::text,current_id,previous_id FROM atlas_control.defaults WHERE singleton');
    return r.rows[0];
  }

  async publish(id: string, expectedGeneration: string): Promise<string> {
    assertReleaseId(id);
    if (!/^\d+$/.test(expectedGeneration)) throw new ReleaseError('GENERATION_CONFLICT', 'expected generation is required');
    return this.transaction(async (c) => {
      const d = (await c.query('SELECT generation::text,current_id FROM atlas_control.defaults WHERE singleton FOR UPDATE')).rows[0];
      if (d.generation !== expectedGeneration) throw new ReleaseError('GENERATION_CONFLICT', 'publication generation changed; re-evaluate before retrying');
      if (d.current_id === id) return d.generation;
      const release = (await c.query('SELECT state FROM atlas_control.releases WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!release || !['ready','available','draining'].includes(release.state)) throw new ReleaseError('NOT_READY', 'release is not publishable');
      await c.query("UPDATE atlas_control.releases SET state='draining' WHERE id=$1 AND state='available'", [d.current_id]);
      await c.query("UPDATE atlas_control.releases SET state='available',published_at=coalesce(published_at,clock_timestamp()) WHERE id=$1", [id]);
      const changed = await c.query('UPDATE atlas_control.defaults SET current_id=$1,previous_id=current_id,generation=generation+1 WHERE singleton RETURNING generation::text', [id]);
      await c.query("INSERT INTO atlas_control.events(event,release_id,detail) VALUES('published',$1,$2)", [id, JSON.stringify({ from: d.current_id, generation: changed.rows[0].generation })]);
      return changed.rows[0].generation;
    });
  }

  async createSession(): Promise<SessionLease> {
    const token = randomBytes(32).toString('base64url');
    return this.transaction(async (c) => {
      const d = (await c.query('SELECT d.generation::text,d.current_id,r.state FROM atlas_control.defaults d LEFT JOIN atlas_control.releases r ON r.id=d.current_id WHERE singleton')).rows[0];
      if (!d.current_id || d.state !== 'available') throw new ReleaseError('NO_DEFAULT', 'no verified default release is available');
      const row = (await c.query(`INSERT INTO atlas_control.sessions(token_sha256,release_id,expires_at,absolute_expires_at)
        VALUES($1,$2,clock_timestamp()+$3*interval '1 millisecond',clock_timestamp()+$4*interval '1 millisecond')
        RETURNING expires_at,absolute_expires_at`, [hash(token), d.current_id, this.policy.idleSessionMs, this.policy.absoluteSessionMs])).rows[0];
      return { token, releaseId: d.current_id, expiresAt: row.expires_at.toISOString(), absoluteExpiresAt: row.absolute_expires_at.toISOString(), generation: d.generation };
    });
  }

  private async session(c: PoolClient, token: string, releaseId?: string): Promise<SessionRow> {
    if (!tokenPattern.test(token)) throw new ReleaseError('SESSION_EXPIRED', 'invalid or expired session');
    const row = (await c.query<SessionRow>(`SELECT s.release_id,s.expires_at,s.absolute_expires_at,r.state FROM atlas_control.sessions s
      JOIN atlas_control.releases r ON r.id=s.release_id
      WHERE token_sha256=$1 AND s.expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp() FOR UPDATE OF s`, [hash(token)])).rows[0];
    if (!row) throw new ReleaseError('SESSION_EXPIRED', 'session expired; create a new map session');
    if (releaseId && row.release_id !== releaseId) throw new ReleaseError('RELEASE_MISMATCH', 'request and session name different releases');
    if (!['available','draining'].includes(row.state)) throw new ReleaseError('RELEASE_UNAVAILABLE', 'session release is no longer servable');
    return row;
  }

  async renewSession(token: string): Promise<{ releaseId: string; expiresAt: string; absoluteExpiresAt: string }> {
    return this.transaction(async (c) => {
      const row = await this.session(c, token);
      const renewed = (await c.query(`UPDATE atlas_control.sessions SET expires_at=least(absolute_expires_at,clock_timestamp()+$2*interval '1 millisecond')
        WHERE token_sha256=$1 RETURNING expires_at`, [hash(token), this.policy.idleSessionMs])).rows[0];
      return { releaseId: row.release_id, expiresAt: renewed.expires_at.toISOString(), absoluteExpiresAt: row.absolute_expires_at.toISOString() };
    });
  }

  async closeSession(token: string): Promise<void> {
    if (!tokenPattern.test(token)) return;
    await this.transaction(async (c) => { await c.query('DELETE FROM atlas_control.sessions WHERE token_sha256=$1', [hash(token)]); });
  }

  async acquireRequest(releaseId: string, sessionToken: string): Promise<{ requestId: string; endpoints: ProviderEndpoints; expiresAt: string }> {
    assertReleaseId(releaseId);
    return this.transaction(async (c) => {
      await this.session(c, sessionToken, releaseId);
      const id = randomBytes(24).toString('hex');
      const row = (await c.query(`INSERT INTO atlas_control.requests(id,release_id,expires_at)
        VALUES($1,$2,clock_timestamp()+$3*interval '1 millisecond') RETURNING expires_at`, [id, releaseId, this.policy.requestLeaseMs])).rows[0];
      const release = (await c.query('SELECT endpoints FROM atlas_control.releases WHERE id=$1', [releaseId])).rows[0];
      return { requestId: id, endpoints: release.endpoints, expiresAt: row.expires_at.toISOString() };
    });
  }

  async releaseRequest(id: string): Promise<void> { await this.pool.query('DELETE FROM atlas_control.requests WHERE id=$1', [id]); }

  private async protected(c: PoolClient, id: string): Promise<boolean> {
    const r = await c.query(`SELECT
      EXISTS(SELECT FROM atlas_control.defaults WHERE current_id=$1 OR previous_id=$1)
      OR EXISTS(SELECT FROM atlas_control.releases WHERE id=$1 AND pinned)
      OR EXISTS(SELECT FROM atlas_control.sessions WHERE release_id=$1 AND expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp())
      OR EXISTS(SELECT FROM atlas_control.requests WHERE release_id=$1 AND expires_at>clock_timestamp())
      OR EXISTS(SELECT FROM atlas_control.build_references WHERE release_id=$1)
      OR $1 IN (SELECT id FROM atlas_control.releases WHERE published_at IS NOT NULL AND state IN ('available','draining') ORDER BY published_at DESC,id DESC LIMIT $2)
      AS protected`, [id, this.policy.keepLatest]);
    return r.rows[0].protected;
  }

  async retire(id: string): Promise<void> {
    assertReleaseId(id);
    await this.transaction(async (c) => {
      if (await this.protected(c, id)) throw new ReleaseError('RELEASE_PROTECTED', 'release still has a retention reference');
      const r = await c.query("UPDATE atlas_control.releases SET state='retired',retired_at=clock_timestamp() WHERE id=$1 AND state='draining' RETURNING id", [id]);
      if (!r.rowCount) throw new ReleaseError('INVALID_TRANSITION', 'only a drained release can retire');
      await c.query("INSERT INTO atlas_control.events(event,release_id) VALUES('retired',$1)", [id]);
    });
  }

  /** Storage deletion happens only after this fenced transition; sessions can no longer enter. */
  async beginDeletion(id: string): Promise<string> {
    assertReleaseId(id);
    return this.transaction(async (c) => {
      if (await this.protected(c, id)) throw new ReleaseError('RELEASE_PROTECTED', 'release acquired a retention reference');
      const token = randomBytes(24).toString('hex');
      const r = await c.query(`UPDATE atlas_control.releases SET state='deleting',deletion_token=$2
        WHERE id=$1 AND state='retired' AND retired_at <= clock_timestamp()-$3*interval '1 millisecond' RETURNING id`, [id, token, this.policy.retirementGraceMs]);
      if (!r.rowCount) throw new ReleaseError('INVALID_TRANSITION', 'release has not completed its retirement grace');
      return token;
    });
  }

  async finishDeletion(id: string, token: string): Promise<void> {
    await this.transaction(async (c) => {
      const r = await c.query("UPDATE atlas_control.releases SET state='deleted',deletion_token=NULL WHERE id=$1 AND state='deleting' AND deletion_token=$2 RETURNING id", [id, token]);
      if (!r.rowCount) throw new ReleaseError('INVALID_TRANSITION', 'deletion fencing token is stale');
      await c.query("INSERT INTO atlas_control.events(event,release_id) VALUES('deleted',$1)", [id]);
    });
  }
}
