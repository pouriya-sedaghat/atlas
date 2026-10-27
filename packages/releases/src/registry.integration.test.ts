import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RELEASE_POLICY } from './policy.js';
import { ReleaseRegistry } from './registry.js';

// This suite owns a dedicated disposable database, never a live platform control DB.
const connectionString = process.env.ATLAS_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('transactional release registry against PostgreSQL', () => {
  const pool = new pg.Pool({connectionString, max:8, connectionTimeoutMillis:5000, statement_timeout:10000});
  const registry = new ReleaseRegistry(pool);
  const endpoints = {api:'http://api-r1:3000',tiles:'http://tiles-r1:3000',routing:'http://routing-r1:8002',geocoder:'http://geocoder-r1:2322',overpass:'http://poi-r1:8080'};
  const endpointsFor = (id: string) => Object.fromEntries(Object.entries(endpoints).map(([key,url])=>[key,url.replace('-r1',`-${id}`)])) as typeof endpoints;
  const ready = (id: string) => registry.registerReady({id,sourceSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),endpoints:endpointsFor(id)});
  beforeAll(async () => {
    const db = await pool.query('SELECT current_database() AS name');
    if (!String(db.rows[0].name).startsWith('atlas_test')) throw new Error('integration suite requires a dedicated atlas_test* database');
    await pool.query(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE atlas_control.events,atlas_control.build_references,atlas_control.requests,atlas_control.sessions,atlas_control.defaults,atlas_control.releases CASCADE');
    await pool.query('INSERT INTO atlas_control.defaults(singleton) VALUES(true)');
  });
  afterAll(() => pool.end());

  it('linearizes two competing publications and preserves the losing ready release', async () => {
    await ready('release-one'); await ready('release-two');
    const results = await Promise.allSettled([registry.publish('release-one','0'),registry.publish('release-two','0')]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);
    expect((await registry.defaultRelease()).generation).toBe('1');
  });

  it('keeps old sessions usable while new sessions select the newly published release', async () => {
    await ready('release-one'); await registry.publish('release-one','0');
    const old = await registry.createSession();
    await ready('release-two'); await registry.publish('release-two','1');
    const fresh = await registry.createSession();
    expect(old.releaseId).toBe('release-one'); expect(fresh.releaseId).toBe('release-two');
    const request = await registry.acquireRequest('release-one',old.token);
    expect(request.endpoints).toEqual(endpointsFor('release-one'));
    const freshRequest = await registry.acquireRequest('release-two',fresh.token);
    expect(freshRequest.endpoints).toEqual(endpointsFor('release-two'));
    expect(freshRequest.endpoints).not.toEqual(request.endpoints);
    await expect(registry.acquireRequest('release-two',old.token)).rejects.toMatchObject({code:'RELEASE_MISMATCH'});
    await registry.releaseRequest(request.requestId);
    await registry.releaseRequest(freshRequest.requestId);
    expect((await registry.renewSession(old.token)).releaseId).toBe('release-one');
  });

  it('protects in-flight work after session expiry, then fences deletion and keeps a tombstone', async () => {
    await ready('release-one'); await registry.publish('release-one','0');
    const session = await registry.createSession();
    const request = await registry.acquireRequest('release-one',session.token);
    for (let n=2;n<=5;n++) {await ready(`release-${n}`);await registry.publish(`release-${n}`,String(n-1));}
    await pool.query("UPDATE atlas_control.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE release_id='release-one'");
    await expect(registry.retire('release-one')).rejects.toMatchObject({code:'RELEASE_PROTECTED'});
    await registry.releaseRequest(request.requestId);
    await registry.retire('release-one');
    await expect(registry.beginDeletion('release-one')).rejects.toMatchObject({code:'INVALID_TRANSITION'});
    await pool.query("UPDATE atlas_control.releases SET retired_at=clock_timestamp()-interval '2 minutes' WHERE id='release-one'");
    const fence = await registry.beginDeletion('release-one');
    await expect(registry.finishDeletion('release-one','stale-token')).rejects.toMatchObject({code:'INVALID_TRANSITION'});
    await registry.finishDeletion('release-one',fence);
    expect((await pool.query("SELECT state FROM atlas_control.releases WHERE id='release-one'")).rows[0].state).toBe('deleted');
  });

  it('does not let repeated renewals extend the absolute lifetime', async () => {
    await ready('release-one'); await registry.publish('release-one','0');
    const lease = await registry.createSession();
    await pool.query("UPDATE atlas_control.sessions SET absolute_expires_at=clock_timestamp()+interval '10 seconds',expires_at=clock_timestamp()+interval '5 seconds'");
    const renewed = await registry.renewSession(lease.token);
    expect(Date.parse(renewed.expiresAt)).toBe(Date.parse(renewed.absoluteExpiresAt));
    expect(DEFAULT_RELEASE_POLICY.absoluteSessionMs).toBe(86400_000);
  });

  it('refuses to replace a registered release or publish an unknown release', async () => {
    await ready('release-one');
    await expect(ready('release-one')).rejects.toThrow();
    await expect(registry.publish('release-missing','0')).rejects.toMatchObject({code:'NOT_READY'});
    await expect(registry.createSession()).rejects.toMatchObject({code:'NO_DEFAULT'});
  });

  it('protects retained history, manual pins and build dependencies, and supports atomic rollback', async () => {
    for (let n=1;n<=5;n++) {await ready(`release-${n}`);await registry.publish(`release-${n}`,String(n-1));}
    await expect(registry.retire('release-3')).rejects.toMatchObject({code:'RELEASE_PROTECTED'});
    await pool.query("UPDATE atlas_control.releases SET pinned=true WHERE id='release-1'");
    await expect(registry.retire('release-1')).rejects.toMatchObject({code:'RELEASE_PROTECTED'});
    await pool.query("UPDATE atlas_control.releases SET pinned=false WHERE id='release-1'");
    await pool.query("INSERT INTO atlas_control.build_references(job_id,release_id) VALUES('build-a','release-1')");
    await expect(registry.retire('release-1')).rejects.toMatchObject({code:'RELEASE_PROTECTED'});
    await pool.query("DELETE FROM atlas_control.build_references WHERE job_id='build-a'");
    const beforeRollback = await registry.createSession();
    await registry.publish('release-1','5');
    expect((await registry.createSession()).releaseId).toBe('release-1');
    expect((await registry.renewSession(beforeRollback.token)).releaseId).toBe('release-5');
    expect(await registry.defaultRelease()).toEqual({generation:'6',current_id:'release-1',previous_id:'release-5'});
  });
});
