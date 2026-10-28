import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {reviewReasons,type Coverage} from './qa.js';
import {tileSqlForRole,verifyIoMax} from './data.js';
const valid=():Omit<Coverage,'review_reasons'>=>({schema:'atlas.feature-coverage/1',source_sha256:'a'.repeat(64),accounting:{missing_outcomes:0,orphan_outcomes:0},
  outcomes:[{status:'rendered',objects:1}],layers:{pois:{rows:1,observed_inserts:1,empty_geometries:0,invalid_geometries:0}},
  uncatalogued:[],incomplete_relations:[],incomplete_relation_examples:[],relation_impact:{},geographic_truth_verified:false});
describe('candidate quality barriers',()=>{
  it('holds complete accounting with unsupported content and partial geometry for review',()=>{
    const r=valid();r.outcomes.push({status:'partial',objects:1},{status:'uncatalogued',objects:2},{status:'catalog_policy_excluded',objects:1});
    r.incomplete_relations.push({missing_references:1});
    expect(reviewReasons(r)).toEqual(['geometry_conversion_issues','catalog_coverage_incomplete','incomplete_source_topology']);
  });
  it('rejects missing outcomes and successful-insert counts that do not match actual stored rows',()=>{
    const absent=valid();absent.accounting.missing_outcomes=1;expect(()=>reviewReasons(absent)).toThrow('outcome_accounting_failed');
    const missing=valid();missing.layers.pois.rows=0;expect(()=>reviewReasons(missing)).toThrow('layer_integrity_failed');
    const silent=valid();silent.outcomes.push({status:'unaccounted',objects:1});expect(()=>reviewReasons(silent)).toThrow('unexplained_catalog_loss');
  });
  it('keeps metadata-only primitives accounted without inventing display coverage',()=>{
    const r=valid();r.outcomes.push({status:'metadata_only',objects:20});expect(reviewReasons(r)).toEqual([]);
  });
  it('grants the fixed tile function only to the generated role and rejects changed SQL contracts',()=>{
    const sql=readFileSync(new URL('../../../infra/atlas/tiles.sql',import.meta.url),'utf8');
    expect(tileSqlForRole(sql,'atlas_tile_example')).not.toContain('TO atlas_tile;');
    expect(()=>tileSqlForRole(sql,'bad;DROP')).toThrow();expect(()=>tileSqlForRole(sql.replaceAll('TO atlas_tile;','TO someone_else;'),'atlas_tile_example')).toThrow('tile_grant_contract_changed');
  });
  it('requires actual kernel per-device I/O ceilings',()=>{
    const limits={memoryBytes:3*1024**3,cpus:1,cpuShares:256,readBps:16777216,writeBps:16777216,devices:[{path:'/dev/sda',majorMinor:'8:0'},{path:'/dev/dm-0',majorMinor:'252:0'}]};
    expect(()=>verifyIoMax('8:0 rbps=16777216 wbps=16777216\n252:0 rbps=16777216 wbps=16777216',limits)).not.toThrow();
    expect(()=>verifyIoMax('8:0 rbps=max wbps=max',limits)).toThrow('data_io_limits_not_enforced');
  });
});
