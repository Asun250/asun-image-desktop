import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDesktopGeneration,createDesktopSheetGeneration} from '../public/desktop-sheet-generation.mjs';

const variants=[
  {kind:'sheet',endpoint:'/api/sheets',tokenHeader:'x-asun-sheet-token',storageKey:'asun.desktop.sheet.last-job.v1',create:createDesktopSheetGeneration},
  {kind:'image',endpoint:'/api/images',tokenHeader:'x-asun-image-token',storageKey:'asun.desktop.image.last-job.v1',create:createDesktopGeneration},
];
const model='gpt-image-2.5-sunburst',token='fixture-local-token';
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const completed=id=>({id,status:'completed',model,image:{source:'data:image/png;base64,fixture',name:'Finished.png',width:1,height:1}});
function storage(t,{broken=false}={}) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),values=new Map();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    getItem(key){if(broken)throw new Error('Storage disabled');return values.get(key)??null;},
    setItem(key,value){if(broken)throw new Error('Storage disabled');values.set(key,String(value));},
    removeItem(key){if(broken)throw new Error('Storage disabled');values.delete(key);},
  }});
  t.after(()=>previous?Object.defineProperty(globalThis,'localStorage',previous):delete globalThis.localStorage);return values;
}
function setup(t,options,{onJob,onPost,prepareInput,queue,autoPoll=false,authenticated=()=>true}={}) {
  const calls=[],snapshots=[],jobs=new Map(),project={prompt:'A finished image',layers:[{id:'source',mask:[]}],references:[{id:'ref',source:'unchanged-original'}]};
  const fetchImpl=async(url,init={})=>{
    calls.push({url,init});
    if(url===options.endpoint+'/status')return response({authenticated:authenticated(),configured:authenticated(),token,models:authenticated()?[{id:model,available:true},{id:'gpt-image-1.5',available:true}]:[],message:'Fixture provider'});
    if(url==='/api/generation-queue/status'){assert.equal(init.headers[options.tokenHeader],token);return queue?response({items:queue()}):response({error:'Legacy server'},404);}
    if(url===options.endpoint+'/generate') {
      assert.equal(init.method,'POST');assert.equal(init.headers[options.tokenHeader],token);const input=JSON.parse(init.body);
      jobs.set(input.requestId,{id:input.requestId,kind:options.kind,status:'queued',model:input.model,settings:{model:input.model,quality:input.quality}});
      return onPost?onPost(input,jobs):response(jobs.get(input.requestId),202);
    }
    if(url.startsWith(options.endpoint+'/jobs/')) {
      assert.equal(init.headers[options.tokenHeader],token);assert.notEqual(init.method,'POST');const id=decodeURIComponent(url.split('/').at(-1));
      return onJob?onJob(id,jobs):jobs.has(id)?response(jobs.get(id)):response({error:'Not found'},404);
    }
    throw new Error('Unexpected fixture URL: '+url);
  };
  const editor={snapshot(){snapshots.push(true);return project;},editGeneratedImage:async image=>({edited:image})};
  const bridge=options.create({...options,editor,fetchImpl,pollMs:10,autoPoll,...(prepareInput?{prepareInput}:{})});t.after(()=>bridge.dispose());
  return {bridge,calls,snapshots,jobs,project,posts:()=>calls.filter(call=>call.init.method==='POST'),jobIds:()=>calls.filter(call=>call.url.startsWith(options.endpoint+'/jobs/')).map(call=>call.url.split('/').at(-1))};
}

for(const options of variants) {
  test(`${options.kind}: enqueue returns before completion and next model, quality and project can change independently`,async t=>{
    storage(t);const f=setup(t,options);await f.bridge.prepare();
    f.bridge.selectQuality('xhigh');const first=await f.bridge.generate();assert.equal(first.status,'queued');assert.equal(f.bridge.state().working,false);assert.equal(f.bridge.state().pending,false);assert.equal(f.bridge.state().backgroundPending,true);assert.equal(f.jobIds().length,0);
    f.project.prompt='Second project';f.project.references[0].source='second-original';f.bridge.selectModel('gpt-image-1.5');f.bridge.selectQuality('low');
    const second=await f.bridge.generate();assert.notEqual(second.id,first.id);assert.equal(f.bridge.state().activeCount,2);
    const [one,two]=f.posts().map(call=>JSON.parse(call.init.body));assert.equal(one.model,model);assert.equal(one.quality,'xhigh');assert.equal(one.project.prompt,'A finished image');assert.equal(one.project.references[0].source,'unchanged-original');assert.equal(two.model,'gpt-image-1.5');assert.equal(two.quality,'low');assert.equal(two.project.prompt,'Second project');
    assert.equal((await f.bridge.editOutput(completed(first.id))).edited.name,'Finished.png','Background work does not block result editing.');
  });
  test(`${options.kind}: source and settings are frozen before asynchronous input preparation`,async t=>{
    storage(t);let release;const gate=new Promise(resolve=>{release=resolve;});const f=setup(t,options,{prepareInput:async project=>{await gate;return {project};}});await f.bridge.prepare();
    const pending=f.bridge.generate();assert.equal(f.bridge.state().working,true);f.project.prompt='Edited while preparing';f.project.layers[0].mask.push('new stroke');f.bridge.selectQuality('low');
    await assert.rejects(f.bridge.generate(),/prepared|uploaded/);release();await pending;
    const sent=JSON.parse(f.posts()[0].init.body);assert.equal(sent.project.prompt,'A finished image');assert.deepEqual(sent.project.layers[0].mask,[]);assert.equal(sent.quality,'high');assert.equal(f.bridge.state().working,false);
  });
  test(`${options.kind}: a failed poll never posts again and completion does not modify the current project`,async t=>{
    storage(t,{broken:true});let fail=true;const f=setup(t,options,{onJob:id=>{if(fail)throw new TypeError('Network disconnected');return response(completed(id));}});await f.bridge.prepare();const accepted=await f.bridge.generate();
    f.project.prompt='Continue editing';await assert.rejects(f.bridge.refreshJob(accepted.id),/Network disconnected/);assert.equal(f.bridge.state().activeCount,1);
    fail=false;const events=[];f.bridge.subscribe(event=>events.push(event));const result=await f.bridge.fetchResult(accepted.id);assert.equal(result.status,'completed');assert.equal(f.posts().length,1);assert.equal(f.snapshots.length,1);assert.equal(f.project.prompt,'Continue editing');assert.equal(f.bridge.state().result.id,accepted.id);assert.equal(f.bridge.state().jobs[0].image,undefined);assert.equal(events.filter(event=>event.type==='completed').length,1);
  });
  test(`${options.kind}: a lost POST response recovers the exact accepted ID without posting twice`,async t=>{
    storage(t,{broken:true});const f=setup(t,options,{onPost:()=>{throw new TypeError('POST response disconnected');}});await f.bridge.prepare();const accepted=await f.bridge.generate();assert.equal(accepted.recovered,true);assert.equal(accepted.status,'queued');assert.equal(f.posts().length,1);assert.deepEqual(f.jobIds(),[accepted.id]);assert.equal(f.bridge.state().uncertainRequestId,null);
  });
  test(`${options.kind}: uncertain uploads survive reload and do not become a new paid request`,async t=>{
    const values=storage(t);let available=false;const f=setup(t,options,{onPost:()=>{throw new TypeError('Disconnected');},onJob:id=>available?response({id,status:'running'}):response({error:'Not visible yet'},404)});await f.bridge.prepare();
    let id;await assert.rejects(f.bridge.generate(),error=>{id=error.requestId;return error.submissionUncertain;});assert.equal(f.bridge.state().working,false);assert.equal(f.bridge.state().uncertainRequestId,id);f.bridge.selectQuality('low');
    await assert.rejects(f.bridge.generate(),/no new request/);assert.equal(f.posts().length,1);assert.equal(JSON.parse(values.get(options.storageKey+'.jobs'))[0].uncertain,true);
    const reloaded=setup(t,options,{onPost:()=>{throw new Error('No replacement POST allowed');},onJob:savedId=>{assert.equal(savedId,id);return available?response({id,status:'running'}):response({error:'Pending'},404);}});await reloaded.bridge.prepare();assert.equal(reloaded.bridge.state().uncertainRequestId,id);available=true;
    assert.equal((await reloaded.bridge.generate()).id,id);assert.equal(reloaded.posts().length,0);assert.equal(reloaded.snapshots.length,0);assert.equal(reloaded.bridge.state().uncertainRequestId,null);
  });
  test(`${options.kind}: another tab overwriting the old last-job key cannot replace tracked request IDs`,async t=>{
    const values=storage(t),foreign=randomUUID();const f=setup(t,options);await f.bridge.prepare();const first=await f.bridge.generate();const second=await f.bridge.generate();values.set(options.storageKey,foreign);await f.bridge.prepare();assert.deepEqual(new Set(f.jobIds()),new Set([first.id,second.id]));assert.equal(f.posts().length,2);assert.equal(f.bridge.state().activeCount,2);
  });
  test(`${options.kind}: reload discovers all server jobs even without browser storage and fetches no queued image`,async t=>{
    storage(t,{broken:true});const ids=[randomUUID(),randomUUID()],other=randomUUID();let items=[...ids.map(id=>({id,kind:options.kind,status:'queued'})),{id:other,kind:options.kind==='image'?'sheet':'image',status:'running'}];
    const f=setup(t,options,{queue:()=>items,onJob:id=>response(completed(id))});await f.bridge.prepare();assert.equal(f.bridge.state().activeCount,2);assert.equal(f.jobIds().length,0);assert.equal(f.snapshots.length,0);assert.equal(f.posts().length,0);
    const events=[];f.bridge.subscribe(event=>events.push(event));items=items.map(item=>item.id===ids[0]?{...item,status:'completed'}:item);await f.bridge.refreshJobs();assert.equal(f.bridge.state().activeCount,1);assert.equal(f.bridge.state().result.id,ids[0]);assert.deepEqual(f.jobIds(),[ids[0]]);assert.equal(events.filter(event=>event.type==='completed').length,1);assert.equal(f.bridge.state().jobs.some(item=>item.id===other),false);
  });
  test(`${options.kind}: expired jobs clear recovery and validation failures never submit`,async t=>{
    const values=storage(t),id=randomUUID();values.set(options.storageKey,id);const f=setup(t,options,{prepareInput:async()=>{throw new Error('Choose a subject');},onJob:()=>response({id,status:'expired',message:'Earlier output removed'})});await f.bridge.prepare();assert.equal(f.bridge.state().activeCount,0);assert.equal(values.has(options.storageKey),false);
    await assert.rejects(f.bridge.generate(),/Choose a subject/);assert.equal(f.bridge.state().working,false);assert.equal(f.posts().length,0);assert.equal(f.bridge.state().result,null);
  });
  test(`${options.kind}: explicit provider rejection reports the error and permits a corrected next job`,async t=>{
    storage(t);let rejected=true;const f=setup(t,options,{onPost:(input,jobs)=>rejected?response({error:'Quality unsupported by this provider'},400):response(jobs.get(input.requestId),202)});await f.bridge.prepare();await assert.rejects(f.bridge.generate(),/Quality unsupported/);assert.equal(f.bridge.state().uncertainRequestId,null);assert.equal(f.bridge.state().activeCount,0);rejected=false;f.bridge.selectQuality('low');assert.equal((await f.bridge.generate()).status,'queued');assert.equal(f.posts().length,2);
  });
  test(`${options.kind}: stale queue status cannot put a finished job back into processing`,async t=>{
    storage(t);let items=[];const f=setup(t,options,{queue:()=>items,onJob:id=>response(completed(id))});await f.bridge.prepare();const accepted=await f.bridge.generate();await f.bridge.fetchResult(accepted.id);items=[{id:accepted.id,kind:options.kind,status:'running'}];const events=[];f.bridge.subscribe(event=>events.push(event));await f.bridge.refreshJobs();assert.equal(f.bridge.state().activeCount,0);assert.equal(f.bridge.state().jobs[0].status,'completed');assert.equal(f.bridge.state().result.id,accepted.id);assert.equal(events.some(event=>event.type==='completed'),false);
  });
  test(`${options.kind}: saved jobs remain retrievable when provider credentials are unavailable`,async t=>{
    const values=storage(t),id=randomUUID();values.set(options.storageKey,id);const f=setup(t,options,{authenticated:()=>false,onJob:savedId=>response(completed(savedId))});await f.bridge.prepare();assert.equal(f.bridge.state().canAttach,false);assert.equal(f.bridge.state().result.id,id);assert.equal(f.bridge.state().activeCount,0);assert.equal(f.posts().length,0);assert.deepEqual(f.jobIds(),[id]);
  });
  test(`${options.kind}: simultaneous completions fetch the newest output once and queue metadata stays bounded`,async t=>{
    storage(t);let items=[];const f=setup(t,options,{queue:()=>items,onJob:id=>response(completed(id))});await f.bridge.prepare();const first=await f.bridge.generate(),second=await f.bridge.generate();
    items=[{id:second.id,kind:options.kind,status:'completed',finishedAt:'2026-10-23T22:00:02Z'},{id:first.id,kind:options.kind,status:'completed',finishedAt:'2026-10-23T22:00:01Z'}];await f.bridge.refreshJobs();assert.equal(f.bridge.state().result.id,second.id);assert.deepEqual(f.jobIds(),[second.id]);
    items=Array.from({length:60},(_,index)=>({id:randomUUID(),kind:options.kind,status:'failed',finishedAt:new Date(Date.UTC(2026,9,24,0,index)).toISOString()}));await f.bridge.refreshJobs();assert(f.bridge.state().jobs.length<=22,'Only recent terminal metadata and latest result are retained.');assert.equal(f.bridge.state().activeCount,0);
  });
  test(`${options.kind}: an explicit connection check refreshes saved-result source availability`,async t=>{
    storage(t);let sourceProjectAvailable=true;const f=setup(t,options,{onJob:id=>response({...completed(id),sourceProjectAvailable})});await f.bridge.prepare();const accepted=await f.bridge.generate();await f.bridge.fetchResult(accepted.id);assert.equal(f.bridge.state().result.sourceProjectAvailable,true);sourceProjectAvailable=false;await f.bridge.prepare();assert.equal(f.bridge.state().result.sourceProjectAvailable,false);assert.equal(f.posts().length,1);
  });
}

test('background polling emits completion without another click and stops after disposal',async t=>{
  storage(t);const options=variants[1];let items=[];const f=setup(t,options,{autoPoll:true,queue:()=>items,onPost:input=>{items=[{id:input.requestId,kind:'image',status:'running'}];return response(items[0],202);},onJob:id=>response(completed(id))});await f.bridge.prepare();const first=await f.bridge.generate();
  const finished=new Promise(resolve=>f.bridge.subscribe(event=>{if(event.type==='completed')resolve();}));items=[{id:first.id,kind:'image',status:'completed'}];await Promise.race([finished,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Background completion did not arrive')),1000))]);await f.bridge.refreshJobs();assert.equal(f.bridge.state().result.id,first.id);f.bridge.dispose();const count=f.calls.length;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.calls.length,count);
});
