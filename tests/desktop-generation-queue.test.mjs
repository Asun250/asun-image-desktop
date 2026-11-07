import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {createGenerationQueue} from '../desktop-generation-queue.mjs';
import {createDesktopSheetService,SHEET_MODELS} from '../desktop-sheet-service.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {createServer} from '../server.mjs';
import {newProject,addRaster} from '../public/core.mjs';
import {withSheetPreset} from '../public/sheet-preset.mjs';
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=';
const image={name:'Original.png',source:'data:image/png;base64,'+pixel,width:1,height:1};
const key='sk-queue-test-not-a-real-key';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function request(kind,marker='FIRST'){
  let project=addRaster(newProject(),image).project;project.name=marker;project.prompt=marker;
  if(kind==='sheet')project=withSheetPreset(project,{active:true,views:7,subject:'item',referenceIds:[],notes:marker});
  return {requestId:randomUUID(),project,model:'gpt-image-2.5-sunburst',quality:'max',...(kind==='image'?{composition:image,guide:null,referencePreviews:[],areaMasks:[]}:{})};
}
async function waitFor(check,message='Queue fixture did not reach the expected state'){
  for(let i=0;i<400;i++){const value=await check();if(value)return value;await pause(10);}throw new Error(message);
}
const finished=(service,id)=>waitFor(async()=>{const job=await service.job(id);return !['queued','running'].includes(job.status)?job:null;});
async function setup(t,{paused=false,reply=null,maxStoredBytes,...options}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'asun-generation-queue-')),instances=[],calls=[];let active=0,maxActive=0;
  const fetchImpl=async(url,init={})=>{
    if(url.endsWith('/models'))return json({data:SHEET_MODELS.map(model=>({id:model.id}))});
    const prompt=typeof init.body==='string'?JSON.parse(init.body).prompt:init.body.get('prompt');calls.push({url,init,prompt});active++;maxActive=Math.max(maxActive,active);
    try{return reply?await reply(url,init,prompt,calls.length):json({data:[{b64_json:pixel}]});}finally{active--;}
  };
  function instantiate(isPaused=paused){
    const queue=createGenerationQueue({directory:path.join(root,'queue'),pollMs:10}),adapter=isPaused?{...queue,wake(){}}:queue;
    const common={queue:adapter,getKey:()=>key,fetchImpl,...(maxStoredBytes?{maxStoredBytes}:{}),...options};
    const images=createDesktopSheetService({...common,label:'image',prepareRequest:prepareImageRequest,directory:path.join(root,'images')});
    const sheets=createDesktopSheetService({...common,directory:path.join(root,'sheets')});
    const instance={queue,images,sheets,dispose(){queue.dispose();images.dispose();sheets.dispose();}};instances.push(instance);return instance;
  }
  const first=instantiate();
  t.after(async()=>{for(const item of instances)item.dispose();await pause(50);await rm(root,{recursive:true,force:true});});
  return {...first,root,calls,instantiate,maxActive:()=>maxActive};
}

test('images and sheets share FIFO, snapshots and one provider request at a time',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const state=await setup(t,{reply:async(_url,_init,_prompt,index)=>{if(index===1)await gate;return json({data:[{b64_json:pixel}]});}});
  const first=request('image','FIRST_IMAGE'),second=request('sheet','SECOND_SHEET'),third=request('image','THIRD_IMAGE');
  const accepted=await state.images.start(first);assert.equal(accepted.status,'queued');assert.equal(accepted.sourceProjectAvailable,true);
  await waitFor(()=>state.calls.length===1);await state.sheets.start(second);await state.images.start(third);
  first.project.prompt='Later edits';third.project.prompt='Another project after submitting';
  const queue=await state.queue.status();assert.deepEqual(queue.items.slice(0,3).map(item=>[item.id,item.status,item.queuePosition]),[[first.requestId,'running',null],[second.requestId,'queued',1],[third.requestId,'queued',2]]);
  assert.equal(queue.concurrency,1);assert.equal(queue.counts.running,1);assert.equal(queue.counts.queued,2);assert.equal(JSON.stringify(queue).includes(pixel),false,'Queue summaries contain no image payloads');
  release();await finished(state.images,third.requestId);assert.equal((await finished(state.sheets,second.requestId)).status,'completed');
  assert.equal(state.maxActive(),1);assert.equal(state.calls.length,3);assert.match(state.calls[0].prompt,/FIRST_IMAGE/);assert.match(state.calls[1].prompt,/SECOND_SHEET/);assert.match(state.calls[2].prompt,/THIRD_IMAGE/);
  assert.equal((await state.images.project(third.requestId)).project.prompt,'THIRD_IMAGE');
});

test('cancel only affects queued jobs, releases queue position, and never submits their provider request',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const state=await setup(t,{reply:async(_url,_init,_prompt,index)=>{if(index===1)await gate;return json({data:[{b64_json:pixel}]});}});
  const first=request('image','FIRST'),cancelled=request('sheet','CANCEL_ME'),last=request('image','LAST');
  await state.images.start(first);await waitFor(()=>state.calls.length===1);await state.sheets.start(cancelled);await state.images.start(last);
  await assert.rejects(state.images.cancel(first.requestId),error=>error.statusCode===409);
  const result=await state.sheets.cancel(cancelled.requestId);assert.equal(result.status,'cancelled');assert.equal(result.cancellable,false);assert.equal(result.sourceProjectAvailable,true);assert.match(result.message,/No provider request/);
  assert.equal((await state.sheets.cancel(cancelled.requestId)).status,'cancelled','Cancel is idempotent');assert.equal((await state.images.job(last.requestId)).queuePosition,1);
  release();await finished(state.images,last.requestId);assert.equal(state.calls.length,2);assert.equal(state.calls.some(call=>call.prompt.includes('CANCEL_ME')),false);
  assert.equal((await state.sheets.start(cancelled)).status,'cancelled','Same request ID does not reinstate a cancelled job');
});

test('persisted queued jobs resume after restart using exact stored settings, inputs and source projects',async t=>{
  const state=await setup(t,{paused:true}),first=request('sheet','SAVED_SHEET'),second=request('image','SAVED_IMAGE');
  await state.sheets.start(first);await state.images.start(second);assert.equal(state.calls.length,0);
  const saved=await state.images.project(second.requestId);state.dispose();const restarted=state.instantiate(false);restarted.queue.resume();
  assert.equal((await finished(restarted.images,second.requestId)).status,'completed');assert.equal((await finished(restarted.sheets,first.requestId)).status,'completed');
  assert.equal(state.calls.length,2);assert.match(state.calls[0].prompt,/SAVED_SHEET/);assert.match(state.calls[1].prompt,/SAVED_IMAGE/);
  assert.equal(state.calls[1].init.body.get('quality'),'max');assert.equal(Buffer.from(await state.calls[1].init.body.getAll('image[]')[0].arrayBuffer()).toString('base64'),pixel);assert.deepEqual(await restarted.images.project(second.requestId),saved);
  await restarted.images.start(second);assert.equal(state.calls.length,2,'Repeated ID never submits twice after recovery');
});

test('running and already-marked queued requests never auto-resubmit after interrupted dispatch',async t=>{
  const state=await setup(t,{paused:true}),running=request('image','UNCERTAIN_RUNNING'),marked=request('sheet','UNCERTAIN_MARKER'),safe=request('image','SAFE_QUEUED');
  await state.images.start(running);await state.sheets.start(marked);await state.images.start(safe);
  const file=path.join(state.root,'images',running.requestId+'.json'),record=JSON.parse(await readFile(file,'utf8'));await writeFile(file,JSON.stringify({...record,status:'running',ownerPid:2147483647}));
  await writeFile(path.join(state.root,'sheets',marked.requestId+'.submitted'),JSON.stringify({ownerPid:2147483647,fingerprint:'fixture'}));
  assert.equal((await state.sheets.job(marked.requestId)).cancellable,false);await assert.rejects(state.sheets.cancel(marked.requestId),error=>error.statusCode===409&&/uncertain/.test(error.message));
  state.dispose();const restarted=state.instantiate(false);restarted.queue.resume();
  assert.equal((await finished(restarted.images,safe.requestId)).status,'completed');const old=await restarted.images.job(running.requestId),claimed=await restarted.sheets.job(marked.requestId);
  assert.equal(old.status,'failed');assert.match(old.message,/may have billed/);assert.equal(claimed.status,'failed');assert.match(claimed.message,/uncertain/);assert.equal(state.calls.length,1);assert.match(state.calls[0].prompt,/SAFE_QUEUED/);
});

test('two scheduler instances sharing directories cannot overlap or duplicate paid submissions',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const state=await setup(t,{paused:true,reply:async(_url,_init,_prompt,index)=>{if(index===1)await gate;await pause(20);return json({data:[{b64_json:pixel}]});}});
  const first=request('image','ONE'),second=request('sheet','TWO'),third=request('image','THREE');await state.images.start(first);await state.sheets.start(second);await state.images.start(third);
  const other=state.instantiate(false);state.queue.resume();other.queue.resume();await waitFor(()=>state.calls.length===1);
  for(const queue of [state.queue,other.queue]){const status=await queue.status();assert.equal(status.counts.running,1);assert.equal(status.counts.queued,2);assert.deepEqual(status.items.slice(0,3).map(item=>item.id),[first.requestId,second.requestId,third.requestId]);}
  await Promise.all([other.images.start(first),state.images.start(first)]);assert.equal(state.calls.length,1);release();await finished(other.images,third.requestId);await finished(other.sheets,second.requestId);
  assert.equal(state.maxActive(),1);assert.equal(state.calls.length,3);assert.match(state.calls[0].prompt,/ONE/);assert.match(state.calls[1].prompt,/TWO/);assert.match(state.calls[2].prompt,/THREE/);
});

test('startup retires a dead scheduler lock without losing the queued request',async t=>{
  const state=await setup(t,{paused:true}),job=request('image','AFTER_DEAD_LOCK');await state.images.start(job);state.dispose();
  await writeFile(path.join(state.root,'queue','scheduler.lock'),JSON.stringify({pid:2147483647,nonce:'dead-owner'}));
  const restarted=state.instantiate(false);restarted.queue.resume();assert.equal((await finished(restarted.images,job.requestId)).status,'completed');assert.equal(state.calls.length,1);assert.equal((await restarted.queue.status()).message,'');
});

test('partial job records block dispatch safely and recover without retrying a paid request',async t=>{
  const state=await setup(t,{paused:true}),job=request('image','INTACT_JOB');await state.images.start(job);
  const file=path.join(state.root,'images',job.requestId+'.json'),saved=await readFile(file,'utf8');await writeFile(file,'{"status":"running",');state.queue.resume();await pause(60);
  assert.equal(state.calls.length,0);await assert.rejects(state.queue.status());await writeFile(file,saved);
  assert.equal((await finished(state.images,job.requestId)).status,'completed');assert.equal(state.calls.length,1);assert.equal((await state.queue.status()).message,'');
});

test('unreadable locks block safely and a successful empty scan clears the recovery message',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'asun-queue-lock-')),queue=createGenerationQueue({directory:root,pollMs:10,lockWaitMs:30});let dispatches=0,items=[{id:randomUUID(),status:'queued',queueSequence:1}];
  t.after(async()=>{queue.dispose();await pause(80);await rm(root,{recursive:true,force:true});});
  queue.register('image',{scan:async()=>items,dispatch:async()=>{dispatches++;return {completion:Promise.resolve()};},summarize:async value=>value});
  await writeFile(path.join(root,'scheduler.lock'),'{"pid":');queue.resume();await waitFor(async()=>/could not be read/.test((await queue.status()).message));assert.equal(dispatches,0);
  items=[];await rm(path.join(root,'scheduler.lock'));await waitFor(async()=>!(await queue.status()).message);assert.equal(dispatches,0);
});

test('separate worker processes share the durable FIFO and never overlap provider submissions',async t=>{
  const state=await setup(t,{paused:true});const jobs=[request('image','PROCESS_ONE'),request('sheet','PROCESS_TWO'),request('image','PROCESS_THREE')];
  for(let index=0;index<jobs.length;index++)await (index===1?state.sheets:state.images).start(jobs[index]);state.dispose();
  const children=[];let ready=0;t.after(()=>{for(const child of children)child.kill();});
  const workers=[0,1].map(()=>new Promise((resolve,reject)=>{
    const child=fork(new URL('./fixtures/generation-queue-worker.mjs',import.meta.url),[state.root],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);let stderr='';child.stderr.on('data',value=>{stderr+=value;});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Queue worker failed: '+stderr)));child.on('message',message=>{if(message==='ready'&&++ready===2)for(const worker of children)worker.send('start');});
  }));
  await Promise.all(workers);
  const log=(await readFile(path.join(state.root,'provider-log.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(log.map(entry=>entry.prompt.match(/PROCESS_(?:ONE|TWO|THREE)/)?.[0]),['PROCESS_ONE','PROCESS_TWO','PROCESS_THREE']);
  for(const job of jobs)assert.equal(JSON.parse(await readFile(path.join(state.root,job===jobs[1]?'sheets':'images',job.requestId+'.json'),'utf8')).status,'completed');
});

test('queued storage reserves room for each future output and keeps existing jobs intact',async t=>{
  const state=await setup(t,{paused:true,maxStoredBytes:75*1024*1024}),first=request('image','KEPT'),second=request('image','REFUSED');await state.images.start(first);
  await assert.rejects(state.images.start(second),error=>error.statusCode===507&&/storage limit/.test(error.message));assert.equal((await state.images.job(first.requestId)).status,'queued');assert.equal(state.calls.length,0);
});

test('corrupt queued settings fail before billing and allow the next valid job to run',async t=>{
  const state=await setup(t,{paused:true}),bad=request('image','BAD'),good=request('sheet','GOOD');await state.images.start(bad);await state.sheets.start(good);
  const file=path.join(state.root,'images',bad.requestId+'.json'),record=JSON.parse(await readFile(file,'utf8'));record.settings.options.prompt='Unexpected settings';await writeFile(file,JSON.stringify(record));state.queue.resume();
  assert.equal((await finished(state.sheets,good.requestId)).status,'completed');const failure=await state.images.job(bad.requestId);assert.equal(failure.status,'failed');assert.match(failure.message,/integrity check/);assert.equal(state.calls.length,1);assert.match(state.calls[0].prompt,/GOOD/);
});

test('queue and cancel HTTP routes enforce local authorization and return compact states',async t=>{
  const state=await setup(t,{paused:true});const server=createServer({generationQueue:state.queue,images:state.images,sheets:state.sheets,detection:{status:async()=>({available:false}),dispose(){}},imageSearch:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port,job=request('image','HTTP');await state.images.start(job);const headers={'X-Asun-Image-Token':state.images.token};
  assert.equal((await fetch(base+'/api/generation-queue/status')).status,403);assert.equal((await fetch(base+'/api/generation-queue/status',{headers:{...headers,Origin:'https://foreign.invalid'}})).status,403);assert.equal((await fetch(base+'/api/generation-queue/status',{method:'POST',headers})).status,405);
  const response=await fetch(base+'/api/generation-queue/status',{headers}),queue=await response.json();assert.equal(response.status,200);assert.equal(queue.items[0].status,'queued');assert.equal(queue.items[0].cancellable,true);assert.equal(queue.items[0].kind,'image');assert.equal(JSON.stringify(queue).includes(pixel),false);assert.equal(JSON.stringify(queue).includes(key),false);
  const cancel=base+'/api/images/jobs/'+job.requestId+'/cancel';assert.equal((await fetch(cancel,{headers})).status,405);assert.equal((await fetch(cancel,{method:'POST',headers})).status,403);assert.equal((await fetch(cancel,{method:'POST',headers:{Origin:base,'X-Asun-Sheet-Token':state.sheets.token}})).status,403);
  const cancelled=await fetch(cancel,{method:'POST',headers:{...headers,Origin:base}});assert.equal(cancelled.status,200);assert.equal((await cancelled.json()).status,'cancelled');assert.equal(state.calls.length,0);
});
