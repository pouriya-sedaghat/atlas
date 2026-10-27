import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const[output]=process.argv.slice(2);if(!output)throw new Error('output path required');
const z=14,n=2**z,x=Math.floor((51.389+180)/360*n),y=Math.floor((1-Math.asinh(Math.tan(35.6892*Math.PI/180))/Math.PI)/2*n);
const started=new Date().toISOString(),rows=[];
for(let i=0;i<120;i++){
  const start=performance.now();
  try{
    const r=await fetch(`http://martin:3000/basemap/${z}/${x}/${y}`,{signal:AbortSignal.timeout(5000)});
    const bytes=(await r.arrayBuffer()).byteLength;rows.push({status:r.status,bytes,ms:Number((performance.now()-start).toFixed(3))});
  }catch{rows.push({error:true,ms:Number((performance.now()-start).toFixed(3))});}
  await delay(250);
}
const report={schema:'atlas.intake-serving-probe/1',started_at:started,ended_at:new Date().toISOString(),requests:rows.length,
  errors:rows.filter(r=>r.error||r.status!==200||!r.bytes).length,scope:'existing internal Martin tiles during source validation; no publication or public-gateway test',rows};
writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({requests:report.requests,errors:report.errors}));
if(report.errors)process.exitCode=1;
