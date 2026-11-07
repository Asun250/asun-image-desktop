import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, readFile, readdir, writeFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import {newProject, addRaster, addReference} from '../public/core.mjs';
import {withSheetPreset} from '../public/sheet-preset.mjs';
import {createServer} from '../server.mjs';
import {createDesktopSheetService, prepareSheetRequest, inspectSheetImage, readSheetBody, SHEET_MODELS, SHEET_REQUEST_BYTES} from '../desktop-sheet-service.mjs';

const key='sk-fixture-not-a-real-key-12345';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function png(red=255) {
  const crc=bytes=>{let result=0xffffffff;for(const byte of bytes){result^=byte;for(let i=0;i<8;i++)result=(result>>>1)^((result&1)?0xedb88320:0);}return(result^0xffffffff)>>>0;};
  const chunk=(kind,bytes)=>{const data=Buffer.concat([Buffer.from(kind),bytes]),length=Buffer.alloc(4),check=Buffer.alloc(4);length.writeUInt32BE(bytes.length);check.writeUInt32BE(crc(data));return Buffer.concat([length,data,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,red,100,80]))),chunk('IEND',Buffer.alloc(0))]);
}
const pixel=png(),source=(name,color=255)=>({name,source:'data:image/png;base64,'+png(color).toString('base64'),width:1,height:1});
function fixture({references=false,referenceOnly=false}={}) {
  let project=newProject();
  if(!referenceOnly)project=addRaster(project,source('Original subject.png')).project;
  if(references||referenceOnly)project=addReference(project,source('Chosen reference.png',120));
  project=withSheetPreset(project,{active:true,views:7,subject:'item',referenceIds:references?project.references.map(ref=>ref.id):[],...(referenceOnly?{sourceId:project.references[0].id}:{})});
  return {requestId:randomUUID(),project,model:'gpt-image-2.5-sunburst'};
}
async function setup(t,options={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'asun-desktop-sheets-')),calls=[];
  const fetchImpl=async(url,init={})=>{calls.push({url,init});if(url.endsWith('/models'))return options.modelsReply?options.modelsReply():json({data:SHEET_MODELS.map(model=>({id:model.id}))});return options.reply?options.reply(url,init):json({data:[{b64_json:pixel.toString('base64')}]});};
  const service=createDesktopSheetService({directory,fetchImpl,getKey:()=>key,...options});
  t.after(async()=>{service.dispose();await rm(directory,{recursive:true,force:true});});
  return{directory,calls,fetchImpl,service};
}
async function finished(service,id){for(let i=0;i<200;i++){const job=await service.job(id);if(!['queued','running'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Fixture generation did not finish.');}
const posts=calls=>calls.filter(call=>call.init.method==='POST');

test('sheet access status is read-only, cached and never returns credentials',async t=>{
  const{service,calls}=await setup(t),result=await service.status();assert.equal(result.authenticated,true);assert.equal(result.configured,true);assert.equal(result.models.filter(m=>m.available).length,SHEET_MODELS.filter(m=>!m.retired).length);assert.match(result.token,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(result).includes(key),false);await service.status();assert.equal(calls.length,1);assert.equal(posts(calls).length,0);
});
test('missing key and denied access are explicit and redact provider errors',async t=>{
  const missing=await setup(t,{getKey:()=>''}),empty=await missing.service.status();assert.equal(empty.configured,false);assert.equal(missing.calls.length,0);
  const denied=await setup(t,{modelsReply:()=>json({error:{message:'Bad credential '+key}},401)}),status=await denied.service.status();assert.equal(status.authenticated,false);assert.equal(status.message.includes(key),false);await assert.rejects(denied.service.start(fixture()),/Bad credential/);assert.equal(posts(denied.calls).length,0);
});
test('sheet generation uploads exact selected originals once and returns the actual PNG',async t=>{
  const{service,calls,directory}=await setup(t),request=fixture({references:true}),before=JSON.stringify(request.project);
  const accepted=await service.start(request);assert.equal(accepted.status,'queued');const result=await finished(service,request.requestId);assert.equal(result.status,'completed',result.message);assert.equal(result.image.source,'data:image/png;base64,'+pixel.toString('base64'));assert.equal(result.image.width,1);assert.match(result.image.name,/7-view/);
  const post=posts(calls)[0];assert.equal(posts(calls).length,1);assert.equal(post.url,'https://api.openai.com/v1/images/edits');const form=post.init.body;assert.equal(form.get('model'),request.model);assert.equal(form.get('quality'),'high');assert.equal(form.get('size'),'1536x1024');assert.equal(form.get('output_format'),'png');assert.equal(form.get('background'),'opaque');assert.equal(form.get('n'),'1');assert.equal(form.has('input_fidelity'),false);assert.equal(form.getAll('image[]').length,2);assert.equal(Buffer.from(await form.getAll('image[]')[0].arrayBuffer()).toString('base64'),pixel.toString('base64'));assert.equal(Buffer.from(await form.getAll('image[]')[1].arrayBuffer()).toString('base64'),png(120).toString('base64'));assert.match(form.get('prompt'),/exactly 7 distinct/);assert.match(form.get('prompt'),/WHITE/);assert.equal(JSON.stringify(request.project),before);assert.equal((await readFile(path.join(directory,request.requestId+'.json'),'utf8')).includes(key),false);
});
test('reference-only primary subject works and does not duplicate itself among extra references',()=>{
  const request=fixture({referenceOnly:true});request.project.sheetPreset.referenceIds=[request.project.references[0].id];const prepared=prepareSheetRequest(request);assert.equal(prepared.images.length,1);assert.equal(prepared.sourceName,'Chosen reference.png');assert.deepEqual(prepared.images[0].bytes,png(120));
});
test('repeated simultaneous and completed request IDs make only one paid POST, including after restart',async t=>{
  const{service,calls,directory,fetchImpl}=await setup(t),request=fixture();await Promise.all([service.start(request),service.start(request)]);await finished(service,request.requestId);await service.start(request);assert.equal(posts(calls).length,1);
  const recovered=createDesktopSheetService({directory,fetchImpl,getKey:()=>key});t.after(()=>recovered.dispose());assert.equal((await recovered.job(request.requestId)).status,'completed');assert.equal((await recovered.start(request)).status,'completed');assert.equal(posts(calls).length,1);
  const changed=structuredClone(request);changed.project.sheetPreset.notes='A different blue finish';await assert.rejects(recovered.start(changed),/different sheet settings/);assert.equal(posts(calls).length,1);
});
test('invalid IDs, models, projects, and missing overflow boards fail before paid submission',async t=>{
  const{service,calls}=await setup(t);await assert.rejects(service.start({...fixture(),requestId:'../../secret'}),/request ID/);await assert.rejects(service.start({...fixture(),model:'invented-model'}),/supported image model/);await assert.rejects(service.start({...fixture(),project:{}}),/supported Asun IMG project/);
  const request=fixture();for(let i=0;i<16;i++)request.project=addReference(request.project,source('Extra '+i,10+i));request.project.sheetPreset.referenceIds=request.project.references.map(ref=>ref.id);await assert.rejects(service.start(request),/Reference boards are missing/);assert.equal(posts(calls).length,0);
});
test('unavailable models do not submit, and a second sheet queues behind the first request',async t=>{
  const unavailable=await setup(t,{modelsReply:()=>json({data:[]})});await assert.rejects(unavailable.service.start(fixture()),/unavailable/);assert.equal(posts(unavailable.calls).length,0);
  let release;const gate=new Promise(resolve=>{release=resolve;});const active=await setup(t,{reply:async()=>{await gate;return json({data:[{b64_json:pixel.toString('base64')}]});}}),first=fixture(),second=fixture();await active.service.start(first);assert.equal((await active.service.start(second)).status,'queued');release();await finished(active.service,first.requestId);await finished(active.service,second.requestId);assert.equal(posts(active.calls).length,2);
});
test('provider failure redacts secrets and never auto-retries a failed paid request',async t=>{
  const{service,calls}=await setup(t,{reply:()=>json({error:{message:'Quota exceeded '+key}},429)}),request=fixture();await service.start(request);const result=await finished(service,request.requestId);assert.equal(result.status,'failed');assert.match(result.message,/No automatic retry/);assert.equal(result.message.includes(key),false);await service.start(request);assert.equal(posts(calls).length,1);
});
test('invalid provider result does not become a completed image',async t=>{
  const{service,directory}=await setup(t,{reply:()=>json({data:[{b64_json:Buffer.from('not an image, just ordinary text').toString('base64')}]})}),request=fixture();await service.start(request);const result=await finished(service,request.requestId);assert.equal(result.status,'failed');assert.equal(result.image,undefined);assert.equal((await readdir(directory)).includes(request.requestId+'.png'),false);assert.throws(()=>inspectSheetImage(pixel.subarray(0,-5)),/Incomplete|Truncated/);
});
test('a timed-out request is reported honestly and never retried',async t=>{
  const{service,calls}=await setup(t,{timeoutMs:20,reply:(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('Timed out')),{once:true}))}),request=fixture();await service.start(request);const result=await finished(service,request.requestId);assert.equal(result.status,'failed');assert.match(result.message,/may still finish and charge/);await service.start(request);assert.equal(posts(calls).length,1);
});
test('two server instances sharing a job folder cannot double-submit the same request',async t=>{
  const{service,directory,fetchImpl,calls}=await setup(t);const other=createDesktopSheetService({directory,fetchImpl,getKey:()=>key});t.after(()=>other.dispose());const request=fixture();await Promise.all([service.start(request),other.start(request)]);const result=await finished(service,request.requestId);assert.equal(result.status,'completed');assert.equal(posts(calls).length,1);
});
test('interrupted persisted jobs fail honestly without resubmission',async t=>{
  const{service,directory,calls}=await setup(t),request=fixture(),prepared=prepareSheetRequest(request);await writeFile(path.join(directory,request.requestId+'.json'),JSON.stringify({id:request.requestId,status:'running',fingerprint:prepared.fingerprint,sourceName:prepared.sourceName,views:7,model:prepared.model}));const result=await service.job(request.requestId);assert.equal(result.status,'failed');assert.match(result.message,/restarted/);await service.start(request);assert.equal(posts(calls).length,0);
});
test('full history refuses new billing and keeps all earlier outputs and inputs',async t=>{
  const{service,directory,calls}=await setup(t,{maxStoredResults:2}),requests=[fixture(),fixture(),fixture()];for(const request of requests.slice(0,2)){await service.start(request);await finished(service,request.requestId);}
  await assert.rejects(service.start(requests[2]),error=>error.statusCode===507&&/Existing images have been kept/.test(error.message));
  const files=await readdir(directory);assert.equal(files.filter(name=>/^[0-9a-f-]{36}\.png$/.test(name)).length,2);const old=await service.job(requests[0].requestId);assert.equal(old.status,'completed');assert.equal(old.availableInputs.length,1);await service.start(requests[0]);assert.equal(posts(calls).length,2);
});
test('JSON request body limits cover declared and streamed sizes',async()=>{
  const make=(chunks,extra={})=>({headers:{'content-type':'application/json',...extra},async *[Symbol.asyncIterator](){for(const chunk of chunks)yield Buffer.from(chunk);}});
  await assert.rejects(readSheetBody(make([],{'content-length':String(SHEET_REQUEST_BYTES+1)})),/too large/);
  await assert.rejects(readSheetBody(make(['12345','67890']),8),/too large/);
  await assert.rejects(readSheetBody(make(['{bad}'])),/Invalid sheet request/);
  assert.deepEqual(await readSheetBody(make(['{"ok":','true}'])),{ok:true});
});
test('HTTP sheet routes require local origin and a private token, with safe polling and body limits',async t=>{
  const{service,calls}=await setup(t),server=createServer({sheets:service,detection:{token:'detector-test',status:async()=>({available:false}),dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port,status=await(await fetch(base+'/api/sheets/status')).json(),headers={'Content-Type':'application/json','X-Asun-Sheet-Token':status.token},request=fixture();
  assert.equal((await fetch(base+'/api/sheets/status',{headers:{Origin:'https://foreign.invalid'}})).status,403);assert.equal((await fetch(base+'/api/sheets/status',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);assert.equal((await fetch(base+'/api/sheets/status',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/sheets/generate',{method:'POST',headers,body:JSON.stringify(request)})).status,403);assert.equal((await fetch(base+'/api/sheets/generate',{method:'POST',headers:{...headers,Origin:'https://foreign.invalid'},body:JSON.stringify(request)})).status,403);assert.equal((await fetch(base+'/api/sheets/generate',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(request)})).status,403);
  assert.equal((await fetch(base+'/api/sheets/generate',{method:'POST',headers:{...headers,Origin:base,'Content-Type':'text/plain'},body:'hello'})).status,415);assert.equal((await fetch(base+'/api/sheets/generate',{method:'POST',headers:{...headers,Origin:base},body:'{invalid'})).status,400);
  assert.equal((await fetch(base+'/api/sheets/jobs/'+request.requestId)).status,403);assert.equal((await fetch(base+'/api/sheets/jobs/not-a-uuid',{headers})).status,400);assert.equal((await fetch(base+'/api/sheets/jobs/'+request.requestId,{headers})).status,404);
  const accepted=await fetch(base+'/api/sheets/generate',{method:'POST',headers:{...headers,Origin:base},body:JSON.stringify(request)});assert.equal(accepted.status,202);await finished(service,request.requestId);const result=await(await fetch(base+'/api/sheets/jobs/'+request.requestId,{headers})).json();assert.equal(result.status,'completed');assert.ok(result.image.source);assert.equal(posts(calls).length,1);assert.equal((await fetch(base+'/data/sheet-jobs/'+request.requestId+'.png')).status,404);assert.equal((await fetch(base+'/desktop-sheet-service.mjs')).status,404);
});
