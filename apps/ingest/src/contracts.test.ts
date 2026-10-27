import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {evaluate,parseAudit,parsePolicy,parseSubmission,type Baseline,type Submission} from './contracts.js';
const iran=parsePolicy(JSON.parse(readFileSync(new URL('../../../infra/atlas/intake/iran-policy.json',import.meta.url),'utf8')));
const source=JSON.parse(readFileSync(new URL('../../../docs/evidence/2026-10-27/input-audit-summary.json',import.meta.url),'utf8'));
const delivery:Submission={schema:'atlas.submission/1',id:'1'.repeat(32),sha256:source.source.sha256,bytes:source.source.bytes,
  source:{provider:'geofabrik',region:'iran',url:'https://download.geofabrik.de/asia/iran-261025.osm.pbf'}};
const report=parseAudit(source,delivery);
const baseline:Baseline={id:'2'.repeat(32),sourceSha256:delivery.sha256,snapshot:'2026-10-24T21:21:21Z',counts:report.counts};
const now=Date.parse('2026-10-27T00:00:00Z');
describe('source acceptance policy',()=>{
  it('requires review of the actual Iran incomplete relations and initial baseline',()=>{
    expect(evaluate(report,delivery,iran,null,now)).toMatchObject({kind:'review',reasons:['incomplete_relation_members','initial_baseline_required']});
  });
  it('automatically passes an ordinary newer snapshot when all references and baseline gates pass',()=>{
    const complete={...report,review_reasons:[],references:{...report.references,missing:{}}};
    expect(evaluate(complete,delivery,iran,baseline,now)).toMatchObject({kind:'pass',reasons:[],baselineId:baseline.id});
  });
  it('never turns missing way nodes or a regressed snapshot into a reviewable success',()=>{
    expect(evaluate({...report,blockers:['missing_way_nodes']},delivery,iran,baseline,now).kind).toBe('reject');
    expect(evaluate(report,delivery,iran,{...baseline,snapshot:'2026-10-26T00:00:00Z'},now)).toMatchObject({kind:'reject',reasons:['snapshot_regressed']});
  });
  it('flags count loss, future time and a source outside its approved namespace',()=>{
    const changed={...report,counts:{...report.counts,node:1},source:{...report.source,header:{...report.source.header,osmosis_replication_timestamp:'2026-10-28T00:00:00Z'}}};
    const decision=evaluate(changed,{...delivery,source:{...delivery.source,url:'https://other.example/iran.osm.pbf'}},iran,baseline,now);
    expect(decision.reasons).toEqual(expect.arrayContaining(['node_count_changed','node_count_outside_policy','snapshot_in_future','source_outside_policy']));
  });
  it('rejects credentials, extra fields and an audit for different bytes',()=>{
    expect(()=>parseSubmission({...delivery,source:{...delivery.source,url:'https://user:secret@download.geofabrik.de/asia/iran-latest.osm.pbf'}},1e9)).toThrow();
    expect(()=>parseSubmission({...delivery,publisher_signature_verified:true},1e9)).toThrow();
    expect(()=>parseAudit(source,{...delivery,sha256:'a'.repeat(64)})).toThrow();
  });
});
