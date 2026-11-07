import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {createDesktopSheetService,prepareSheetRequest} from '../desktop-sheet-service.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';

let server,browser,page,fixture;
const errors=[],model='gpt-image-2.5-sunburst',pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const dataBytes=image=>Buffer.from(image.source.split(',')[1],'base64');
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const checks=['framing','camera','placement','scale','orientation','occlusion','content','appearance'];
function reviewResponse(decision='accept'){
  const verdict={decision,summary:'Fixture visual verdict.',checks:checks.map(id=>({id,status:'pass',evidence:`Fixture ${id} evidence.`,correction:''})),corrections:[],limitations:['Raster review does not certify numerical geometry.']};
  if(decision==='reject'){Object.assign(verdict.checks[3],{status:'fail',evidence:'The subject is too large.',correction:'Restore the subject scale.'});verdict.corrections=[{checkId:'scale',instruction:'Restore the subject scale.'}];}
  return {id:'resp_fixture',status:'completed',model:'gpt-6-astra',reasoning:{effort:'max'},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(verdict)}]}]};
}
const input=()=>({...structuredClone(fixture.input),requestId:randomUUID(),model,quality:'max'});
const flattenRoles=roles=>roles.flatMap(role=>role.tiles?role.tiles.flatMap(tile=>tile.roles):[role]);
const generationCalls=calls=>calls.filter(call=>call.url.endsWith('/images/edits'));
before(async()=>{
  const disconnected={dispose(){},status:async()=>({configured:false,authenticated:false,models:[]})};
  server=createServer({images:disconnected,sheets:disconnected,detection:{...disconnected,token:'overflow-test'}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true});page=await browser.newPage();
  const base=`http://127.0.0.1:${server.address().port}`;
  await page.route('**/*',route=>new URL(route.request().url()).origin===base&&route.request().method()==='GET'?route.continue():route.abort());
  page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/health');
  fixture=await page.evaluate(async()=>{
    const c=await import('/core.mjs'),requests=await import('/image-generation-request.mjs');
    const image=(name,color,width=96,height=64)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);ctx.fillStyle='#121212';ctx.fillRect(5,5,8,11);return {name,width,height,source:canvas.toDataURL('image/png')};};
    const base=c.addRaster(c.newProject(),image('Original blockout.png','#80a0c0'));let project=c.updateLayer(base.project,base.layerId,{brightness:80});
    project.prompt='Preserve the camera and arrangement. Apply the mapped appearance photos and global materials.';
    for(let i=0;i<20;i++)project=c.addReference(project,image(`Reference ${i+1}.png`,`rgb(${30+i*7},${80+i*3},${180-i*4})`,48+i,40));
    for(let i=0;i<2;i++){
      const reference=project.references[i],annotated=c.addDrawing(c.referenceProject(reference),{mode:'pencil',color:'#ff0000',size:3,points:[[8,12],[25,12]]});
      project=c.updateReferenceAnnotations(project,reference.id,annotated.project.layers.slice(1));
      const label=c.addText(project,{content:String(i+1),x:10+i*30,y:10,width:15,height:16,fontSize:10,color:'#ff0000'});
      project=c.updateLabelComment(c.linkReferences(label.project,label.layerId,[reference.id]),label.layerId,`Use appearance reference ${i+1} only in this selected area.`);
      project=c.attachObjectRegion(project,label.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:base.layerId,sourceWidth:96,sourceHeight:64,mask:{width:4,height:4,counts:i?[5,2,9]:[0,2,14]}});
    }
    project.blockoutReview={version:1,enabled:true,model:'gpt-6-astra',effort:'max',maxAttempts:2,assetId:project.original.assetId,authorizedChanges:''};
    const before=JSON.stringify(project),input=await requests.buildImageGenerationInput(project);
    window.overflowInput=input;
    return {input,unchanged:JSON.stringify(project)===before};
  });
});
after(async()=>{try{assert.deepEqual(errors,[]);}finally{await browser?.close();if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}});

async function setup(t,{mode='image',decisions=['accept'],rejectProvider=false}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'asun-overflow-integration-')),calls=[];let reviews=0;
  const fetchImpl=async(url,init={})=>{
    calls.push({url,init});
    if(url.endsWith('/models'))return json({data:[{id:model},{id:'gpt-6-astra'}]});
    if(url.endsWith('/responses'))return json(reviewResponse(decisions[Math.min(reviews++,decisions.length-1)]));
    assert.ok(url.endsWith('/images/edits'),'Only mocked image edits and review requests are permitted');
    return rejectProvider?json({error:{message:'Fixture provider rejects this request without fallback.'}},400):json({data:[{b64_json:pixel}]});
  };
  const service=createDesktopSheetService({directory,label:mode,prepareRequest:mode==='image'?prepareImageRequest:prepareSheetRequest,getKey:()=> 'sk-overflow-test-not-a-credential',fetchImpl});
  t.after(async()=>{service.dispose();const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('asun-overflow-integration-'));await rm(resolved,{recursive:true,force:true});});
  return {service,calls};
}
async function done(service,id){for(let i=0;i<500;i++){const result=await service.job(id);if(!['queued','running'].includes(result.status))return result;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Mock generation did not finish.');}

test('real rendered overflow includes every reference, guide and mask while preserving standalone composition and blockout',()=>{
  const request=input(),prepared=prepareImageRequest(request),roles=flattenRoles(prepared.inputRoles);
  assert.equal(fixture.unchanged,true);assert.equal(request.project.references.length,20);assert.equal(request.referencePreviews.length,2);assert.equal(request.areaMasks.length,2);
  assert.ok(prepared.inputPacking.logicalInputCount>16);assert.ok(prepared.images.length<=16);assert.ok(prepared.inputPacking.boardCount>0);
  assert.equal(prepared.quality,'max');assert.equal(prepared.model,model);
  assert.deepEqual(roles.filter(role=>role.role==='original reference photo').map(role=>role.referenceId).sort(),request.project.references.map(ref=>ref.id).sort());
  assert.deepEqual(roles.filter(role=>role.role==='reference annotation guide').map(role=>role.referenceId).sort(),request.referencePreviews.map(ref=>ref.id).sort());
  assert.deepEqual(roles.filter(role=>role.role==='area selection mask').map(role=>role.areaId).sort(),request.areaMasks.map(mask=>mask.id).sort());
  const composition=prepared.inputRoles.find(role=>role.role==='current composition'),blockout=prepared.inputRoles.find(role=>role.role==='original Blender blockout — structure authority');
  assert.ok(composition&&!composition.tiles);assert.ok(blockout&&!blockout.tiles);
  assert.deepEqual(prepared.images[composition.image-1].bytes,dataBytes(request.composition));
  assert.deepEqual(prepared.images[blockout.image-1].bytes,dataBytes(request.project.assets[request.project.original.assetId]));
  assert.equal(prepared.review.sourceIndex,blockout.image);assert.equal(prepared.review.source.sha256,prepared.images[blockout.image-1].sha256);
  assert.match(prepared.prompt,/mask tile/);assert.match(prepared.prompt,/reduced reference copies/);
});

test('overflow Sunburst Max provider request, history, native source and Astra retry preserve all frozen board mappings',async t=>{
  const request=input(),prepared=prepareImageRequest(request),{service,calls}=await setup(t,{decisions:['reject','accept']});
  await service.start(request);const job=await done(service,request.requestId);
  assert.equal(job.status,'completed',job.message);assert.equal(job.review.status,'accepted');assert.equal(job.attempt,2);
  const posts=generationCalls(calls);assert.equal(posts.length,2);
  for(const call of posts){
    assert.equal(call.init.body.get('model'),model);assert.equal(call.init.body.get('quality'),'max');
    const files=call.init.body.getAll('image[]');assert.equal(files.length,prepared.images.length);assert.ok(files.length<=16);
    for(let index=0;index<files.length;index++)assert.deepEqual(Buffer.from(await files[index].arrayBuffer()),prepared.images[index].bytes);
  }
  assert.deepEqual(job.settings.inputPacking,prepared.inputPacking);
  assert.deepEqual(job.settings.inputs.flatMap(entry=>entry.roles),prepared.inputRoles);
  assert.deepEqual((await service.project(request.requestId)).project,request.project,'Redo retains all original sources and editable annotations');
  const history=await service.history();assert.equal(history.items[0].id,request.requestId);
  for(const entry of job.settings.inputs)assert.equal(sha((await service.input(request.requestId,entry.index)).bytes),entry.sha256);
  for(const attempt of job.attempts){
    assert.equal(attempt.settings.quality,'max');assert.deepEqual(attempt.settings.inputs,job.settings.inputs);
    const reviewImages=attempt.review.request.images,source=reviewImages[0];
    assert.equal(source.sha256,prepared.review.source.sha256);assert.ok(source.generationInputs.some(item=>item.index===prepared.review.sourceIndex));
    const mappings=reviewImages.flatMap(image=>image.generationInputs||[]).sort((a,b)=>a.index-b.index);
    assert.deepEqual(mappings,job.settings.inputs.map(entry=>({index:entry.index,roles:entry.roles})));
  }
});

test('provider rejection is shown honestly without dropping references, lowering Max or automatically retrying',async t=>{
  const request=input(),{service,calls}=await setup(t,{rejectProvider:true});
  await service.start(request);const job=await done(service,request.requestId);
  assert.equal(job.status,'failed');assert.match(job.message,/Fixture provider rejects/);assert.equal(job.settings.quality,'max');
  assert.equal(generationCalls(calls).length,1);assert.equal(calls.filter(call=>call.url.endsWith('/responses')).length,0);
  await service.start(request);assert.equal(generationCalls(calls).length,1,'Reopening the same failed request never submits it again');
});

test('missing, extra, duplicate and incorrectly sized boards fail before any provider call',async t=>{
  const request=input(),{service,calls}=await setup(t),first=request.inputBoards[0];
  const malformed=[[],[...request.inputBoards,{...first,slot:99}],[...request.inputBoards.slice(0,-1),request.inputBoards[0]],request.inputBoards.map((board,index)=>index?board:{...board,image:request.composition})];
  for(const inputBoards of malformed)await assert.rejects(service.start({...request,requestId:randomUUID(),inputBoards}),/Reference boards|reference board/);
  assert.equal(calls.length,0,'Malformed layouts are rejected before catalog checks or paid requests');
});

test('character/item sheet overflow retains primary source, all detail photos and annotated guides at Max',async t=>{
  const built=await page.evaluate(async()=>{
    const {withSheetPreset}=await import('/sheet-preset.mjs'),{buildSheetGenerationInput}=await import('/sheet-generation-input.mjs');
    const project=withSheetPreset(window.overflowInput.project,{active:true,subject:'item',views:7,referenceIds:window.overflowInput.project.references.map(ref=>ref.id)});
    return buildSheetGenerationInput(project);
  });
  const request={...built,requestId:randomUUID(),model,quality:'max'},prepared=prepareSheetRequest(request),{service,calls}=await setup(t,{mode:'sheet'});
  assert.ok(prepared.images.length<=16&&prepared.inputPacking.boardCount>0);
  const primary=prepared.inputRoles.find(role=>role.role==='primary subject original');assert.ok(primary&&!primary.tiles);
  assert.deepEqual(prepared.images[primary.image-1].bytes,dataBytes(request.project.assets[request.project.original.assetId]));
  const roles=flattenRoles(prepared.inputRoles);assert.deepEqual(roles.filter(role=>role.role==='detail reference original').map(role=>role.photoId).sort(),request.project.references.map(ref=>ref.id).sort());
  await service.start(request);const job=await done(service,request.requestId);assert.equal(job.status,'completed',job.message);
  const posts=generationCalls(calls);assert.equal(posts.length,1);assert.equal(posts[0].init.body.get('quality'),'max');assert.equal(posts[0].init.body.getAll('image[]').length,prepared.images.length);
  assert.deepEqual(job.settings.inputs.flatMap(entry=>entry.roles),prepared.inputRoles);
});
