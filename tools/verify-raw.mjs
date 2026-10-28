import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import pg from 'pg';

const [auditFile, outputFile] = process.argv.slice(2);
if (!auditFile || !outputFile || auditFile === outputFile) throw new Error('usage: verify-raw.mjs AUDIT.json REPORT.json');
const audit = JSON.parse(readFileSync(auditFile,'utf8'));
if (audit.schema !== 'atlas.pbf-audit/1' || audit.blockers.length) throw new Error('a completed structural audit is required');
const connectionString=process.env.ATLAS_RAW_CONNECTION_FILE?readFileSync(process.env.ATLAS_RAW_CONNECTION_FILE,'utf8').trim():undefined;
const database=connectionString?new URL(connectionString).pathname.slice(1):process.env.ATLAS_RAW_DATABASE??'atlas_lab';
if (!/^atlas_(lab|test[a-z0-9_]*|candidate_[0-9a-f]{24}_[0-9a-f]{16})$/.test(database)) throw new Error('raw verifier is restricted to Atlas lab/test/candidate databases');
const connection=connectionString?{connectionString}:{host:'db',database,user:'atlas_admin',password:readFileSync(process.env.ATLAS_TEST_DB_PASSWORD_FILE??'/run/secrets/db_password','utf8').trim()};
const client = new pg.Client({...connection,connectionTimeoutMillis:5000,statement_timeout:30000});
const integer = value => value === null ? null : JSON.rawJSON(String(value));
const normalizeTimestamp = value => value === null ? null : value.toISOString().replace('.000Z','Z');
const parseExact = text => JSON.parse(text, (_key,value,context) => {
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) return JSON.rawJSON(context.source);
  return value;
});
const queries = {
  node: 'SELECT osm_id,source_version,source_timestamp,source_changeset,source_uid,source_user,tags,round((ST_X(geom)*10000000)::numeric)::bigint AS x,round((ST_Y(geom)*10000000)::numeric)::bigint AS y FROM osm_raw.nodes ORDER BY osm_id',
  way: 'SELECT osm_id,source_version,source_timestamp,source_changeset,source_uid,source_user,tags,nodes FROM osm_raw.ways ORDER BY osm_id',
  relation: 'SELECT osm_id,source_version,source_timestamp,source_changeset,source_uid,source_user,tags,members::text AS members_text FROM osm_raw.relations ORDER BY osm_id',
};
const results = {};
await client.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  for (const kind of ['node','way','relation']) {
    await client.query(`DECLARE raw_cursor NO SCROLL CURSOR FOR ${queries[kind]}`);
    const h = createHash('sha256');
    const size = Buffer.alloc(8);
    let count = 0;
    for (;;) {
      const batch = await client.query('FETCH FORWARD 5000 FROM raw_cursor');
      if (!batch.rows.length) break;
      for (const row of batch.rows) {
        let content;
        if (kind === 'node') content = [integer(row.x),integer(row.y)];
        else if (kind === 'way') content = row.nodes.map(integer);
        else {
          const members = parseExact(row.members_text);
          if (!Array.isArray(members)) throw new Error('relation members must be an ordered JSON array');
          content = members.map(m=>[m.type,m.ref,m.role]);
        }
        const tags = Object.entries(row.tags).sort((a,b)=>Buffer.compare(Buffer.from(a[0]),Buffer.from(b[0])));
        const record = [integer(row.osm_id),[row.source_version,normalizeTimestamp(row.source_timestamp),integer(row.source_changeset),row.source_uid,row.source_user,true],tags,content];
        const encoded = Buffer.from(JSON.stringify(record),'utf8');
        size.writeBigUInt64BE(BigInt(encoded.byteLength));
        h.update(size); h.update(encoded); count++;
      }
      if (count%1000000 === 0) process.stdout.write(`${kind}: ${count} canonical rows verified\n`);
    }
    await client.query('CLOSE raw_cursor');
    const observed = h.digest('hex');
    results[kind] = {count,sha256:observed,count_matches:count===audit.counts[kind],digest_matches:observed===audit.semantic_digest[kind]};
    process.stdout.write(`${kind}: ${JSON.stringify(results[kind])}\n`);
  }
  await client.query('COMMIT');
} catch (error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
finally { await client.end(); }
const passed = Object.values(results).every(r=>r.count_matches && r.digest_matches);
const report = {schema:'atlas.raw-roundtrip/1',source_sha256:audit.source.sha256,format:audit.semantic_digest.format,results,passed};
writeFileSync(`${outputFile}.partial`,JSON.stringify(report,null,2)+'\n');
renameSync(`${outputFile}.partial`,outputFile);
if (!passed) process.exitCode = 1;
