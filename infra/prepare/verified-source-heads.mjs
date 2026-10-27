import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Host Git records actual heads; the ops container checks the record against its pinned inputs. */
export function loadVerifiedSourceHeads(file, configFile, sourcesDir) {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const configBytes = readFileSync(configFile);
  const config = JSON.parse(configBytes.toString('utf8'));
  const digest = createHash('sha256').update(configBytes).digest('hex');
  if (record.schema !== 'seyra.verified-source-heads/1') throw new Error('unsupported source-head verification record');
  if (record.sources_config_sha256 !== digest) throw new Error('source-head record does not match sources.json');
  if (typeof record.sources_dir !== 'string' || resolve(record.sources_dir) !== resolve(sourcesDir)) {
    throw new Error('source-head record belongs to a different source directory');
  }
  const heads = {};
  for (const [name, source] of Object.entries(config.sources)) {
    const observed = record.checkouts?.[name]?.observed_commit;
    if (observed !== source.commit) throw new Error(`${name}: source-head record is missing or differs from the pinned commit`);
    heads[name] = observed;
  }
  return heads;
}
