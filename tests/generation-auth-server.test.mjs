import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from '../server.mjs';

const expiredCode='ASUN_LOCAL_TOKEN_EXPIRED';
async function fixture(t){
  const calls={image:{start:[],cancel:[],job:[]},sheet:{start:[],cancel:[],job:[]},queue:0};
  const service=kind=>({
    token:kind+'-new-runtime-token',
    status:async()=>({token:kind+'-new-runtime-token',authenticated:true,models:[]}),
    start:async input=>{calls[kind].start.push(input);if(input.fixtureProviderDenied)throw Object.assign(new Error('This model is unavailable to the connected account.'),{statusCode:403});return {id:input.requestId,kind,status:'queued'};},
    cancel:async id=>{calls[kind].cancel.push(id);return {id,kind,status:'cancelled'};},
    job:async id=>{calls[kind].job.push(id);return {id,kind,status:'queued'};},
    dispose(){},
  });
  const images=service('image'),sheets=service('sheet'),generationQueue={status:async()=>{calls.queue++;return {items:[],counts:{queued:0},concurrency:1,message:''};},dispose(){}};
  const server=createServer({images,sheets,generationQueue,detection:{status:async()=>({available:false}),dispose(){}},imageSearch:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port;
  const send=async(url,options={})=>{const response=await fetch(base+url,options);return {status:response.status,data:await response.json()};};
  return {base,calls,images,sheets,send};
}

for(const kind of ['image','sheet'])test(`${kind} stale authorization is rejected before admission; refreshing accepts the same request ID and body once`,async t=>{
  const state=await fixture(t),prefix=kind==='image'?'/api/images':'/api/sheets',header=`x-asun-${kind}-token`,id=randomUUID();
  const payload={requestId:id,project:{name:'Keep this exact snapshot'},model:'selected-model',quality:'max'},body=JSON.stringify(payload);
  const options={method:'POST',headers:{Origin:state.base,'Content-Type':'application/json',[header]:'old-runtime-token'},body};
  const rejected=await state.send(prefix+'/generate',options);assert.equal(rejected.status,403);assert.equal(rejected.data.code,expiredCode);assert.equal(state.calls[kind].start.length,0);
  const missing=await state.send(prefix+'/generate',{...options,headers:{Origin:state.base,'Content-Type':'application/json'}});assert.equal(missing.status,403);assert.equal(missing.data.code,expiredCode);assert.equal(state.calls[kind].start.length,0);
  const connection=await state.send(prefix+'/status');assert.equal(connection.status,200);
  const accepted=await state.send(prefix+'/generate',{...options,headers:{...options.headers,[header]:connection.data.token}});
  assert.equal(accepted.status,202);assert.equal(accepted.data.id,id);assert.equal(accepted.data.status,'queued');assert.deepEqual(state.calls[kind].start,[payload]);
});

for(const kind of ['image','sheet'])test(`${kind} stale cancellation and polling fail before reaching the service`,async t=>{
  const state=await fixture(t),prefix=kind==='image'?'/api/images':'/api/sheets',header=`x-asun-${kind}-token`,id=randomUUID();
  const headers={Origin:state.base,[header]:'old-runtime-token'};
  const cancel=await state.send(prefix+'/jobs/'+id+'/cancel',{method:'POST',headers});assert.equal(cancel.status,403);assert.equal(cancel.data.code,expiredCode);assert.equal(state.calls[kind].cancel.length,0);
  const poll=await state.send(prefix+'/jobs/'+id,{headers});assert.equal(poll.status,403);assert.equal(poll.data.code,expiredCode);assert.equal(state.calls[kind].job.length,0);
  const connection=await state.send(prefix+'/status');const accepted=await state.send(prefix+'/jobs/'+id+'/cancel',{method:'POST',headers:{...headers,[header]:connection.data.token}});
  assert.equal(accepted.status,200);assert.equal(accepted.data.status,'cancelled');assert.deepEqual(state.calls[kind].cancel,[id]);
});

test('queue rejects old tokens before scanning and accepts either current service token',async t=>{
  const state=await fixture(t),stale=await state.send('/api/generation-queue/status',{headers:{'x-asun-image-token':'old-runtime-token'}});
  assert.equal(stale.status,403);assert.equal(stale.data.code,expiredCode);assert.equal(state.calls.queue,0);
  for(const kind of ['image','sheet']){const connection=await state.send(`/api/${kind==='image'?'images':'sheets'}/status`);const result=await state.send('/api/generation-queue/status',{headers:{[`x-asun-${kind}-token`]:connection.data.token}});assert.equal(result.status,200);}
  assert.equal(state.calls.queue,2);
});

test('cross-origin failures stay distinct from expired authorization and never reach protected actions',async t=>{
  const state=await fixture(t),id=randomUUID();
  for(const kind of ['image','sheet'])for(const token of ['old-runtime-token',kind+'-new-runtime-token']){
    const prefix=kind==='image'?'/api/images':'/api/sheets',headers={Origin:'https://foreign.invalid','Content-Type':'application/json',[`x-asun-${kind}-token`]:token};
    for(const [url,options] of [[prefix+'/status',{headers}],[prefix+'/generate',{method:'POST',headers,body:JSON.stringify({requestId:id})}],[prefix+'/jobs/'+id+'/cancel',{method:'POST',headers}],['/api/generation-queue/status',{headers}]]){
      const result=await state.send(url,options);assert.equal(result.status,403);assert.equal(result.data.code,undefined);assert.match(result.data.error,/same-origin/);
    }
  }
  assert.deepEqual(state.calls,{image:{start:[],cancel:[],job:[]},sheet:{start:[],cancel:[],job:[]},queue:0});
});

test('provider/account rejection and missing mutation origin are never marked as refreshable token failures',async t=>{
  const state=await fixture(t),headers={'x-asun-image-token':state.images.token,'Content-Type':'application/json'},body=JSON.stringify({requestId:randomUUID(),fixtureProviderDenied:true});
  const noOrigin=await state.send('/api/images/generate',{method:'POST',headers,body});assert.equal(noOrigin.status,403);assert.equal(noOrigin.data.code,undefined);assert.equal(state.calls.image.start.length,0);
  const provider=await state.send('/api/images/generate',{method:'POST',headers:{...headers,Origin:state.base},body});assert.equal(provider.status,403);assert.equal(provider.data.code,undefined);assert.match(provider.data.error,/unavailable/);assert.equal(state.calls.image.start.length,1);
});
