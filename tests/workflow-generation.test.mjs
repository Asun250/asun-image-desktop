import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopGeneration} from '../public/desktop-sheet-generation.mjs';

const model='gpt-image-2.5-sunburst',other='gpt-image-1.5';
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(t,kind) {
  const originalStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),storage=new Map();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
  t.after(()=>originalStorage?Object.defineProperty(globalThis,'localStorage',originalStorage):delete globalThis.localStorage);
  const project={prompt:'Workflow one',references:[{source:'reference-one'}],layers:[{id:'raster',mask:[{mode:'hide'}]}]},jobs=new Map(),calls=[],hooks={},events=[];
  let snapshots=0;
  const endpoint='/api/'+(kind==='sheet'?'sheets':'images');
  const fetchImpl=async(url,options={})=>{
    calls.push({url,...options});
    if(url===endpoint+'/status')return response({authenticated:true,token:'fixture-token',models:[{id:model,available:true},{id:other,available:true}]});
    if(url==='/api/generation-queue/status')return response({items:[...jobs.values()].map(({image,...record})=>record)});
    if(url===endpoint+'/generate'){const body=JSON.parse(options.body);const record={id:body.requestId,kind,status:'queued',model:body.model,settings:{model:body.model,quality:body.quality},createdAt:new Date().toISOString()};jobs.set(record.id,record);return response(record,202);}
    const id=decodeURIComponent(url.split('/').at(-1));if(hooks.job)return hooks.job(id);return response(jobs.get(id));
  };
  const bridge=createDesktopGeneration({kind,endpoint,storageKey:'workflow-test.'+kind,autoPoll:false,editor:{snapshot(){snapshots++;return project;}},fetchImpl,prepareInput:async project=>{await hooks.prepare?.();return {project};}});
  bridge.subscribe(event=>events.push(event));t.after(()=>bridge.dispose());
  const finish=(id,time)=>{const record={...jobs.get(id),status:'completed',finishedAt:time||new Date().toISOString(),outputAvailable:true,image:{source:'data:image/png;base64,'+id,name:id+'.png',width:1,height:1}};jobs.set(id,record);return record;};
  return {bridge,project,jobs,calls,hooks,events,storage,finish,snapshots:()=>snapshots,gets:()=>calls.filter(call=>call.url.includes('/jobs/')),posts:()=>calls.filter(call=>call.method==='POST')};
}

for(const kind of ['image','sheet']) {
  test(`${kind}: unchanged queue polls do not rewrite storage or notify editor views`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();const job=await f.bridge.generate();
    await f.bridge.refreshJobs();f.events.length=0;
    const originalSet=f.storage.set;let writes=0;f.storage.set=function(...args){writes++;return originalSet.apply(this,args);};
    await f.bridge.refreshJobs();await f.bridge.refreshJobs();
    assert.equal(writes,0);assert.deepEqual(f.events,[]);assert.equal(f.bridge.state().activeCount,1);
    f.jobs.set(job.id,{...f.jobs.get(job.id),status:'running'});await f.bridge.refreshJobs();
    assert.equal(f.bridge.state().jobs.find(item=>item.id===job.id).status,'running');assert(f.events.some(event=>event.type==='status'));assert(writes>0);
    f.events.length=0;f.finish(job.id);await f.bridge.refreshJobs();assert.equal(f.events.filter(event=>event.type==='completed').length,1);assert.equal(f.bridge.state().result.id,job.id);
    f.events.length=0;writes=0;await f.bridge.refreshJobs();assert.equal(writes,0);assert.deepEqual(f.events,[]);
  });
  test(`${kind}: workflow settings and results remain separate while all jobs continue polling`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.bridge.setWorkflowContext({jobIds:[],settings:{model,quality:'max'}});const first=await f.bridge.generate();f.bridge.setWorkflowContext({jobIds:[{id:first.id,kind}],settings:{model,quality:'max'}});
    f.project.prompt='Workflow two';f.project.references[0].source='reference-two';f.bridge.setWorkflowContext({jobIds:[],settings:{model:other,quality:'low'}});assert.equal(f.bridge.state().result,null);const second=await f.bridge.generate();f.bridge.setWorkflowContext({jobIds:[second.id],settings:{model:other,quality:'low'}});
    f.finish(first.id);await f.bridge.refreshJobs();assert.equal(f.bridge.state().jobs.find(job=>job.id===first.id).status,'completed');assert.equal(f.bridge.state().activeCount,1);assert.equal(f.bridge.state().contextActiveCount,1);assert.equal(f.bridge.state().result,null);assert.equal(f.bridge.state().resultReady,false);assert.equal(f.gets().length,0,'Foreign completions do not load full output bytes.');
    f.finish(second.id);await f.bridge.refreshJobs();assert.equal(f.bridge.state().result.id,second.id);assert.equal(f.bridge.state().model,other);assert.equal(f.bridge.state().quality,'low');
    f.bridge.setWorkflowContext({jobIds:[first.id],settings:{model,quality:'max'}});assert.equal(f.bridge.state().result,null);assert.equal(f.bridge.state().resultId,first.id);assert.equal(f.bridge.state().resultReady,true);assert.equal((await f.bridge.fetchResult()).id,first.id);assert.equal(f.bridge.state().result.id,first.id);assert.equal(f.bridge.state().quality,'max');
    const bodies=f.posts().map(call=>JSON.parse(call.body));assert.equal(bodies[0].project.prompt,'Workflow one');assert.equal(bodies[0].project.references[0].source,'reference-one');assert.equal(bodies[0].quality,'max');assert.equal(bodies[1].project.prompt,'Workflow two');assert.equal(bodies[1].project.references[0].source,'reference-two');assert.equal(bodies[1].quality,'low');assert.equal(f.snapshots(),2);
  });
  test(`${kind}: an old output request finishing after a tab switch cannot overwrite the new tab result`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();const one=await f.bridge.generate(),two=await f.bridge.generate();f.finish(one.id);f.finish(two.id);await f.bridge.refreshJobs();
    f.bridge.setWorkflowContext({jobIds:[one.id]});const pending=gate();f.hooks.job=async id=>{if(id===one.id)await pending.promise;return response(f.jobs.get(id));};const oldRequest=f.bridge.fetchResult(one.id);
    f.bridge.setWorkflowContext({jobIds:[two.id]});await f.bridge.fetchResult(two.id);pending.resolve();assert.equal((await oldRequest).id,one.id);assert.equal(f.bridge.state().result.id,two.id);assert.equal(f.bridge.state().resultId,two.id);assert.deepEqual(f.bridge.state().contextJobs.map(job=>job.id),[two.id]);
  });
  test(`${kind}: mixed-kind contexts filter correctly and switches emit no user-settings event`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();const initial=f.bridge.state();f.events.length=0;
    const version=f.bridge.setWorkflowContext({jobIds:[{id:'own',kind},{id:'foreign',kind:kind==='image'?'sheet':'image'},'legacy-own',{id:'own',kind}],settings:{model:other,quality:'max'}});
    assert.deepEqual(f.bridge.state().workflowJobIds,['own','legacy-own']);assert.equal(f.bridge.state().workflowVersion,version);assert.equal(f.bridge.state().model,other);assert.equal(f.bridge.state().quality,'max');assert.match(f.bridge.state().settingsError,/unsupported|does not support|not support|supported quality/i);assert.deepEqual(f.events.map(event=>event.type),['workflow']);assert.equal(f.snapshots(),0);
    f.bridge.setWorkflowContext({settings:{model:'',quality:''}});assert.equal(f.bridge.state().model,other);assert.equal(f.bridge.state().quality,'max');f.bridge.selectQuality('high');assert.equal(f.events.at(-1).type,'settings');assert.equal(initial.quality,'high');
  });
  test(`${kind}: switches are blocked throughout snapshot upload and do not alter the request`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.bridge.setWorkflowContext({jobIds:[],settings:{model,quality:'xhigh'}});const pending=gate();f.hooks.prepare=()=>pending.promise;const generating=f.bridge.generate();assert.equal(f.bridge.state().working,true);
    assert.throws(()=>f.bridge.setWorkflowContext({jobIds:['other'],settings:{model:other,quality:'low'}}),/upload/);assert.equal(f.bridge.state().model,model);assert.equal(f.bridge.state().quality,'xhigh');pending.resolve();await generating;assert.equal(JSON.parse(f.posts()[0].body).quality,'xhigh');assert.deepEqual(f.bridge.state().workflowJobIds,[]);
  });
  test(`${kind}: completed context metadata survives switching without retaining every full image`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();const one=await f.bridge.generate(),two=await f.bridge.generate();f.finish(one.id,'2026-10-23T01:00:00Z');f.finish(two.id,'2026-10-23T01:00:01Z');f.bridge.setWorkflowContext({jobIds:[one.id,two.id]});await f.bridge.refreshJobs();assert.equal(f.bridge.state().result.id,two.id);assert.equal(f.bridge.state().resultId,two.id);
    assert(f.bridge.state().jobs.every(job=>job.image===undefined));f.bridge.setWorkflowContext({jobIds:[]});assert.equal(f.bridge.state().result,null);assert.equal(f.bridge.state().resultReady,false);assert.equal(f.bridge.state().jobs.length,2);await assert.rejects(f.bridge.editOutput(),/unavailable/);await assert.rejects(f.bridge.fetchResult(),/Choose a generation/);assert.equal(f.posts().length,2);
  });
  test(`${kind}: loading a stored workflow discovers its saved output without replacing its project`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();const id='saved-workflow-job';f.jobs.set(id,{id,kind,status:'queued'});f.finish(id);const source=structuredClone(f.project);f.bridge.setWorkflowContext({jobIds:[{id,kind}],settings:{model,quality:'medium'}});await f.bridge.refreshJobs();assert.equal(f.bridge.state().resultId,id);assert.equal(f.bridge.state().result.id,id);assert.deepEqual(f.project,source);assert.equal(f.snapshots(),0);assert.equal(f.posts().length,0);
  });
  test(`${kind}: enabling workflow contexts preserves earlier uncertain-upload recovery`,async t=>{
    const f=fixture(t,kind),id='uncertain-before-workflow';f.storage.set('workflow-test.'+kind+'.jobs',JSON.stringify([{id,status:'submission-unknown',uncertain:true}]));f.bridge.setWorkflowContext({jobIds:[],settings:{model,quality:'high'}});assert.equal(f.bridge.state().uncertainRequestId,id);assert.equal(f.bridge.state().activeCount,1);assert.equal(f.bridge.state().contextActiveCount,0);assert.equal(f.posts().length,0);
  });
}

