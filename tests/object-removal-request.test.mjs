import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {newProject,addRaster,addReference,addText,attachObjectRegion,linkReferences,updateLabelComment,updateLayer,parseProject,serializeProject} from '../public/core.mjs';
import {objectRemovalRequest,applyObjectRemovalIntent} from '../public/object-removal-request.mjs';
import {imageGenerationPlan,buildImageGenerationPrompt} from '../public/image-generation-request.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {createDesktopGeneration} from '../public/desktop-sheet-generation.mjs';

const photo={name:'Original.png',width:1,height:1,source:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='};
function nativePreview(){
  const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(kind,bytes)=>{const content=Buffer.concat([Buffer.from(kind),bytes]),length=Buffer.alloc(4),check=Buffer.alloc(4);length.writeUInt32BE(bytes.length);check.writeUInt32BE(crc(content));return Buffer.concat([length,content,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(1024);header.writeUInt32BE(1024,4);header[8]=8;header[9]=2;
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(1024*(1024*3+1)))),chunk('IEND',Buffer.alloc(0))]);
  return {name:'Native canvas preview.png',width:1024,height:1024,source:'data:image/png;base64,'+bytes.toString('base64')};
}
function fixture(){
  let project=addRaster(newProject(),photo).project;
  project.prompt='Make the whole sky purple';
  project=addReference(project,{...photo,name:'Unrelated appearance.png'});
  const label=addText(project,{content:'1',x:0,y:0,width:1,height:1,fontSize:1});
  project=attachObjectRegion(label.project,label.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:project.layers[0].id,sourceWidth:1,sourceHeight:1,mask:{width:1,height:1,counts:[0,1]}});
  project=linkReferences(project,label.layerId,[project.references[0].id]);
  project=updateLabelComment(project,label.layerId,'Replace this object with a red bird');
  const other=addText(project,{content:'2',x:0,y:0,width:1,height:1,fontSize:1});
  project=updateLabelComment(other.project,other.layerId,'Turn another object into gold');
  return {project,labelId:label.layerId,otherId:other.layerId};
}

test('removal keeps the full editable source but limits the provider plan to the selected object',()=>{
  const {project,labelId,otherId}=fixture(),before=structuredClone(project);
  const snapshot=objectRemovalRequest(project,[labelId]);
  assert.deepEqual(project,before);
  assert.deepEqual(snapshot.references,project.references);
  assert.equal(snapshot.prompt,project.prompt);
  assert.ok(snapshot.layers.find(layer=>layer.id===otherId));
  assert.deepEqual(parseProject(serializeProject(snapshot)),snapshot);
  const plan=imageGenerationPlan(snapshot);
  assert.deepEqual(plan.areas.map(area=>area.id),[labelId]);
  assert.equal(plan.references.length,0);
  assert.equal(plan.imageCount,3);
  assert.deepEqual(plan.maskAreas[0].selection.mask,project.layers.find(layer=>layer.id===labelId).objectRegion.mask);
  assert.deepEqual(plan.compositionLayers.map(layer=>layer.id),[project.layers[0].id]);
  const prompt=buildImageGenerationPrompt(snapshot);
  assert.match(prompt,/Remove the object inside this selection completely/);
  assert.match(prompt,/Rebuild the background naturally/);
  assert.doesNotMatch(prompt,/purple|red bird|into gold|Unrelated appearance/);
  assert.deepEqual(snapshot.imageEditRequest.labelIds,[labelId]);
});

test('server preflight receives composition, guide and selected mask, with the selected model and quality unchanged',()=>{
  const {project,labelId}=fixture();project.width=1024;project.height=1024;
  const snapshot=objectRemovalRequest(project,[labelId]),preview=nativePreview();
  const request={requestId:randomUUID(),model:'gpt-image-2.5-sunburst',quality:'max',project:snapshot,composition:preview,guide:preview,areaMasks:[{id:labelId,image:preview}]};
  const prepared=prepareImageRequest(request);
  assert.equal(prepared.model,request.model);assert.equal(prepared.quality,'max');
  assert.equal(prepared.size,'1024x1024');assert.equal(prepared.images.length,3);
  assert.deepEqual(prepared.inputRoles.map(role=>role.role),['current composition','canvas annotation guide','area selection mask']);
  assert.match(prepared.prompt,/Remove the object/);assert.doesNotMatch(prepared.prompt,/purple|red bird|into gold/);
  assert.throws(()=>prepareImageRequest({...request,areaMasks:[]}),/Area selection masks/);
  assert.throws(()=>prepareImageRequest({...request,quality:'unsupported'}),/quality/i);
});

test('removal rejects stale, hidden, malformed and sketch selections instead of generating a different request',()=>{
  const {project,labelId}=fixture();
  for(const ids of [[],['missing'],[labelId,labelId]])assert.throws(()=>objectRemovalRequest(project,ids),/Select|Choose/);
  assert.throws(()=>objectRemovalRequest(updateLayer(project,labelId,{visible:false}),[labelId]),/visible selection/);
  assert.throws(()=>objectRemovalRequest(updateLayer(project,project.layers[0].id,{visible:false}),[labelId]),/visible selection/);
  assert.throws(()=>objectRemovalRequest(updateLayer(project,labelId,{x:50}),[labelId]),/visible selection/);
  assert.throws(()=>objectRemovalRequest(updateLayer(project,project.layers[0].id,{x:50}),[labelId]),/visible selection/);
  assert.throws(()=>imageGenerationPlan({...project,imageEditRequest:{version:2,action:'remove-fill',labelIds:[labelId]}}),/unsupported/);
  const sketch={...project,sketch:{version:1,background:'#ffffff',surfaceLayerId:project.layers[0].id}};
  assert.throws(()=>objectRemovalRequest(sketch,[labelId]),/sketch/);
  assert.throws(()=>applyObjectRemovalIntent({...sketch,imageEditRequest:{version:1,action:'remove-fill',labelIds:[labelId]}}),/sketch/);
});

test('ordinary image requests retain all instructions and references',()=>{
  const {project}=fixture();
  assert.equal(applyObjectRemovalIntent(project),project);
  const plan=imageGenerationPlan(project);
  assert.equal(plan.references.length,1);assert.equal(plan.areas.length,2);
  assert.match(buildImageGenerationPrompt(project),/purple/);
});

test('generation bridge submits the complete source snapshot while preparing only removal input images',async()=>{
  const {project,labelId}=fixture(),before=structuredClone(project),posts=[];
  let preparedSource;
  const response=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
  const bridge=createDesktopGeneration({kind:'image',endpoint:'/api/images',storageKey:'test-removal-'+randomUUID(),pollMs:0,editor:{snapshot:()=>structuredClone(project)},prepareInput:async snapshot=>{
    preparedSource=snapshot;
    return {project:applyObjectRemovalIntent(snapshot),composition:photo,guide:photo,areaMasks:[{id:labelId,image:photo}]};
  },fetchImpl:async(url,init={})=>{
    if(url.endsWith('/status'))return response({authenticated:true,token:'fixture-only',models:[{id:'gpt-image-2.5-sunburst',available:true}]});
    if(init.method==='POST'){const payload=JSON.parse(init.body);posts.push(payload);return response({id:payload.requestId,status:'running'});}
    return response({id:posts[0].requestId,status:'completed',model:'gpt-image-2.5-sunburst',image:photo});
  }});
  await bridge.prepare();bridge.selectQuality('xhigh');
  await bridge.generate({prepareProject:snapshot=>objectRemovalRequest(snapshot,[labelId])});
  assert.equal(posts.length,1);assert.equal(posts[0].quality,'xhigh');
  assert.deepEqual(posts[0].project,preparedSource);
  assert.equal(posts[0].project.prompt,project.prompt);
  assert.deepEqual(posts[0].project.references,project.references);
  assert.deepEqual(posts[0].project.imageEditRequest.labelIds,[labelId]);
  assert.deepEqual(project,before);
});
