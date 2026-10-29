// Real HTTP with a deliberately stalled observer event loop. No platform service is used.
import {Worker} from 'node:worker_threads';
import assert from 'node:assert/strict';
import {classifyServingObservation} from './serving-observation.mjs';
const server=new Worker(`const {parentPort}=require('node:worker_threads');const http=require('node:http');const s=http.createServer((req,res)=>{parentPort.postMessage('received');setTimeout(()=>res.end('fixture'),100);});s.listen(0,'127.0.0.1',()=>parentPort.postMessage(s.address().port));`,{eval:true});
try{
 const port=await new Promise(resolve=>server.once('message',resolve));
 const received=new Promise(resolve=>server.once('message',resolve)),start=performance.now();
 const task=fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(5000)});task.catch(()=>{});
 await received;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5200);
 let raw;try{const r=await task;await r.arrayBuffer();raw={status:r.status};}catch(e){raw={status:0,error:e.name};}
 const elapsed=performance.now()-start,classified=classifyServingObservation(raw,elapsed);
 assert.ok(elapsed>5000);assert.equal(classified.status,0);
 assert.equal(classifyServingObservation({status:200},5000).status,200);
 assert.deepEqual(classifyServingObservation({status:200},5000.001),{status:0,wire_status:200,error:'ElapsedDeadlineExceeded',ms:5000.001});
 assert.equal(classifyServingObservation({status:204,bytes_match_first_sample:false},1).error,'ContentChanged');
 assert.equal(classifyServingObservation({status:200,matches_first_observation:false},1).error,'ContentChanged');
 console.log(JSON.stringify({schema:'atlas.observer-deadline-regression/1',passed:true,http_fixture_only:true,elapsed_ms:elapsed,raw_status:raw.status,classified_status:classified.status,late_200_rejected:true,content_change_rejected:true}));
}finally{await server.terminate();}
