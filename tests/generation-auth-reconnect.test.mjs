import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopGeneration} from '../public/desktop-sheet-generation.mjs';
import {isLocalGenerationAuthError,isLocalGenerationAuthResponse} from '../public/local-generation-auth.mjs';

const model='gpt-image-2.5-sunburst',otherModel='gpt-image-1.5';
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const variants=['image','sheet'];
function fixture(t,kind) {
  const storageBefore=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),storage=new Map();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)}});
  t.after(()=>storageBefore?Object.defineProperty(globalThis,'localStorage',storageBefore):delete globalThis.localStorage);
  const endpoint='/api/'+(kind==='sheet'?'sheets':'images'),tokenHeader='x-asun-'+kind+'-token',calls=[],jobs=new Map(),hooks={};
  const project={prompt:'Keep the four birds',layers:[{id:'original',mask:[{mode:'hide',points:[{x:12,y:18}]}]}],references:[{id:'bird',source:'original-reference'}]};
  let serverToken='before-restart',snapshots=0,inputPreparations=0,admissions=0,statusCalls=0;
  const fetchImpl=async(url,init={})=>{
    calls.push({url,...init});
    if(url===endpoint+'/status') {
      statusCalls++;const custom=await hooks.status?.(statusCalls);if(custom)return custom;
      return response({authenticated:true,token:serverToken,models:[{id:otherModel,available:true},{id:model,available:true}]});
    }
    const rejected=init.headers?.[tokenHeader]!==serverToken||hooks.reject?.(url,init);
    if(rejected) {
      await hooks.beforeRejection?.(url,init);
      return response(hooks.legacy?{error:url==='/api/generation-queue/status'?'Refresh Asun IMG to authorize the generation queue.':`Refresh Asun IMG to authorize ${kind} generation.`}:{error:'The local authorization has expired.',code:'ASUN_LOCAL_TOKEN_EXPIRED'},403);
    }
    if(url==='/api/generation-queue/status')return await hooks.queue?.(init)??response({items:[...jobs.values()]});
    if(url===endpoint+'/generate') {
      const input=JSON.parse(init.body);
      if(hooks.post)return hooks.post(input,init);
      return admit(input);
    }
    if(url.startsWith(endpoint+'/jobs/')) {
      const id=decodeURIComponent(url.split('/').at(-1));
      return await hooks.job?.(id,init)??(jobs.has(id)?response(jobs.get(id)):response({error:'Not found'},404));
    }
    throw new Error('Unexpected request: '+url);
  };
  function admit(input) {
    if(!jobs.has(input.requestId))admissions++;
    const record={id:input.requestId,kind,status:'queued',model:input.model,settings:{model:input.model,quality:input.quality}};jobs.set(record.id,record);return response(record,202);
  }
  const bridge=createDesktopGeneration({kind,endpoint,tokenHeader,storageKey:'auth-test.'+kind,autoPoll:false,fetchImpl,editor:{snapshot(){snapshots++;return project;}},prepareInput:async snapshot=>{inputPreparations++;await hooks.prepareInput?.(snapshot);return {images:[{source:snapshot.references[0].source}],project:snapshot};}});
  t.after(()=>bridge.dispose());
  return {bridge,hooks,project,jobs,calls,admit,endpoint,tokenHeader,restart(){serverToken='after-restart';},stats:()=>({snapshots,inputPreparations,admissions,statusCalls}),posts:()=>calls.filter(call=>call.method==='POST'),gets:()=>calls.filter(call=>call.url.startsWith(endpoint+'/jobs/'))};
}

test('local auth classification accepts only tagged or exact legacy 403 errors and preserves raw response bodies',async()=>{
  assert.equal(isLocalGenerationAuthError({status:403,code:'ASUN_LOCAL_TOKEN_EXPIRED'}),true);
  for(const message of ['Refresh Asun IMG to authorize image generation.','Refresh Asun IMG to authorize sheet generation.','Refresh Asun IMG to authorize the generation queue.']) {
    assert.equal(isLocalGenerationAuthError({status:403,message}),true);
    assert.equal(isLocalGenerationAuthError({status:401,message}),false);
    assert.equal(isLocalGenerationAuthError({status:500,message}),false);
  }
  for(const error of [{status:401,code:'ASUN_LOCAL_TOKEN_EXPIRED'},{status:403,message:'Provider denied access'},{status:403,message:'Requests must come from this app.'},{status:403,message:'Refresh Asun IMG to authorize image generation. extra'},new TypeError('Network disconnected'),null])assert.equal(isLocalGenerationAuthError(error),false);
  const raw=response({error:'Expired',code:'ASUN_LOCAL_TOKEN_EXPIRED'},403);assert.equal(await isLocalGenerationAuthResponse(raw),true);assert.equal(raw.bodyUsed,false);assert.equal((await raw.json()).code,'ASUN_LOCAL_TOKEN_EXPIRED');
  assert.equal(await isLocalGenerationAuthResponse(new Response('Not JSON',{status:403})),false);
  assert.equal(await isLocalGenerationAuthResponse(response({error:'Provider forbidden'},403)),false);
  assert.equal(await isLocalGenerationAuthResponse(response({code:'ASUN_LOCAL_TOKEN_EXPIRED'},401)),false);
});

for(const kind of variants) {
  test(`${kind}: restarted local auth retries the identical request once without resnapshotting or resetting selected settings`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.bridge.selectModel(model);f.bridge.selectQuality('max');f.restart();
    f.hooks.beforeRejection=(url)=>{if(url.endsWith('/generate')){f.project.prompt='A new unsaved project';f.project.references[0].source='new-reference';}};
    const accepted=await f.bridge.generate();const posts=f.posts();assert.equal(posts.length,2);assert.equal(posts[0].body,posts[1].body);assert.equal(posts[0].headers[f.tokenHeader],'before-restart');assert.equal(posts[1].headers[f.tokenHeader],'after-restart');
    const sent=JSON.parse(posts[1].body);assert.equal(sent.requestId,accepted.id);assert.equal(sent.model,model);assert.equal(sent.quality,'max');assert.equal(sent.project.prompt,'Keep the four birds');assert.equal(sent.images[0].source,'original-reference');assert.deepEqual(sent.project.layers[0].mask,[{mode:'hide',points:[{x:12,y:18}]}]);
    assert.deepEqual(f.stats(),{snapshots:1,inputPreparations:1,admissions:1,statusCalls:2});assert.equal(f.bridge.state().working,false);assert.equal(f.bridge.state().uncertain,false);assert.equal(f.bridge.state().model,model);assert.equal(f.bridge.state().quality,'max');assert.equal(f.project.prompt,'A new unsaved project');
  });
  test(`${kind}: legacy exact-message authentication reconnects both submission and queue reads`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.hooks.legacy=true;f.restart();const accepted=await f.bridge.generate();assert.equal(f.stats().admissions,1);assert.equal(f.stats().statusCalls,2);
    // Force one further stale token on the queue, then allow its one retry.
    let rejectOnce=true;f.hooks.reject=url=>url==='/api/generation-queue/status'&&rejectOnce;f.hooks.beforeRejection=url=>{if(url==='/api/generation-queue/status')rejectOnce=false;};
    await f.bridge.refreshJobs();assert.equal(f.stats().statusCalls,3);assert.equal(f.bridge.state().jobs.find(job=>job.id===accepted.id).status,'queued');assert.equal(f.posts().length,2);
  });
  test(`${kind}: concurrent job, queue and explicit connection checks share one token refresh`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();const accepted=await f.bridge.generate();f.bridge.selectModel(model);f.bridge.selectQuality('xhigh');f.restart();
    const started=deferred(),gate=deferred();f.hooks.status=async count=>{if(count===2){started.resolve();await gate.promise;}};
    const job=f.bridge.refreshJob(accepted.id),queue=f.bridge.refreshJobs();await started.promise;const check=f.bridge.prepare();gate.resolve();await Promise.all([job,queue,check]);
    assert.equal(f.stats().statusCalls,2);assert.equal(f.gets().length,2);assert.equal(f.bridge.state().model,model);assert.equal(f.bridge.state().quality,'xhigh');assert.equal(f.stats().admissions,1);
  });
  test(`${kind}: a delayed old-token rejection reuses the token another job already renewed`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();const first=await f.bridge.generate(),second=await f.bridge.generate();f.restart();const held=deferred(),release=deferred();
    f.hooks.beforeRejection=async url=>{if(url.endsWith('/'+first.id)){held.resolve();await release.promise;}};
    const slow=f.bridge.refreshJob(first.id);await held.promise;await f.bridge.refreshJob(second.id);release.resolve();await slow;
    assert.equal(f.stats().statusCalls,2);assert.equal(f.gets().length,4);assert.equal(f.stats().admissions,2);
  });
  test(`${kind}: repeated local rejection stops after one retry and does not leave an uncertain submission`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.hooks.reject=url=>url.endsWith('/generate');await assert.rejects(f.bridge.generate(),error=>error.status===403&&error.code==='ASUN_LOCAL_TOKEN_EXPIRED');
    assert.equal(f.posts().length,2);assert.equal(f.stats().statusCalls,2);assert.equal(f.stats().admissions,0);assert.equal(f.gets().length,0);assert.equal(f.bridge.state().uncertain,false);assert.equal(f.bridge.state().working,false);assert.equal(f.bridge.state().activeCount,0);
    f.hooks.reject=()=>false;await f.bridge.generate();assert.equal(f.stats().admissions,1);
  });
  test(`${kind}: repeated queue rejection stops without triggering a per-job refresh loop`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();await f.bridge.generate();f.hooks.reject=url=>url==='/api/generation-queue/status';await assert.rejects(f.bridge.refreshJobs(),error=>error.code==='ASUN_LOCAL_TOKEN_EXPIRED');
    assert.equal(f.stats().statusCalls,2);assert.equal(f.gets().length,0);assert.equal(f.calls.filter(call=>call.url==='/api/generation-queue/status').length,3);assert.equal(f.bridge.state().activeCount,1);
  });
  test(`${kind}: failed renewal after a definite pre-admission rejection allows correction without uncertain recovery`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.restart();f.hooks.status=()=>{throw new TypeError('Connection offline');};
    await assert.rejects(f.bridge.generate(),error=>error.preAdmissionRejected===true&&!error.submissionUncertain&&/Connection offline/.test(error.message));
    assert.equal(f.posts().length,1);assert.equal(f.stats().admissions,0);assert.equal(f.gets().length,0);assert.equal(f.bridge.state().uncertain,false);assert.equal(f.bridge.state().activeCount,0);
    f.hooks.status=null;await f.bridge.generate();assert.equal(f.stats().admissions,1);assert.equal(f.bridge.state().uncertain,false);
  });
  test(`${kind}: a lost retry response recovers only the same ID and preserves the frozen request`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.restart();f.hooks.post=input=>{f.admit(input);throw new TypeError('Retry response disconnected');};
    const accepted=await f.bridge.generate();assert.equal(accepted.recovered,true);assert.equal(f.posts().length,2);assert.equal(f.posts()[0].body,f.posts()[1].body);assert.deepEqual(f.gets().map(call=>call.url.split('/').at(-1)),[accepted.id]);assert.equal(f.stats().admissions,1);assert.equal(f.bridge.state().uncertain,false);
  });
  test(`${kind}: a lost retry with unavailable recovery retains the same request ID and never resubmits`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.restart();f.hooks.post=()=>{throw new TypeError('Retry response disconnected');};f.hooks.job=()=>response({error:'Not yet known'},404);let id;
    await assert.rejects(f.bridge.generate(),error=>{id=error.requestId;return error.submissionUncertain;});await assert.rejects(f.bridge.generate(),/no new request/);
    assert.equal(f.posts().length,2);assert.equal(f.posts()[0].body,f.posts()[1].body);assert(f.gets().every(call=>call.url.endsWith('/'+id)));assert.equal(f.bridge.state().uncertainRequestId,id);assert.equal(f.stats().snapshots,1);
  });
  test(`${kind}: provider authorization and same-origin errors are reported without token refresh or retry`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();
    for(const [status,error,code] of [[401,'Provider API key rejected','invalid_api_key'],[403,'Provider account unavailable','provider_forbidden'],[403,'Requests must come from this app.','ASUN_ORIGIN_REQUIRED'],[401,'Refresh Asun IMG to authorize image generation.','ASUN_LOCAL_TOKEN_EXPIRED']]) {
      const before=f.posts().length;f.hooks.post=()=>response({error,code},status);await assert.rejects(f.bridge.generate(),caught=>caught.message===error&&caught.status===status&&caught.code===code);assert.equal(f.posts().length,before+1);assert.equal(f.stats().statusCalls,1);assert.equal(f.bridge.state().uncertain,false);
    }
  });
  test(`${kind}: ordinary network interruption uses same-ID status recovery without refreshing or retrying POST`,async t=>{
    const f=fixture(t,kind);await f.bridge.prepare();f.hooks.post=input=>{f.admit(input);throw new TypeError('Offline');};const accepted=await f.bridge.generate();assert.equal(accepted.recovered,true);assert.equal(f.posts().length,1);assert.equal(f.stats().statusCalls,1);assert.equal(f.stats().admissions,1);
  });
}
