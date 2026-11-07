import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile,readdir,rename} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import {createDesktopSheetService,inspectSheetImage} from '../desktop-sheet-service.mjs';

const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=';
function candidatePng(width=1024,height=1024,color=128) {
  const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(kind,bytes)=>{const content=Buffer.concat([Buffer.from(kind),bytes]),length=Buffer.alloc(4),check=Buffer.alloc(4);length.writeUInt32BE(bytes.length);check.writeUInt32BE(crc(content));return Buffer.concat([length,content,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const row=Buffer.alloc(width*3+1,color);row[0]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(Array.from({length:height},()=>row)))),chunk('IEND',Buffer.alloc(0))]);
}
const candidate=candidatePng().toString('base64');
const image=()=>{const bytes=Buffer.from(pixel,'base64');return {...inspectSheetImage(bytes),bytes};};
const key='sk-blockout-loop-not-a-real-key';
const model='gpt-image-2.5-sunburst';
const ids=['framing','camera','placement','scale','orientation','occlusion','content','appearance'];
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function verdict(decision='accept') {
  const result={decision,summary:decision==='accept'?'The visible composition matches.':'The candidate needs attention.',checks:ids.map(id=>({id,status:'pass',evidence:`Visible ${id} matches.`,correction:''})),corrections:[],limitations:['A raster cannot certify exact 3D measurements.']};
  if(decision==='reject'){Object.assign(result.checks[3],{status:'fail',evidence:'The desk is wider than the blockout.',correction:'Restore the original desk width.'});result.corrections=[{checkId:'scale',instruction:result.checks[3].correction}];}
  if(decision==='inconclusive')result.checks[1].status='not_assessable';
  return result;
}
const response=v=>({id:'resp_fixture',status:'completed',model:'gpt-6-astra',reasoning:{effort:'max'},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(v)}]}]});
function fixture(maxAttempts=3){return {requestId:randomUUID(),maxAttempts,prompt:'Use the frozen Blender view. Make the desk red.',source:image()};}
function prepare(input) {
  const source=input.source,review={enabled:true,model:'gpt-6-astra',effort:'max',assetId:'original-blockout',authorizedChanges:'Change the desk material to red.',maxAttempts:input.maxAttempts,source};
  return {id:input.requestId,model,quality:'high',size:'1024x1024',prompt:input.prompt,images:[source],inputRoles:[{image:1,role:'original Blender blockout',filename:'Blockout.png'}],sourceName:'Blockout.png',mode:'image',review,fingerprint:createHash('sha256').update(JSON.stringify({prompt:input.prompt,source:source.sha256,maxAttempts:input.maxAttempts})).digest('hex')};
}
async function setup(t,{decisions=['accept'],reviewReply,imageReply,available=true,...options}={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'asun-blockout-loop-')),calls=[];let reviews=0;
  const fetchImpl=async(url,init={})=>{
    calls.push({url,init});
    if(url.endsWith('/models'))return json({data:[{id:model},...(available?[{id:'gpt-6-astra'}]:[])]});
    if(url.endsWith('/responses'))return reviewReply?reviewReply(url,init):json(response(verdict(decisions[Math.min(reviews++,decisions.length-1)])));
    return imageReply?imageReply(url,init):json({data:[{b64_json:candidate}]});
  };
  const service=createDesktopSheetService({directory,label:'image',prepareRequest:prepare,getKey:()=>key,fetchImpl,...options});
  t.after(async()=>{service.dispose();await rm(directory,{recursive:true,force:true});});
  return {directory,service,calls,fetchImpl};
}
const generationCalls=calls=>calls.filter(call=>call.url.endsWith('/images/edits'));
const reviewCalls=calls=>calls.filter(call=>call.url.endsWith('/responses'));
async function done(service,id){for(let i=0;i<500;i++){const job=await service.job(id);if(!['queued','running'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Fixture job did not finish.');}

test('accepted review completes only after Astra and records the frozen source, actual request and candidate',async t=>{
  const {service,calls,directory}=await setup(t),input=fixture();await service.start(input);const job=await done(service,input.requestId);
  assert.equal(job.status,'completed',job.message);assert.equal(job.review.status,'accepted');assert.equal(job.attempt,1);assert.equal(job.attempts.length,1);assert.equal(generationCalls(calls).length,1);assert.equal(reviewCalls(calls).length,1);
  assert.equal(job.settings.review.source.sha256,input.source.sha256);assert.equal(job.attempts[0].review.sourceSha256,input.source.sha256);
  const body=JSON.parse(reviewCalls(calls)[0].init.body);assert.equal(body.model,'gpt-6-astra');assert.equal(body.reasoning.effort,'max');assert.equal(body.input[1].content.filter(part=>part.type==='input_image').length,2);
  assert.equal((await readFile(path.join(directory,input.requestId+'.review-source.png'))).toString('base64'),pixel);
  assert.equal((await readFile(path.join(directory,input.requestId+'.attempt-1.png'))).toString('base64'),candidate);
  assert.equal(JSON.stringify(job).includes(key),false);assert.match(job.message,/Exact 3D measurements are not verified/);
  const summary=(await service.history()).items[0];assert.equal(summary.review.status,'accepted');assert.equal(summary.attempt,1);assert.equal(summary.attempts,undefined);
});

test('reviewer receives every original generation input index and full numbered reference mapping',async t=>{
  const prepareRequest=input=>{const prepared=prepare(input),bytes=Buffer.from(input.source.bytes);bytes[bytes.length-1]^=1;const reference={...inspectSheetImage(bytes),bytes};
    prepared.images=[reference,input.source,input.source];prepared.inputRoles=[{image:1,role:'original reference photo',filename:'Bird.png',referenceId:'bird-photo',labels:['2','4'],scope:'matching numbered areas only'},{image:2,role:'current composition'},{image:3,role:'original Blender blockout — structure authority'}];return prepared;};
  const {service}=await setup(t,{prepareRequest}),input=fixture();await service.start(input);const job=await done(service,input.requestId);
  assert.equal(job.status,'completed',job.message);const images=job.attempts[0].review.request.images;
  assert.deepEqual(images.map(image=>image.generationInputs.map(mapping=>mapping.index)),[[2,3],[],[1]]);
  assert.deepEqual(images[2].generationInputs[0].roles[0].labels,['2','4']);assert.equal(images[2].generationInputs[0].roles[0].referenceId,'bird-photo');assert.equal(images[0].generationInputs[0].roles[0].role,'current composition');
});

test('polling while reviewing stays compact and explicit output reads still work',async t=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});const {service,calls}=await setup(t,{reviewReply:()=>pending}),input=fixture();
  try{await service.start(input);for(let n=0;n<100&&!reviewCalls(calls).length;n++)await new Promise(resolve=>setTimeout(resolve,10));const job=await service.job(input.requestId);assert.equal(job.status,'running');assert.equal(job.phase,'reviewing');assert.equal(job.outputAvailable,true);assert.equal(job.image,undefined);assert.equal((await service.output(input.requestId)).bytes.toString('base64'),candidate);}
  finally{release(json(response(verdict())));await done(service,input.requestId);}
});

test('evidenced rejection regenerates with the same original inputs and exact corrective prompt without changing base settings',async t=>{
  const {service,calls,directory}=await setup(t,{decisions:['reject','accept']}),input=fixture();await service.start(input);const job=await done(service,input.requestId);
  assert.equal(job.status,'completed',job.message);assert.equal(job.attempt,2);assert.deepEqual(job.attempts.map(a=>a.status),['rejected','accepted']);
  const callsToImages=generationCalls(calls);assert.equal(callsToImages.length,2);assert.equal(reviewCalls(calls).length,2);
  assert.equal(job.settings.prompt,input.prompt);assert.equal(job.attempts[0].settings.prompt,input.prompt);assert.ok(job.attempts[1].settings.prompt.startsWith(input.prompt));assert.match(job.attempts[1].settings.prompt,/Restore the original desk width/);
  for(const [index,call] of callsToImages.entries()){assert.equal(call.init.body.get('quality'),'high');assert.equal(call.init.body.get('model'),model);assert.equal(call.init.body.get('size'),'1024x1024');assert.equal(call.init.body.get('prompt'),job.attempts[index].settings.prompt);assert.equal(Buffer.from(await call.init.body.get('image[]').arrayBuffer()).toString('base64'),pixel);}
  for(const suffix of ['attempt-1.submitted','attempt-1.review-submitted','attempt-2.submitted','attempt-2.review-submitted'])assert.ok((await readdir(directory)).includes(input.requestId+'.'+suffix));
  await service.start(input);assert.equal(generationCalls(calls).length,2);
});

test('exhausted rejection saves every attempt and leaves failed candidate available for history and output',async t=>{
  const {service,calls,directory}=await setup(t,{decisions:['reject']}),input=fixture(3);await service.start(input);const job=await done(service,input.requestId);
  assert.equal(job.status,'failed');assert.equal(job.phase,'needs_review');assert.equal(job.review.status,'rejected');assert.equal(job.attempt,3);assert.equal(generationCalls(calls).length,3);assert.equal(reviewCalls(calls).length,3);assert.equal(job.outputAvailable,true);assert.equal(job.image.source,'data:image/png;base64,'+candidate);assert.match(job.message,/rejected all 3/);
  assert.equal((await service.output(input.requestId)).bytes.toString('base64'),candidate);assert.equal((await service.history()).items[0].outputAvailable,true);
  for(let n=1;n<=3;n++)assert.ok((await readdir(directory)).includes(`${input.requestId}.attempt-${n}.png`));
});

test('inconclusive review preserves candidate and stops without correction',async t=>{
  const {service,calls}=await setup(t,{decisions:['inconclusive']}),input=fixture();await service.start(input);const job=await done(service,input.requestId);
  assert.equal(job.status,'failed');assert.equal(job.review.status,'inconclusive');assert.equal(job.outputAvailable,true);assert.equal(generationCalls(calls).length,1);assert.equal(reviewCalls(calls).length,1);assert.match(job.message,/no corrective generation/i);
});

test('review HTTP, invalid verdict, and network failures never authorize paid regeneration',async t=>{
  for(const [name,reviewReply] of [['HTTP',()=>json({error:{message:key}},503)],['malformed',()=>json(response({...verdict(),decision:'reject'}))],['network',()=>{throw new Error('network '+key);} ]])await t.test(name,async t=>{
    const {service,calls}=await setup(t,{reviewReply}),input=fixture();await service.start(input);const job=await done(service,input.requestId);
    assert.equal(job.status,'failed');assert.equal(job.review.status,'error');assert.equal(job.outputAvailable,true);assert.equal(generationCalls(calls).length,1);assert.equal(reviewCalls(calls).length,1);assert.equal(JSON.stringify(job).includes(key),false);await service.start(input);assert.equal(generationCalls(calls).length,1);
    const audit=job.attempts[0].reviewRequest;assert.equal(audit.endpoint,'https://api.openai.com/v1/responses');assert.equal(audit.method,'POST');assert.equal(audit.body.model,'gpt-6-astra');assert.equal(audit.body.reasoning.effort,'max');assert.equal(job.attempts[0].review,undefined);assert.equal(job.attempts[0].reviewModel,'gpt-6-astra');assert.equal(job.attempts[0].reviewEffort,'max');assert.equal(JSON.stringify(audit).includes(pixel),false);assert.equal(JSON.stringify(audit).includes('Authorization'),false);assert.equal(JSON.stringify(audit).includes(key),false);
  });
});

test('uncertain image submission failure does not review or resubmit',async t=>{
  const {service,calls}=await setup(t,{imageReply:()=>{throw new Error('lost reply '+key);}}),input=fixture();await service.start(input);const job=await done(service,input.requestId);
  assert.equal(job.status,'failed');assert.equal(job.outputAvailable,false);assert.equal(generationCalls(calls).length,1);assert.equal(reviewCalls(calls).length,0);assert.equal(JSON.stringify(job).includes(key),false);await service.start(input);assert.equal(generationCalls(calls).length,1);
});

test('missing Astra access rejects before any image request instead of substituting reviewer',async t=>{
  const {service,calls}=await setup(t,{available:false});assert.equal((await service.status()).reviewModel.available,false);await assert.rejects(service.start(fixture()),/GPT-6 Astra is unavailable/);assert.equal(generationCalls(calls).length,0);assert.equal(reviewCalls(calls).length,0);
});

test('storage reservation covers all candidates plus output and rejects before paid work',async t=>{
  const {service,calls}=await setup(t,{maxStoredBytes:150*1024*1024});await assert.rejects(service.start(fixture(3)),/storage limit/);assert.equal(generationCalls(calls).length,0);
});

test('queued blockout integrity is rechecked before any paid request',async t=>{
  let registered;const queue={register(_label,service){registered=service;},admit:fn=>fn(1),wake(){},position:async()=>1};
  const {service,calls,directory}=await setup(t,{queue}),input=fixture();await service.start(input);
  const bytes=Buffer.from(pixel,'base64');bytes[bytes.length-1]^=1;
  await writeFile(path.join(directory,input.requestId+'.review-source.png'),bytes);
  await (await registered.dispatch(input.requestId)).completion;const job=await service.job(input.requestId);
  assert.equal(job.status,'failed');assert.match(job.message,/original blockout failed its integrity check/);assert.equal(generationCalls(calls).length,0);assert.equal(reviewCalls(calls).length,0);
});

test('an already-claimed corrective attempt stops rather than replaying a paid call',async t=>{
  let registered;const queue={register(_label,service){registered=service;},admit:fn=>fn(1),wake(){},position:async()=>1};
  const {service,calls,directory}=await setup(t,{queue,decisions:['reject']}),input=fixture();await service.start(input);
  await writeFile(path.join(directory,input.requestId+'.attempt-2.submitted'),JSON.stringify({number:2}),{flag:'wx'});
  await (await registered.dispatch(input.requestId)).completion;const job=await service.job(input.requestId);
  assert.equal(job.status,'failed');assert.equal(job.outputAvailable,true);assert.equal(generationCalls(calls).length,1);assert.equal(reviewCalls(calls).length,1);assert.match(job.message,/No automatic retry/);
});

test('failure to publish the next candidate record preserves the prior output pointer and both immutable files',async t=>{
  const second=candidatePng(1024,1024,160);let images=0;
  const renameFile=async(from,to)=>{if(to.endsWith('.json')){const candidate=JSON.parse(await readFile(from,'utf8'));if(candidate.image?.attempt===2&&candidate.phase==='reviewing')throw Object.assign(new Error('fixture candidate publication failed'),{code:'EIO'});}return rename(from,to);};
  const {service,calls,directory}=await setup(t,{decisions:['reject','accept'],renameFile,imageReply:()=>json({data:[{b64_json:images++?second.toString('base64'):candidate}]})}),input=fixture();await service.start(input);const job=await done(service,input.requestId);
  assert.equal(job.status,'failed');assert.equal(job.outputAvailable,true);assert.equal(job.image.source,'data:image/png;base64,'+candidate);assert.equal((await service.output(input.requestId)).bytes.toString('base64'),candidate);assert.equal((await readFile(path.join(directory,input.requestId+'.attempt-2.png'))).toString('base64'),second.toString('base64'));assert.equal(generationCalls(calls).length,2);assert.equal(reviewCalls(calls).length,1);
});

test('wrong encoded output dimensions stop before paid review or another image attempt while retaining the original candidate',async t=>{
  const wrong=candidatePng(1536,1024,200);
  const {service,calls,directory}=await setup(t,{imageReply:()=>json({size:'1024x1024',data:[{b64_json:wrong.toString('base64')}]})}),input=fixture(3);
  await service.start(input);const job=await done(service,input.requestId);
  assert.equal(job.status,'failed');assert.equal(job.phase,'needs_review');assert.equal(job.review.status,'error');assert.equal(job.attempt,1);assert.equal(job.attempts.length,1);
  assert.equal(job.attempts[0].status,'failed');assert.equal(job.attempts[0].phase,'output-size-mismatch');assert.equal(job.outputCheck.matches,false);
  assert.equal(job.outputCheck.requestedWidth,1024);assert.equal(job.outputCheck.actualWidth,1536);assert.equal(job.outputCheck.actualHeight,1024);
  assert.equal(job.returned.size,'1024x1024');assert.equal(job.outputAvailable,true);assert.match(job.message,/Output size mismatch/);assert.match(job.message,/No automatic retry/);assert.match(job.message,/Astra review was not submitted/);
  assert.equal(generationCalls(calls).length,1);assert.equal(reviewCalls(calls).length,0);
  assert.deepEqual(await readFile(path.join(directory,input.requestId+'.attempt-1.png')),wrong);
  assert.deepEqual((await service.output(input.requestId)).bytes,wrong);
  const files=await readdir(directory);assert.equal(files.includes(input.requestId+'.attempt-1.review-submitted'),false);assert.equal(files.includes(input.requestId+'.attempt-2.submitted'),false);
  await service.start(input);assert.equal(generationCalls(calls).length,1);assert.equal(reviewCalls(calls).length,0);
});

test('recovery retains a candidate from an interrupted review without resubmitting',async t=>{
  const {service,calls,directory,fetchImpl}=await setup(t),input=fixture();await service.start(input);await done(service,input.requestId);service.dispose();
  const recordPath=path.join(directory,input.requestId+'.json'),saved=JSON.parse(await readFile(recordPath,'utf8'));saved.status='running';saved.phase='reviewing';saved.ownerPid=2147483647;await writeFile(recordPath,JSON.stringify(saved));
  const recovered=createDesktopSheetService({directory,label:'image',prepareRequest:prepare,getKey:()=>key,fetchImpl});t.after(()=>recovered.dispose());
  const job=await recovered.job(input.requestId);assert.equal(job.status,'failed');assert.equal(job.phase,'needs_review');assert.equal(job.outputAvailable,true);assert.match(job.message,/No operation will be submitted again/);await recovered.start(input);assert.equal(generationCalls(calls).length,1);assert.equal(reviewCalls(calls).length,1);
});
