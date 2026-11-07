import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,unlink,rename,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {newProject,addRaster,addReference,addText,addDrawing,attachObjectRegion,linkReferences,updateLabelComment,referenceProject,updateReferenceAnnotations,saveVariant,validateProject} from '../public/core.mjs';
import {withSheetPreset} from '../public/sheet-preset.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {createDesktopSheetService,prepareSheetRequest,SHEET_MODELS} from '../desktop-sheet-service.mjs';
import {createServer} from '../server.mjs';

// Use a documented native edit size so storage tests reach their intended paths.
// The compressed solid image stays small; selections and editable data remain intact.
const canvasSize=1024;
function png(width=canvasSize,height=canvasSize) {
  const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(kind,bytes)=>{const data=Buffer.concat([Buffer.from(kind),bytes]),length=Buffer.alloc(4),check=Buffer.alloc(4);length.writeUInt32BE(bytes.length);check.writeUInt32BE(crc(data));return Buffer.concat([length,data,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(height*(1+width*3),0))),chunk('IEND',Buffer.alloc(0))]);
}
const pixel=png(),image={name:'Original.png',source:'data:image/png;base64,'+pixel.toString('base64'),width:canvasSize,height:canvasSize};
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function request(mode='image') {
  let project=addRaster(newProject(),image).project;project.name='Editable source';project.prompt='Use the linked reference only for the selected subjects.';
  project=addReference(project,{...image,name:'Appearance.png'});
  const referenceId=project.references[0].id;
  project.references[0].notes='Keep the gold trim';
  const referenceMark=addText(referenceProject(project.references[0]),{content:'Only this trim',x:0,y:0,width:3,height:2,fontSize:1});
  project=updateReferenceAnnotations(project,referenceId,referenceMark.project.layers.slice(1));
  const label=addText(project,{content:'1',x:1,y:1,width:2,height:2,fontSize:1});
  project=linkReferences(label.project,label.layerId,[referenceId]);
  project=updateLabelComment(project,label.layerId,'Apply this appearance to both selected subjects.');
  project=attachObjectRegion(project,label.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:project.layers[0].id,sourceWidth:image.width,sourceHeight:image.height,mask:{width:4,height:4,counts:[0,1,14,1]},group:{areaCount:2}});
  project=addDrawing(project,{mode:'pencil',points:[[0,0],[3,3]],size:1,color:'#112233'}).project;
  project=addDrawing(project,{mode:'highlight',points:[[1,1],[2,2]],size:1,color:'#ffff00'}).project;
  project=withSheetPreset(project,{active:mode==='sheet',views:7,subject:'item',referenceIds:[referenceId],notes:'Preserve the individual components.'});
  project=saveVariant(project,'Before this generation');validateProject(project);
  const input={requestId:randomUUID(),project,model:'gpt-image-2.5-sunburst',quality:'high'};
  if(mode==='image')Object.assign(input,{composition:image,guide:image,referencePreviews:[{id:referenceId,image}],areaMasks:[{id:label.layerId,image}]});
  else input.annotationPreviews=[{id:referenceId,image}];
  return input;
}
async function setup(t,mode='image',options={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'asun-source-restore-')),calls=[];
  const fetchImpl=async(url,init={})=>{calls.push({url,init});if(url.endsWith('/models'))return json({data:SHEET_MODELS.map(({id})=>({id}))});return options.reply?options.reply(url,init,directory):json({data:[{b64_json:pixel.toString('base64')}]});};
  const service=createDesktopSheetService({directory,label:mode,prepareRequest:mode==='sheet'?prepareSheetRequest:prepareImageRequest,getKey:()=> 'mock-credential',fetchImpl,...options});
  t.after(async()=>{service.dispose();await rm(directory,{recursive:true,force:true});});
  return {directory,calls,service,fetchImpl};
}
const posts=calls=>calls.filter(call=>call.init.method==='POST');
async function finished(service,id){for(let i=0;i<200;i++){const result=await service.job(id);if(!['queued','running'].includes(result.status))return result;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Mock generation did not finish');}

for(const mode of ['image','sheet'])test(`${mode} stores the exact editable source before submission and restores originals, regions and references after restart`,async t=>{
  const input=request(mode),expected=structuredClone(input.project);
  const {directory,calls,service}=await setup(t,mode,{reply:async(_url,_init,folder)=>{
    assert.deepEqual(JSON.parse(await readFile(path.join(folder,input.requestId+'.project.asun'),'utf8')),expected);
    return json({data:[{b64_json:pixel.toString('base64')}]});
  }});
  const accepted=await service.start(input);assert.equal(accepted.sourceProjectAvailable,true);
  input.project.prompt='Later edits must not change the recorded source';input.project.references[0].notes='Different notes';
  const result=await finished(service,input.requestId);assert.equal(result.status,'completed',result.message);assert.equal(result.sourceProjectAvailable,true);
  const recovered=createDesktopSheetService({directory,label:mode,prepareRequest:mode==='sheet'?prepareSheetRequest:prepareImageRequest,getKey:()=>'',fetchImpl:()=>{throw new Error('No network needed to restore a source');}});t.after(()=>recovered.dispose());
  const restored=await recovered.project(input.requestId);assert.deepEqual(restored,{project:expected});
  restored.project.layers[0].visible=false;assert.deepEqual((await recovered.project(input.requestId)).project,expected);
  const history=await recovered.history();assert.equal(history.items[0].sourceProjectAvailable,true);assert.equal(history.items[0].project,undefined);assert.equal(JSON.stringify(history).includes(image.source),false);
  const record=JSON.parse(await readFile(path.join(directory,input.requestId+'.json'),'utf8'));assert.equal(record.sourceProject.sha256,sha(JSON.stringify(expected)));assert.equal(record.sourceProject.byteLength,Buffer.byteLength(JSON.stringify(expected)));
  assert.equal(posts(calls).length,1);
});

test('new request IDs bind the editable source even when dormant variants leave provider inputs unchanged',async t=>{
  const {service,calls,directory,fetchImpl}=await setup(t),input=request();
  await service.start(input);await finished(service,input.requestId);
  const changed=structuredClone(input);changed.project.variants[0].name='Changed dormant variant';
  assert.equal(prepareImageRequest(changed).fingerprint,prepareImageRequest(input).fingerprint);
  await assert.rejects(service.start(changed),error=>error.statusCode===409&&/editable source/.test(error.message));
  const recovered=createDesktopSheetService({directory,label:'image',prepareRequest:prepareImageRequest,getKey:()=> 'mock',fetchImpl});t.after(()=>recovered.dispose());
  await assert.rejects(recovered.start(changed),error=>error.statusCode===409);await recovered.start(input);assert.equal(posts(calls).length,1);
});

test('legacy and removed source projects are unavailable, never approximated from provider reference images',async t=>{
  const {service,calls,directory}=await setup(t),input=request();await service.start(input);await finished(service,input.requestId);
  await unlink(path.join(directory,input.requestId+'.project.asun'));
  assert.equal((await service.job(input.requestId)).sourceProjectAvailable,false);
  await assert.rejects(service.project(input.requestId),error=>error.statusCode===404&&/no longer stored/.test(error.message));
  const legacyId=randomUUID();await writeFile(path.join(directory,legacyId+'.json'),JSON.stringify({id:legacyId,status:'failed',model:input.model,sourceName:'Legacy image'}));
  const legacy=await service.job(legacyId);assert.equal(legacy.sourceProjectAvailable,false);assert.match(legacy.sourceProjectMessage,/no saved editable source/);
  await assert.rejects(service.project(legacyId),error=>error.statusCode===404&&/earlier generation/.test(error.message));assert.equal(posts(calls).length,1);
});

test('source corruption and invalid native data fail clearly without touching the saved generated image',async t=>{
  const {service,calls,directory}=await setup(t),input=request();await service.start(input);await finished(service,input.requestId);
  const file=path.join(directory,input.requestId+'.project.asun'),recordFile=path.join(directory,input.requestId+'.json');
  const bytes=await readFile(file),changed=Buffer.from(bytes);changed[changed.indexOf(Buffer.from('Editable source'))]='X'.charCodeAt(0);await writeFile(file,changed);
  await assert.rejects(service.project(input.requestId),error=>error.statusCode===500&&/integrity/.test(error.message));assert.equal((await service.job(input.requestId)).sourceProjectAvailable,false);
  const invalid=Buffer.from('{"format":"invalid"}'),record=JSON.parse(await readFile(recordFile,'utf8'));record.sourceProject.sha256=sha(invalid);record.sourceProject.byteLength=invalid.length;await writeFile(file,invalid);await writeFile(recordFile,JSON.stringify(record));
  await assert.rejects(service.project(input.requestId),error=>error.statusCode===500&&/invalid/.test(error.message));assert.equal((await service.history()).items[0].sourceProjectAvailable,false);
  assert.deepEqual((await service.output(input.requestId)).bytes,pixel);assert.equal(posts(calls).length,1);
});

test('source storage is reserved and failures stop before billing without automatic retries',async t=>{
  const input=request('sheet'),prepared=prepareSheetRequest(input),sourceBytes=Buffer.byteLength(JSON.stringify(input.project)),inputBytes=prepared.images.reduce((total,image)=>total+image.byteLength,0);
  const limited=await setup(t,'sheet',{maxStoredBytes:50*1024*1024+256*1024+inputBytes+sourceBytes-1});
  await assert.rejects(limited.service.start(input),error=>error.statusCode===507&&/storage limit/.test(error.message));assert.equal(posts(limited.calls).length,0);
  const failed=await setup(t,'sheet',{renameFile:async(from,to)=>{if(to.endsWith('.project.asun'))throw Object.assign(new Error('Disk full'),{code:'ENOSPC'});return rename(from,to);}});
  await assert.rejects(failed.service.start(input),error=>error.statusCode===507&&/No generation request was sent/.test(error.message));
  const result=await failed.service.job(input.requestId);assert.equal(result.status,'failed');assert.equal(result.sourceProjectAvailable,false);await failed.service.start(input);assert.equal(posts(failed.calls).length,0);
});

test('job polling waits for an in-progress completion write instead of holding a Windows read lock',async t=>{
  let releaseProvider,releaseWrite,notifyCompleting;
  const providerGate=new Promise(resolve=>{releaseProvider=resolve;}),writeGate=new Promise(resolve=>{releaseWrite=resolve;}),completing=new Promise(resolve=>{notifyCompleting=resolve;});
  t.after(()=>{releaseProvider();releaseWrite();});
  const {service,calls}=await setup(t,'image',{
    reply:async()=>{await providerGate;return json({data:[{b64_json:pixel.toString('base64')}]});},
    renameFile:async(from,to)=>{if(to.endsWith('.json')&&JSON.parse(await readFile(from,'utf8')).status==='completed'){notifyCompleting();await writeGate;}return rename(from,to);},
  });
  const input=request();await service.start(input);releaseProvider();await completing;
  let settled=false;const poll=service.job(input.requestId).finally(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(settled,false);
  releaseWrite();assert.equal((await poll).status,'completed');assert.equal(posts(calls).length,1);
});

for(const mode of ['image','sheet'])test(`${mode} source endpoint requires its private token, same-origin access and a valid job ID`,async t=>{
  const {service,calls}=await setup(t,mode),input=request(mode);await service.start(input);await finished(service,input.requestId);
  const inert={dispose(){}};
  const server=createServer({[mode==='image'?'images':'sheets']:service,[mode==='image'?'sheets':'images']:inert,detection:inert,imageSearch:inert});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port,route=`/api/${mode==='image'?'images':'sheets'}/jobs/${input.requestId}/project`,headers={[`X-Asun-${mode}-Token`]:service.token};
  assert.equal((await fetch(base+route)).status,403);
  assert.equal((await fetch(base+route,{headers:{...headers,Origin:'https://foreign.invalid'}})).status,403);
  assert.equal((await fetch(base+route,{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await fetch(base+route,{method:'POST',headers})).status,405);
  const response=await fetch(base+route,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(await response.json(),{project:input.project});
  assert.equal((await fetch(base+route.replace(input.requestId,'invalid'),{headers})).status,400);
  assert.equal((await fetch(base+`/data/${mode}-jobs/${input.requestId}.project.asun`)).status,404);assert.equal(posts(calls).length,1);
});
