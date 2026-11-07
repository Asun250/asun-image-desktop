import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {newProject,addRaster,addReference} from '../public/core.mjs';
import {withSheetPreset} from '../public/sheet-preset.mjs';
import {DEFAULT_GENERATION_QUALITY,generationQualityOptions,validateGenerationQuality} from '../public/generation-settings.mjs';
import {createDesktopSheetService,prepareSheetRequest,SHEET_MODELS,inspectSheetImage} from '../desktop-sheet-service.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {createServer} from '../server.mjs';

const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=','base64');
const image={name:'Subject.png',source:'data:image/png;base64,'+pixel.toString('base64'),width:1,height:1};
const key='sk-history-fixture-not-a-credential';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const qualityValues=['auto','low','medium','high','xhigh','max'];
function request(mode='sheet',quality) {
  let project=newProject(1,1,'History fixture');project.prompt='A quiet green meadow.';
  if(mode==='sheet'){project=addRaster(project,image).project;project=withSheetPreset(project,{active:true,subject:'item',views:7});}
  return {requestId:randomUUID(),project,model:mode==='sheet'?'gpt-image-2.5-sunburst':'gpt-image-2.5-flare',quality};
}
async function setup(t,mode='sheet',options={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'asun-generation-history-')),calls=[];
  const fetchImpl=async(url,init={})=>{calls.push({url,init});if(url.endsWith('/models'))return json({data:SHEET_MODELS.map(({id})=>({id}))});return options.reply?options.reply(url,init,directory):json({data:[{b64_json:pixel.toString('base64')}]});};
  const service=createDesktopSheetService({directory,label:mode,prepareRequest:mode==='sheet'?prepareSheetRequest:prepareImageRequest,getKey:()=>key,fetchImpl,...options});
  t.after(async()=>{service.dispose();await rm(directory,{recursive:true,force:true});});return {service,calls,directory,fetchImpl};
}
async function done(service,id){for(let i=0;i<200;i++){const result=await service.job(id);if(!['queued','running'].includes(result.status))return result;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Mock generation did not finish.');}
const posts=calls=>calls.filter(call=>call.init.method==='POST');

test('quality choices default to high and reject explicit invalid or unsupported values without a fallback',()=>{
  assert.equal(DEFAULT_GENERATION_QUALITY,'high');assert.equal(validateGenerationQuality('gpt-image-2.5-sunburst'),'high');
  assert.deepEqual(generationQualityOptions(''),qualityValues.slice(0,4));
  for(const model of ['gpt-image-2.5-sunburst','gpt-image-2.5-flare','gpt-image-2.5-sunburst-2026-09-08','gpt-image-2.5-flare-2026-09-08'])assert.deepEqual(generationQualityOptions(model),qualityValues);
  for(const model of ['gpt-image-2','gpt-image-1.5','gpt-image-1','gpt-image-1-mini']){assert.deepEqual(generationQualityOptions(model),qualityValues.slice(0,4));assert.throws(()=>validateGenerationQuality(model,'max'),/supported quality/);}
  for(const value of ['',null,4,'HIGH','bogus'])assert.throws(()=>validateGenerationQuality('gpt-image-2.5-sunburst',value),/supported quality/);
});

for(const mode of ['sheet','image'])test(`${mode}: every supported quality reaches the provider unchanged and immutable settings are saved before submission`,async t=>{
  const saved=[];
  const{service,calls,directory}=await setup(t,mode,{reply:async(_url,init,folder)=>{
    const data=typeof init.body==='string'?JSON.parse(init.body):Object.fromEntries([...init.body].filter(([name])=>name!=='image[]'));
    const files=await readdir(folder),records=await Promise.all(files.filter(name=>name.endsWith('.json')).map(async name=>JSON.parse(await readFile(path.join(folder,name),'utf8'))));
    const active=records.find(record=>record.status==='running');assert.ok(active,'request settings are persisted before a paid POST');
    assert.equal(active.settings.quality,data.quality);assert.equal(active.settings.prompt,data.prompt);assert.equal(active.settings.size,data.size);assert.equal(active.settings.options.n,1);
    saved.push(active.settings);return json({quality:data.quality==='auto'?'high':data.quality,size:data.size,background:'opaque',output_format:'png',model:data.model,data:[{b64_json:pixel.toString('base64')}]});
  }});
  const access=await service.status();assert.equal(access.defaultQuality,'high');assert.deepEqual(access.models.find(model=>model.id==='gpt-image-2.5-flare').qualities,qualityValues);
  for(const quality of qualityValues){
    const input=request(mode,quality);await service.start(input);const result=await done(service,input.requestId);
    assert.equal(result.status,'completed',result.message);assert.equal(result.settings.quality,quality);assert.equal(result.settings.options.quality,quality);assert.equal(result.returned.quality,quality==='auto'?'high':quality);
    assert.equal(result.settings.endpoint,mode==='sheet'?'/images/edits':'/images/generations');assert.equal(result.output.width,1);assert.equal(result.output.height,1);assert.ok(result.createdAt);assert.ok(result.finishedAt);
    const originalPrompt=result.settings.prompt;input.project.prompt='Changed after generation';assert.equal((await service.job(input.requestId)).settings.prompt,originalPrompt);
    const changed={...input,project:structuredClone(input.project),quality:quality==='max'?'low':'max'};await assert.rejects(service.start(changed),/different .* settings/);
  }
  assert.equal(posts(calls).length,6);assert.equal(saved.length,6);
  for(const filename of (await readdir(directory)).filter(name=>name.endsWith('.json')))assert.equal((await readFile(path.join(directory,filename),'utf8')).includes(key),false);
});

test('quality and requested size are bound to fingerprints; invalid quality fails before access checks or paid calls',async t=>{
  for(const [mode,prepare] of [['sheet',prepareSheetRequest],['image',prepareImageRequest]]){
    const input=request(mode),defaultValue=prepare(input),high=prepare({...input,quality:'high'}),maximum=prepare({...input,quality:'max'});
    assert.equal(defaultValue.fingerprint,high.fingerprint);assert.notEqual(high.fingerprint,maximum.fingerprint);assert.equal(high.quality,'high');
    if(mode==='image'){const wide=structuredClone(input);wide.project.width=1536;wide.project.height=1024;wide.project.imageOutput={version:1,aspect:'3:2'};assert.equal(prepare(wide).size,'1536x1024');assert.notEqual(prepare(wide).fingerprint,high.fingerprint);}
    const{service,calls}=await setup(t,mode);
    for(const quality of ['',null,'bogus'])await assert.rejects(service.start({...input,quality}),/supported quality/);
    await assert.rejects(service.start({...input,model:'gpt-image-1',quality:'xhigh'}),/supported quality/);assert.equal(calls.length,0);
  }
});

test('exact source bytes, explicit roles and immutable settings remain available after restart without credentials',async t=>{
  const{service,calls,directory}=await setup(t,'image'),input=request('image','auto');input.project=addRaster(input.project,image).project;input.composition=image;
  input.project=addReference(input.project,{...image,name:'Actual reference name.png'});
  await service.start(input);const result=await done(service,input.requestId);assert.equal(result.settings.inputs.length,2);assert.equal(result.settings.inputs[0].role,'current composition');
  const reference=result.settings.inputs[1];assert.equal(reference.name,'Actual reference name.png');assert.equal(reference.role,'original reference photo');assert.equal(reference.roles[0].referenceId,input.project.references[0].id);assert.equal(reference.width,1);assert.equal(reference.byteLength,pixel.length);
  assert.deepEqual((await service.input(input.requestId,2)).bytes,pixel);assert.deepEqual((await service.output(input.requestId)).bytes,pixel);assert.deepEqual(result.availableInputs,[1,2]);
  const recovered=createDesktopSheetService({directory,label:'image',prepareRequest:prepareImageRequest,getKey:()=>'',fetchImpl:()=>{throw new Error('No network expected');}});t.after(()=>recovered.dispose());
  const reopened=await recovered.job(input.requestId);assert.deepEqual(reopened.settings,result.settings);assert.equal(reopened.legacy,false);assert.deepEqual((await recovered.input(input.requestId,1)).bytes,pixel);assert.equal(posts(calls).length,1);
  await writeFile(path.join(directory,input.requestId+'.input-2.png'),Buffer.from('corrupted local bytes'));
  await assert.rejects(service.input(input.requestId,2),/image/);await assert.rejects(service.input(input.requestId,'../1'),/input image number/);
});

test('history retains more than twelve outputs and paging never includes full images or prompts',async t=>{
  const{service,calls}=await setup(t,'image'),ids=[];
  for(let index=0;index<13;index++){const input=request('image','medium');ids.push(input.requestId);await service.start(input);await done(service,input.requestId);}
  const first=await service.history({limit:5});assert.equal(first.items.length,5);assert.ok(first.nextCursor);assert.ok(first.items.every(item=>item.outputAvailable&&item.status==='completed'));
  assert.ok(first.items.every(item=>!item.image&&!item.settings.prompt&&!item.settings.options&&item.settings.quality==='medium'));
  const second=await service.history({limit:5,cursor:first.nextCursor}),third=await service.history({limit:5,cursor:second.nextCursor});assert.equal(third.nextCursor,null);
  assert.deepEqual(new Set([...first.items,...second.items,...third.items].map(item=>item.id)),new Set(ids));assert.equal((await service.job(ids[0])).status,'completed');assert.equal(posts(calls).length,13);
  for(const options of [{limit:0},{limit:51},{limit:'x'},{cursor:'../bad'},{cursor:Buffer.from('{"id":"bad"}').toString('base64url')}])await assert.rejects(service.history(options),/history/);
});

test('legacy, failed, running and expired history is honest about unrecorded settings and absent output files',async t=>{
  const{service,directory,calls}=await setup(t),base={model:'gpt-image-2.5-sunburst',sourceName:'Old subject',mode:'sheet',createdAt:'2026-10-01T00:00:00.000Z',image:{...inspectSheetImage(pixel),name:'Old sheet.png'}};
  const records=[{...base,id:randomUUID(),status:'completed'},{...base,id:randomUUID(),status:'completed'},{...base,id:randomUUID(),status:'failed',message:'This older sheet preview has expired from local history. Download images you want to keep.'},{...base,id:randomUUID(),status:'failed',message:'Provider refused the request.'},{...base,id:randomUUID(),status:'running',ownerPid:process.pid}];
  for(const value of records)await writeFile(path.join(directory,value.id+'.json'),JSON.stringify(value));await writeFile(path.join(directory,records[0].id+'.png'),pixel);
  const history=await service.history();assert.equal(history.items.length,5);for(const item of history.items){assert.equal(item.legacy,true);assert.equal(item.settings,null);assert.deepEqual(item.availableInputs,[]);assert.deepEqual(item.returned,{});assert.equal(item.model,base.model);}
  const byId=new Map(history.items.map(item=>[item.id,item]));assert.equal(byId.get(records[0].id).status,'completed');assert.equal(byId.get(records[0].id).output.width,1);assert.equal(byId.get(records[1].id).status,'expired');assert.equal(byId.get(records[2].id).status,'expired');assert.equal(byId.get(records[3].id).status,'failed');assert.equal(byId.get(records[4].id).status,'running');
  assert.equal((await service.job(records[1].id)).image,undefined);await assert.rejects(service.output(records[1].id),error=>error.statusCode===404);await assert.rejects(service.input(records[0].id,1),error=>error.statusCode===404);assert.equal(calls.length,0);
});

test('storage accounting includes source inputs and refuses new billing without deleting earlier images',async t=>{
  const{service,calls}=await setup(t,'sheet',{maxStoredBytes:50*1024*1024+256*1024+pixel.length-1});await assert.rejects(service.start(request()),error=>error.statusCode===507&&/Existing images have been kept/.test(error.message));assert.equal(posts(calls).length,0);
});

test('a failed input save leaves an honest request record and never submits the provider POST',async t=>{
  const{service,calls}=await setup(t,'sheet',{renameFile:async(from,to)=>{if(to.endsWith('.input-1.png'))throw Object.assign(new Error('disk full'),{code:'ENOSPC'});return rename(from,to);}}),input=request();
  await assert.rejects(service.start(input),/No generation request was sent/);const failed=await service.job(input.requestId);assert.equal(failed.status,'failed');assert.equal(failed.settings.quality,'high');assert.deepEqual(failed.availableInputs,[]);assert.equal(posts(calls).length,0);await service.start(input);assert.equal(posts(calls).length,0);
});

test('history, source images and output files require the correct private token and same-origin access',async t=>{
  const{service,calls}=await setup(t),input=request();await service.start(input);await done(service,input.requestId);
  const server=createServer({sheets:service,images:{token:'another-service',dispose(){}},detection:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port,headers={'X-Asun-Sheet-Token':service.token},paths=['/api/sheets/history','/api/sheets/jobs/'+input.requestId+'/input/1','/api/sheets/jobs/'+input.requestId+'/output'];
  for(const route of paths){assert.equal((await fetch(base+route)).status,403);assert.equal((await fetch(base+route,{headers:{...headers,Origin:'https://foreign.invalid'}})).status,403);assert.equal((await fetch(base+route,{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status,403);assert.equal((await fetch(base+route,{headers:{'X-Asun-Image-Token':'another-service'}})).status,403);assert.equal((await fetch(base+route,{method:'POST',headers})).status,405);}
  const history=await(await fetch(base+paths[0],{headers})).json();assert.equal(history.items[0].id,input.requestId);assert.equal(history.items[0].image,undefined);
  for(const route of paths.slice(1)){const response=await fetch(base+route,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),pixel);}
  for(const suffix of ['/input/0','/input/17','/input/01','/input/NaN'])assert.equal((await fetch(base+'/api/sheets/jobs/'+input.requestId+suffix,{headers})).status,400);
  assert.equal((await fetch(base+'/api/sheets/jobs/not-an-id/output',{headers})).status,400);assert.equal((await fetch(base+'/data/sheet-jobs/'+input.requestId+'.input-1.png')).status,404);assert.equal(posts(calls).length,1);
});
