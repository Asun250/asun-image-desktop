import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import {newProject,addRaster,addReference,addText,attachObjectRegion} from '../public/core.mjs';
import {withSheetPreset} from '../public/sheet-preset.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {createDesktopSheetService,prepareSheetRequest,SHEET_MODELS} from '../desktop-sheet-service.mjs';
import {createGenerationQueue} from '../desktop-generation-queue.mjs';

const models=['gpt-image-2.6-sunburst','gpt-image-2.6-flare'];
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function png(width,height){
  const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(kind,bytes)=>{const data=Buffer.concat([Buffer.from(kind),bytes]),length=Buffer.alloc(4),check=Buffer.alloc(4);length.writeUInt32BE(bytes.length);check.writeUInt32BE(crc(data));return Buffer.concat([length,data,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(height*(width*3+1)))),chunk('IEND',Buffer.alloc(0))]);
}
const originalBytes=png(1,1),original={name:'Untouched reference.png',width:1,height:1,source:'data:image/png;base64,'+originalBytes.toString('base64')};
const outputCache=new Map();
const output=size=>{if(!outputCache.has(size)){const [width,height]=size.split('x').map(Number);outputCache.set(size,png(width,height));}return outputCache.get(size);};
function fixture({model=models[0],complexity,quality='high',mode='image',references=false}={}){
  let project=newProject(1024,1536,'GPT Image 2.6 fixture');project.prompt='Retain the exact requested composition and lighting.';project.imageOutput={version:1,aspect:'2:3'};
  if(references)project=addReference(project,original);
  if(mode==='sheet'){project=addRaster(project,original).project;project=withSheetPreset(project,{active:true,views:7,subject:'item',referenceIds:[],notes:'Keep all details.'});}
  return {requestId:randomUUID(),project,model,quality,...(complexity===undefined?{}:{complexity})};
}
async function setup(t,{mode='image',paused=false,reply}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'asun-image26-service-')),calls=[],instances=[];
  const fetchImpl=async(url,init={})=>{
    calls.push({url,init});if(url.endsWith('/models'))return json({data:SHEET_MODELS.map(({id})=>({id}))});
    assert.match(url,/^https:\/\/api\.openai\.com\/v1\/images\/(generations|edits)$/);assert.equal(init.method,'POST');
    if(reply)return reply(url,init);
    const sent=typeof init.body==='string'?JSON.parse(init.body):Object.fromEntries(init.body),bytes=output(sent.size);
    return json({model:sent.model,quality:sent.quality,...(sent.complexity?{complexity:sent.complexity}:{}),size:sent.size,data:[{b64_json:bytes.toString('base64')}]});
  };
  function instantiate(isPaused=paused){
    const queue=createGenerationQueue({directory:path.join(directory,'queue'),pollMs:10});
    const service=createDesktopSheetService({directory:path.join(directory,'jobs'),label:mode,prepareRequest:mode==='sheet'?prepareSheetRequest:prepareImageRequest,queue:isPaused?{...queue,wake(){}}:queue,getKey:()=> 'mock-image26-credential',fetchImpl});
    const instance={service,queue,dispose(){service.dispose();queue.dispose();}};instances.push(instance);return instance;
  }
  const first=instantiate();
  t.after(async()=>{for(const instance of instances)instance.dispose();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^asun-image26-service-/);await rm(directory,{recursive:true,force:true});});
  return {...first,directory,calls,instantiate};
}
const posts=calls=>calls.filter(({init})=>init.method==='POST');
async function finished(service,id){for(let i=0;i<400;i++){const value=await service.job(id);if(!['queued','running'].includes(value.status))return value;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Mock 2.6 job did not finish.');}

for(const model of models)for(const complexity of ['low','medium','high'])for(const references of [false,true]){
  test(`${model} ${complexity} reaches ${references?'multipart edits':'JSON generation'} without changing refs or portrait dimensions`,async t=>{
    const {service,calls,directory}=await setup(t),request=fixture({model,complexity,references,quality:'max'}),before=structuredClone(request.project);
    await service.start(request);const result=await finished(service,request.requestId);assert.equal(result.status,'completed',result.message);
    const [post]=posts(calls);assert.equal(posts(calls).length,1);
    const body=references?Object.fromEntries(post.init.body):JSON.parse(post.init.body);
    assert.equal(post.url,'https://api.openai.com/v1/images/'+(references?'edits':'generations'));
    assert.equal(body.model,model);assert.equal(body.complexity,complexity);assert.equal(body.quality,'max');assert.equal(body.size,'1024x1536');assert.equal(body.output_format,'png');
    if(references){const files=post.init.body.getAll('image[]');assert.equal(files.length,1);assert.deepEqual(Buffer.from(await files[0].arrayBuffer()),originalBytes);}
    assert.equal(result.settings.complexity,complexity);assert.equal(result.settings.options.complexity,complexity);assert.equal(result.returned.complexity,complexity);assert.equal(result.outputCheck.matches,true);
    assert.deepEqual(request.project,before);assert.deepEqual((await service.project(request.requestId)).project,before);
    assert.equal((await service.history()).items[0].settings.complexity,complexity);assert.equal((await service.queue.status()).items[0].settings.complexity,complexity);
    assert.deepEqual((await service.output(request.requestId)).bytes,output('1024x1536'));assert.deepEqual(await readFile(path.join(directory,'jobs',request.requestId+'.png')),output('1024x1536'));
  });
}

for(const model of models)test(`${model} keeps all six quality values and defaults complexity to high for image and sheet generation`,async t=>{
  for(const quality of ['auto','low','medium','high','xhigh','max'])assert.equal(prepareImageRequest(fixture({model,quality})).quality,quality);
  for(const mode of ['image','sheet']){
    const {service,calls}=await setup(t,{mode}),request=fixture({model,mode});delete request.quality;
    await service.start(request);const result=await finished(service,request.requestId);assert.equal(result.status,'completed',result.message);
    const post=posts(calls)[0],body=typeof post.init.body==='string'?JSON.parse(post.init.body):Object.fromEntries(post.init.body);
    assert.equal(body.model,model);assert.equal(body.complexity,'high');assert.equal(body.quality,'high');assert.equal(result.settings.complexity,'high');
    assert.equal(body.size,mode==='sheet'?'1536x1024':'1024x1536');
    if(mode==='sheet')assert.match(body.prompt,/7/);
  }
});

test('invalid or unsupported complexity is rejected before any provider request, including sheet requests',async t=>{
  const {service,calls}=await setup(t);
  for(const complexity of ['auto','max','',false,1,{}])await assert.rejects(service.start(fixture({complexity})),/complexity/i);
  await assert.rejects(service.start(fixture({model:'gpt-image-2.5-sunburst',complexity:'high'})),/complexity/i);
  assert.throws(()=>prepareSheetRequest(fixture({model:'gpt-image-2.5-flare',complexity:'low',mode:'sheet'})),/complexity/i);
  assert.throws(()=>prepareSheetRequest(fixture({complexity:'max',mode:'sheet'})),/complexity/i);
  assert.equal(calls.length,0);
});

test('2.5 request fingerprints and provider bodies omit complexity entirely',async t=>{
  for(const mode of ['image','sheet']){
    const {service,calls}=await setup(t,{mode}),request=fixture({model:'gpt-image-2.5-sunburst',mode,quality:'max'}),prepare=mode==='sheet'?prepareSheetRequest:prepareImageRequest;
    assert.equal(Object.hasOwn(prepare(request),'complexity'),false);assert.equal(prepare(request).fingerprint,prepare({...request,complexity:null}).fingerprint);
    await service.start(request);const result=await finished(service,request.requestId);assert.equal(result.status,'completed',result.message);
    const body=posts(calls)[0].init.body;assert.equal(typeof body==='string'?Object.hasOwn(JSON.parse(body),'complexity'):body.has('complexity'),false);
    assert.equal(Object.hasOwn(result.settings,'complexity'),false);assert.equal(Object.hasOwn(result.settings.options,'complexity'),false);
  }
});

test('2.6 complexity binds the request ID and persists across a queued server restart',async t=>{
  const state=await setup(t,{paused:true}),request=fixture({complexity:'medium',references:true,quality:'xhigh'});
  await state.service.start(request);assert.equal(posts(state.calls).length,0);
  assert.equal((await state.service.queue.status()).items[0].settings.complexity,'medium');
  assert.notEqual(prepareImageRequest(request).fingerprint,prepareImageRequest({...request,complexity:'low'}).fingerprint);
  await assert.rejects(state.service.start({...request,complexity:'low'}),error=>error.statusCode===409);
  state.dispose();const restarted=state.instantiate(false);restarted.queue.resume();
  const result=await finished(restarted.service,request.requestId);assert.equal(result.status,'completed',result.message);
  assert.equal(result.settings.complexity,'medium');assert.equal(posts(state.calls)[0].init.body.get('complexity'),'medium');assert.equal(posts(state.calls)[0].init.body.get('quality'),'xhigh');
  await restarted.service.start(request);assert.equal(posts(state.calls).length,1);
});

test('2.6 selected-area edits preserve the exact source canvas and mask dimensions',async t=>{
  const bytes=output('1024x1536'),image={name:'Canvas.png',width:1024,height:1536,source:'data:image/png;base64,'+bytes.toString('base64')};
  let project=addRaster(newProject(1024,1536),image).project;project.prompt='Change the marked region only.';project.imageOutput={version:1,aspect:'9:16'};
  const text=addText(project,{content:'1',x:0,y:0,width:50,height:50});
  project=attachObjectRegion(text.project,text.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:project.layers[0].id,sourceWidth:1024,sourceHeight:1536,mask:{width:2,height:2,counts:[0,1,3]}});
  const request={requestId:randomUUID(),project,model:models[1],quality:'high',complexity:'low',composition:image,guide:image,areaMasks:[{id:text.layerId,image}]};
  const {service,calls}=await setup(t);await service.start(request);const result=await finished(service,request.requestId);assert.equal(result.status,'completed',result.message);
  const body=posts(calls)[0].init.body;assert.equal(body.get('size'),'1024x1536');assert.equal(body.get('complexity'),'low');assert.equal(body.getAll('image[]').length>=1,true);
  for(const file of body.getAll('image[]')){const payload=Buffer.from(await file.arrayBuffer());assert.equal(payload.readUInt32BE(16),1024);assert.equal(payload.readUInt32BE(20),1536);}
  assert.equal(result.settings.outputFraming.width,1024);assert.equal(result.settings.outputFraming.height,1536);
});

test('catalog preserves existing default model and exposes only account-available 2.6 models with separate complexity',async t=>{
  const {service}=await setup(t),status=await service.status();assert.equal(status.models[0].id,'gpt-image-2.5-sunburst');assert.equal(status.defaultQuality,'high');
  for(const id of models){const model=status.models.find(item=>item.id===id);assert.equal(model.available,true);assert.deepEqual(model.complexities,['low','medium','high']);assert.equal(model.defaultComplexity,'high');assert.deepEqual(model.qualities,['auto','low','medium','high','xhigh','max']);}
  assert.match(status.models.find(item=>item.id===models[0]).label,/detailed work/);assert.match(status.models.find(item=>item.id===models[1]).label,/faster iteration/);
  const old=status.models.find(item=>item.id==='gpt-image-2.5-sunburst');assert.deepEqual(old.complexities,[]);assert.equal(Object.hasOwn(old,'defaultComplexity'),false);
});

for(const model of models)test(`${model} sheet generation sends selected low complexity with its reference and records the exact settings`,async t=>{
  const {service,calls}=await setup(t,{mode:'sheet'}),request=fixture({model,mode:'sheet',complexity:'low',quality:'max'});
  const changed={...request,complexity:'medium'};assert.notEqual(prepareSheetRequest(request).fingerprint,prepareSheetRequest(changed).fingerprint);
  await service.start(request);const result=await finished(service,request.requestId);assert.equal(result.status,'completed',result.message);
  const post=posts(calls)[0];assert.match(post.url,/\/images\/edits$/);assert.equal(post.init.body.get('complexity'),'low');assert.equal(post.init.body.get('quality'),'max');
  assert.deepEqual(Buffer.from(await post.init.body.get('image[]').arrayBuffer()),originalBytes);assert.equal(result.settings.complexity,'low');assert.equal((await service.history()).items[0].settings.complexity,'low');
  await assert.rejects(service.start(changed),error=>error.statusCode===409);assert.equal(posts(calls).length,1);
});

test('provider rejection of a 2.6 setting is reported without substitution or an automatic retry',async t=>{
  const {service,calls}=await setup(t,{reply:()=>json({error:{message:'The selected complexity value is not available for this account.'}},400)}),request=fixture({complexity:'high'});
  await service.start(request);const result=await finished(service,request.requestId);assert.equal(result.status,'failed');assert.match(result.message,/complexity value is not available/);assert.match(result.message,/No automatic retry/);
  assert.equal(result.settings.model,request.model);assert.equal(result.settings.complexity,'high');await service.start(request);assert.equal(posts(calls).length,1);
});
