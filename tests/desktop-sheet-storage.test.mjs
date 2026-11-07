import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rename,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDesktopSheetService} from '../desktop-sheet-service.mjs';

const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=';
async function fixture(t, completionErrors) {
  const prefix=path.resolve(os.tmpdir(),'asun-sheet-storage-'),directory=await mkdtemp(prefix),id=randomUUID();
  let paidPosts=0,completionAttempts=0,completionWrites=0;
  const injectedCompletionErrors=[],nativeCompletionErrors=[];
  const fetchImpl=async(url,options={})=>new Response(JSON.stringify(url.endsWith('/models')?{data:[{id:'gpt-image-2.5-sunburst'}]}:(paidPosts++,{data:[{b64_json:pixel}]})),{headers:{'Content-Type':'application/json'}});
  const prepareRequest=()=>({id,model:'gpt-image-2.5-sunburst',images:[],prompt:'Mock only',fingerprint:'storage-fixture',sourceName:'Fixture',mode:'image'});
  const renameFile=async(source,target)=>{
    const completing=target.endsWith('.json') && JSON.parse(await readFile(source,'utf8')).status==='completed';
    if(completing) {
      const code=completionErrors[completionAttempts++];
      if(code){injectedCompletionErrors.push(code);throw Object.assign(new Error('Mock destination lock'),{code});}
    }
    try{await rename(source,target);if(completing)completionWrites++;}
    catch(error){if(completing)nativeCompletionErrors.push(error.code);throw error;}
  };
  const service=createDesktopSheetService({directory,getKey:()=> 'mock-key',fetchImpl,prepareRequest,label:'image',renameFile});
  t.after(async()=>{service.dispose();assert.ok(path.resolve(directory).startsWith(prefix));await rm(directory,{recursive:true,force:true});});
  await service.start({});
  let result;
  for(let i=0;i<400;i++) {result=await service.job(id);if(!['queued','running'].includes(result.status))break;await new Promise(resolve=>setTimeout(resolve,10));}
  return {directory,id,result,service,fetchImpl,prepareRequest,counts:()=>({paidPosts,completionAttempts}),completionIO:()=>({injectedCompletionErrors,nativeCompletionErrors,completionWrites})};
}

test('transient Windows completion locks retry only the atomic rename and retain one paid result',async t=>{
  const state=await fixture(t,['EPERM','EBUSY','EACCES']);
  assert.equal(state.result.status,'completed',state.result.message);
  const counts=state.counts(),io=state.completionIO();
  assert.equal(counts.paidPosts,1);assert.deepEqual(io.injectedCompletionErrors,['EPERM','EBUSY','EACCES']);
  // The native Windows rename can itself encounter another reader/antivirus
  // lock during parallel tests. Account for it explicitly rather than assume
  // that the first native attempt always succeeds.
  assert.ok(io.nativeCompletionErrors.every(code=>['EPERM','EBUSY','EACCES'].includes(code)));
  assert.equal(io.completionWrites,1);
  assert.equal(counts.completionAttempts,io.injectedCompletionErrors.length+io.nativeCompletionErrors.length+io.completionWrites);
  assert.ok(counts.completionAttempts>=4&&counts.completionAttempts<=7,'completion writes stay within the bounded seven-attempt retry budget');
  assert.equal(state.result.image.source,'data:image/png;base64,'+pixel);
  assert.equal((await readFile(path.join(state.directory,state.id+'.png'))).toString('base64'),pixel);
  assert.equal((await readdir(state.directory)).some(name=>name.endsWith('.tmp')),false);
  await state.service.start({});assert.equal(state.counts().paidPosts,1);
  const recovered=createDesktopSheetService({directory:state.directory,getKey:()=> 'mock-key',fetchImpl:state.fetchImpl,prepareRequest:state.prepareRequest,label:'image'});
  t.after(()=>recovered.dispose());assert.equal((await recovered.job(state.id)).status,'completed');assert.equal(state.counts().paidPosts,1);
});

test('persistent file locks have bounded retries and preserve the generated PNG without another paid request',async t=>{
  const state=await fixture(t,Array(20).fill('EPERM'));
  assert.equal(state.result.status,'failed');assert.match(state.result.message,/No automatic retry/);
  assert.deepEqual(state.counts(),{paidPosts:1,completionAttempts:7});
  assert.equal((await readFile(path.join(state.directory,state.id+'.png'))).toString('base64'),pixel);
  await state.service.start({});assert.equal(state.counts().paidPosts,1);
});

test('non-transient storage failures are not retried',async t=>{
  const state=await fixture(t,['ENOSPC']);
  assert.equal(state.result.status,'failed');assert.deepEqual(state.counts(),{paidPosts:1,completionAttempts:1});
  assert.equal((await readFile(path.join(state.directory,state.id+'.png'))).toString('base64'),pixel);
});
