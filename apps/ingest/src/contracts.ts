import {createHash} from 'node:crypto';

export const sha256=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
export const hex32=/^[0-9a-f]{32}$/;
export const hex64=/^[0-9a-f]{64}$/;
export const kinds=['node','way','relation'] as const;
export type Counts=Record<typeof kinds[number],number>;
export class IntakeError extends Error {
  constructor(readonly code:string){super(code);this.name='IntakeError';}
}
export function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new IntakeError('invalid_object');
  return value as Record<string,unknown>;
}
export function exact(value:Record<string,unknown>,keys:readonly string[]):void{
  if(Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))throw new IntakeError('invalid_fields');
}
export function text(value:unknown,max=200):string{
  if(typeof value!=='string'||!value.length||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new IntakeError('invalid_text');
  return value;
}
export function integer(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new IntakeError('invalid_integer');
  return value;
}
function boolean(value:unknown):boolean{if(typeof value!=='boolean')throw new IntakeError('invalid_boolean');return value;}
export function hash(value:unknown):string{const result=text(value,64);if(!hex64.test(result))throw new IntakeError('invalid_sha256');return result;}
export function id(value:unknown):string{const result=text(value,32);if(!hex32.test(result))throw new IntakeError('invalid_id');return result;}
export function counts(value:unknown):Counts{
  const v=object(value);exact(v,kinds);
  return {node:integer(v.node),way:integer(v.way),relation:integer(v.relation)};
}
export interface Source {provider:string;region:string;url:string;}
export interface Submission {schema:'atlas.submission/1';id:string;sha256:string;bytes:number;source:Source;}
export function parseSource(value:unknown):Source{
  const v=object(value);exact(v,['provider','region','url']);
  const provider=text(v.provider,32),region=text(v.region,32),url=text(v.url,512);
  if(!/^[a-z][a-z0-9-]{1,31}$/.test(provider)||!/^[a-z][a-z0-9-]{1,31}$/.test(region))throw new IntakeError('invalid_source');
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.href!==url)throw new IntakeError('invalid_source_url');
  return {provider,region,url};
}
export function parseSubmission(value:unknown,maxBytes:number):Submission{
  const v=object(value);exact(v,['schema','id','sha256','bytes','source']);
  if(v.schema!=='atlas.submission/1')throw new IntakeError('unsupported_submission');
  return {schema:v.schema,id:id(v.id),sha256:hash(v.sha256),bytes:integer(v.bytes,1,maxBytes),source:parseSource(v.source)};
}

export interface IntakePolicy {
  schema:'atlas.intake-policy/1';name:string;region:string;provider:string;sourceHost:string;sourcePathPattern:string;
  requireBaseline:boolean;requireSnapshot:boolean;maxSnapshotAgeDays:number;maxFutureMinutes:number;
  minCounts:Counts;maxCounts:Counts;minRelativeRatio:number;maxRelativeRatio:number;
  regionEnvelope:[number,number,number,number];
}
export function validationSpec(policy:IntakePolicy,validatorImage:string,controllerSha256:string):string{
  if(!/^sha256:[0-9a-f]{64}$/.test(validatorImage))throw new IntakeError('immutable_validator_required');
  hash(controllerSha256);
  return sha256(JSON.stringify({schema:'atlas.intake-spec/1',policy,validatorImage,controllerSha256}));
}
export function parsePolicy(value:unknown):IntakePolicy{
  const v=object(value);
  exact(v,['schema','name','region','provider','sourceHost','sourcePathPattern','requireBaseline','requireSnapshot',
    'maxSnapshotAgeDays','maxFutureMinutes','minCounts','maxCounts','minRelativeRatio','maxRelativeRatio','regionEnvelope']);
  if(v.schema!=='atlas.intake-policy/1')throw new IntakeError('unsupported_policy');
  const minCounts=counts(v.minCounts),maxCounts=counts(v.maxCounts);
  for(const k of kinds)if(maxCounts[k]<minCounts[k])throw new IntakeError('invalid_count_range');
  const minRelativeRatio=v.minRelativeRatio,maxRelativeRatio=v.maxRelativeRatio;
  if(typeof minRelativeRatio!=='number'||typeof maxRelativeRatio!=='number'||!Number.isFinite(minRelativeRatio)||
    !Number.isFinite(maxRelativeRatio)||minRelativeRatio<=0||minRelativeRatio>=1||maxRelativeRatio<=1||maxRelativeRatio>3)
    throw new IntakeError('invalid_ratio');
  const envelope=v.regionEnvelope;
  if(!Array.isArray(envelope)||envelope.length!==4||envelope.some(n=>typeof n!=='number'||!Number.isFinite(n))||
    envelope[0]<-180||envelope[1]<-90||envelope[2]>180||envelope[3]>90||envelope[0]>=envelope[2]||envelope[1]>=envelope[3])
    throw new IntakeError('invalid_envelope');
  const sourcePathPattern=text(v.sourcePathPattern,200);
  // This is trusted operator configuration, never a pattern supplied by a submission.
  if(!sourcePathPattern.startsWith('^')||!sourcePathPattern.endsWith('$'))throw new IntakeError('unanchored_source_rule');
  new RegExp(sourcePathPattern);
  return {schema:v.schema,name:text(v.name,80),region:text(v.region,32),provider:text(v.provider,32),sourceHost:text(v.sourceHost,200),sourcePathPattern,
    requireBaseline:boolean(v.requireBaseline),requireSnapshot:boolean(v.requireSnapshot),maxSnapshotAgeDays:integer(v.maxSnapshotAgeDays,1,365),
    maxFutureMinutes:integer(v.maxFutureMinutes,0,1440),minCounts,maxCounts,minRelativeRatio,maxRelativeRatio,regionEnvelope:envelope as IntakePolicy['regionEnvelope']};
}

export interface AuditReport {
  schema:'atlas.pbf-audit/1';source:{sha256:string;bytes:number;header:Record<string,unknown>};
  counts:Counts;blockers:string[];review_reasons:string[];ordered:boolean;
  bbox:[number,number,number,number]|null;references:{counts:Record<string,number>;missing:Record<string,number>};
  semantic_digest:{node:string;way:string;relation:string;format:string};
}
function codes(value:unknown):string[]{
  if(!Array.isArray(value)||value.length>100)throw new IntakeError('invalid_report_codes');
  return value.map(v=>{const t=text(v,80);if(!/^[a-z][a-z0-9_]*$/.test(t))throw new IntakeError('invalid_report_code');return t;});
}
function referenceCounts(value:unknown):Record<string,number>{
  const v=object(value),out:Record<string,number>={};
  for(const[key,n]of Object.entries(v)){
    if(!/^(way_to_node|relation_to_(node|way|relation))$/.test(key))throw new IntakeError('invalid_reference_kind');
    out[key]=integer(n);
  }return out;
}
export function parseAudit(value:unknown,submission:Submission):AuditReport{
  const v=object(value),source=object(v.source),refs=object(v.references),digests=object(v.semantic_digest);
  if(v.schema!=='atlas.pbf-audit/1'||hash(source.sha256)!==submission.sha256||integer(source.bytes,1)!==submission.bytes||typeof v.ordered!=='boolean')
    throw new IntakeError('audit_identity_mismatch');
  const bbox=v.bbox;
  if(bbox!==null&&(!Array.isArray(bbox)||bbox.length!==4||bbox.some(n=>typeof n!=='number'||!Number.isFinite(n))||
    bbox[0]<-180||bbox[1]<-90||bbox[2]>180||bbox[3]>90||bbox[0]>bbox[2]||bbox[1]>bbox[3]))throw new IntakeError('invalid_report_bbox');
  return {schema:'atlas.pbf-audit/1',source:{sha256:submission.sha256,bytes:submission.bytes,header:object(source.header)},
    counts:counts(v.counts),blockers:codes(v.blockers),review_reasons:codes(v.review_reasons),ordered:v.ordered,
    bbox:bbox as AuditReport['bbox'],references:{counts:referenceCounts(refs.counts),missing:referenceCounts(refs.missing)},
    semantic_digest:{node:hash(digests.node),way:hash(digests.way),relation:hash(digests.relation),format:text(digests.format,200)}};
}
export interface Baseline {id:string;sourceSha256:string;snapshot:string|null;counts:Counts;}
export interface Decision {kind:'pass'|'review'|'reject';reasons:string[];snapshot:string|null;counts:Counts;baselineId:string|null;}
export function evaluate(report:AuditReport,submission:Submission,policy:IntakePolicy,baseline:Baseline|null,now=Date.now()):Decision{
  const hard=[...report.blockers],review=[...report.review_reasons];
  if(!report.ordered)hard.push('objects_not_ordered');
  if((report.references.missing.way_to_node??0)>0)hard.push('missing_way_nodes');
  const sourceUrl=new URL(submission.source.url);
  if(submission.source.region!==policy.region||submission.source.provider!==policy.provider||sourceUrl.hostname!==policy.sourceHost||
    !new RegExp(policy.sourcePathPattern).test(sourceUrl.pathname))review.push('source_outside_policy');
  let snapshot:string|null=null;
  const rawStamp=report.source.header.osmosis_replication_timestamp;
  if(typeof rawStamp==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(rawStamp)&&
    Number.isFinite(Date.parse(rawStamp))&&new Date(rawStamp).toISOString().replace('.000Z','Z')===rawStamp)snapshot=rawStamp;
  if(!snapshot&&policy.requireSnapshot)review.push('missing_snapshot_timestamp');
  if(snapshot){
    const time=Date.parse(snapshot);
    if(time>now+policy.maxFutureMinutes*60000)review.push('snapshot_in_future');
    if(time<now-policy.maxSnapshotAgeDays*86400000)review.push('snapshot_too_old');
    if(baseline?.snapshot&&time<Date.parse(baseline.snapshot))hard.push('snapshot_regressed');
    else if(baseline?.snapshot&&time===Date.parse(baseline.snapshot)&&baseline.sourceSha256!==submission.sha256)review.push('snapshot_content_changed');
  }
  if(policy.requireBaseline&&!baseline)review.push('initial_baseline_required');
  for(const k of kinds){
    if(report.counts[k]<policy.minCounts[k]||report.counts[k]>policy.maxCounts[k])review.push(`${k}_count_outside_policy`);
    if(baseline&&baseline.counts[k]>0){const ratio=report.counts[k]/baseline.counts[k];if(ratio<policy.minRelativeRatio||ratio>policy.maxRelativeRatio)review.push(`${k}_count_changed`);}
  }
  if(report.bbox){const[b0,b1,b2,b3]=report.bbox,[e0,e1,e2,e3]=policy.regionEnvelope;
    if(b0<e0||b1<e1||b2>e2||b3>e3)review.push('outside_region_envelope');
  }else hard.push('no_valid_extent');
  const missingRelations=Object.entries(report.references.missing).some(([k,v])=>k.startsWith('relation_')&&v>0);
  if(missingRelations)review.push('incomplete_relation_members');
  return {kind:hard.length?'reject':review.length?'review':'pass',reasons:[...new Set(hard.length?hard:review)].sort(),snapshot,counts:report.counts,baselineId:baseline?.id??null};
}
