import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {newProject,addRaster,addReference,addText,attachObjectRegion,linkReferences,updateLayer,
  removeReference,saveVariant,restoreVariant,serializeProject,parseProject,History} from '../public/core.mjs';
import {getSceneConsistency,groupPreset,sceneConsistencyInstructions,sceneConsistencyPreflight} from '../public/scene-consistency.mjs';
import {getBlockoutReview} from '../public/blockout-review-settings.mjs';
import {imageGenerationPlan,buildImageGenerationPrompt} from '../public/image-generation-request.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {referencePackWorkflow,referencePackAgentInstructions} from '../public/reference-pack-workflow.mjs';
import {objectRemovalRequest} from '../public/object-removal-request.mjs';

test('saved scene rules include an unlinked look seed without a typed global prompt',()=>{
  const project=enable(addReference(fixture(),image('TARGET_SEED.png')));project.prompt='';
  const plan=imageGenerationPlan(project);assert.equal(plan.references.length,1);
  assert.equal(plan.references[0].name,'TARGET_SEED.png');
});

test('a continuity image linked to a visible area is excluded from its appearance map',()=>{
  let project=enable(addReference(fixture(),image('Previous.png')));project.prompt='';
  const label=addText(project,{content:'2',x:0,y:0,width:1,height:1,fontSize:1});project=linkReferences(label.project,label.layerId,[project.references[0].id]);
  project.sceneConsistency.continuity.referenceIds=[project.references[0].id];
  const prompt=buildImageGenerationPrompt(project),areaMap=JSON.parse(prompt.split('Numbered area instructions and reference mapping:\n')[1].split('\n\nReference photo notes:')[0]);
  assert.deepEqual(areaMap[0].referenceIds,[]);
});

test('remove and fill retains native scene rules while the specific provider plan omits them',()=>{
  let project=enable(addReference(fixture(),image('Previous.png')));
  project.sceneConsistency.continuity.referenceIds=[project.references[0].id];
  const label=addText(project,{content:'1',x:0,y:0,width:1,height:1,fontSize:1});
  project=attachObjectRegion(label.project,label.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:project.layers[0].id,sourceWidth:4,sourceHeight:4,mask:{width:1,height:1,counts:[0,1]}});
  const snapshot=objectRemovalRequest(project,[label.layerId]),plan=imageGenerationPlan(snapshot);
  assert.deepEqual(snapshot.sceneConsistency,project.sceneConsistency);
  assert.equal(plan.project.sceneConsistency,undefined);assert.deepEqual(plan.references,[]);
  assert.match(buildImageGenerationPrompt(snapshot),/Remove the object inside this selection/);
});

// Small valid PNGs keep the integration tests deterministic and entirely local.
function image(name='Original MAIN.png',width=4,height=4,red=180) {
  const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(type,bytes)=>{const data=Buffer.concat([Buffer.from(type),bytes]),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(bytes.length);checksum.writeUInt32BE(crc(data));return Buffer.concat([length,data,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const rows=Buffer.alloc(height*(1+width*3));
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)rows[y*(1+width*3)+1+x*3]=red;
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
  return{name,width,height,source:'data:image/png;base64,'+bytes.toString('base64')};
}
function fixture(width=4,height=4){const project=addRaster(newProject(),image('Original MAIN.png',width,height)).project;project.prompt='Use synthetic night-scene materials.';return project;}
function enable(project){
  // These scene-contract fixtures intentionally preserve their square/wide MAIN,
  // rather than the remembered default aspect used for new compositions.
  project.imageOutput={version:1,aspect:'source'};
  project.sceneConsistency={...getSceneConsistency(project),enabled:true,mainAssetId:project.original.assetId};return project;
}
function object(overrides={}){return{id:'2A',label:'2',name:'Far-lane vehicle',kind:'car',direction:'left',view:'top-rear-three-quarter',cardRank:'from-main',cardSuit:'from-main',visibility:'partial',overlap:'Behind foreground white car',notes:'Keep both visible wheel contact points.',...overrides};}
function request(project,extra={}){return{requestId:randomUUID(),project,model:'gpt-image-2.5-sunburst',quality:'high',composition:image('Current composition.png',project.width,project.height,40),...extra};}

test('scene rules survive native save, undo/redo, and variants without leaking into older variants',()=>{
  let project=saveVariant(fixture(),'Before consistency');
  const history=new History(project);enable(project);
  project.sceneConsistency.groups=[{label:'2',...groupPreset('car'),expectedObjectCount:10}];
  project.sceneConsistency.objects=[object()];
  project.sceneConsistency.continuity={shot:'Paris street',frame:'20',camera:'Camera_Main',previousFrame:'1',referenceIds:[],changes:'Camera moves upward slightly.'};
  const expected=structuredClone(project.sceneConsistency);
  history.commit(project,'Scene rules');
  assert.equal(history.undo().sceneConsistency,undefined);
  assert.deepEqual(history.redo().sceneConsistency,expected);
  project=saveVariant(project,'Frame 20 rules');
  const reopened=parseProject(serializeProject(project));
  assert.deepEqual(reopened.sceneConsistency,expected);
  assert.equal(restoreVariant(reopened,reopened.variants[0].id).sceneConsistency,undefined);
  assert.deepEqual(restoreVariant(reopened,reopened.variants[1].id).sceneConsistency,expected);
  reopened.sceneConsistency.objects[0].direction='right';
  assert.equal(history.project.sceneConsistency.objects[0].direction,'left');
});

test('deleting a continuity photo clears its links from current and saved variants',()=>{
  let project=enable(addReference(fixture(),image('Previous approved frame.png',4,4,10)));
  const referenceId=project.references[0].id;
  project.sceneConsistency.continuity.referenceIds=[referenceId];
  project=saveVariant(project,'With prior frame');
  const removed=removeReference(project,referenceId);
  assert.deepEqual(removed.sceneConsistency.continuity.referenceIds,[]);
  assert.deepEqual(removed.variants[0].sceneConsistency.continuity.referenceIds,[]);
  assert.deepEqual(project.sceneConsistency.continuity.referenceIds,[referenceId]);
  assert.doesNotThrow(()=>parseProject(serializeProject(removed)));
});

test('scene consistency includes original MAIN and its exact aspect without enabling paid review',()=>{
  const project=enable(fixture(8,4)),before=structuredClone(project);
  // The editable canvas may have changed; the explicit original remains authority.
  project.width=4;project.height=8;
  const prepared=prepareImageRequest(request(project));
  assert.equal(prepared.review,undefined);
  assert.equal(getBlockoutReview(project).enabled,false);
  assert.equal(prepared.size,'1536x768');
  assert.equal(prepared.images.length,2);
  assert.equal(prepared.images[1].bytes.toString('base64'),before.assets[before.original.assetId].source.split(',')[1]);
  assert.equal(prepared.inputRoles.filter(role=>/structure authority/.test(role.role)).length,1);
  assert.match(prepared.prompt,/SCENE CONSISTENCY MAIN: Input 2/);
  assert.match(prepared.prompt,/exact aspect ratio/);
  assert.equal(prepared.model,'gpt-image-2.5-sunburst');assert.equal(prepared.quality,'high');
  assert.deepEqual(project.sceneConsistency,before.sceneConsistency);
});

test('identical composition and MAIN bytes are reused and conflicting structural authorities fail',()=>{
  let project=enable(fixture());
  const prepared=prepareImageRequest(request(project,{composition:image()}));
  assert.equal(prepared.images.length,1);
  assert.match(prepared.prompt,/SCENE CONSISTENCY MAIN: Input 1/);
  project=addRaster(project,image('Different frame.png',4,4,90)).project;
  const other=Object.keys(project.assets).find(id=>id!==project.original.assetId);
  project.blockoutReview={...getBlockoutReview(project),enabled:true,assetId:other};
  assert.throws(()=>prepareImageRequest(request(project)),/same original image/);
});

test('continuity references are included even without global prompt and cannot become current geometry or mapped identity',()=>{
  let project=enable(addReference(fixture(),image('Previous approved frame.png',4,4,10)));
  project.prompt='';const referenceId=project.references[0].id;
  const added=addText(project,{content:'9',x:1,y:1,width:2,height:2,fontSize:1});
  project=linkReferences(added.project,added.layerId,[referenceId]);
  project=updateLayer(project,added.layerId,{visible:false});
  project.sceneConsistency.continuity.referenceIds=[referenceId];
  const plan=imageGenerationPlan(project),prepared=prepareImageRequest(request(project));
  assert.equal(plan.references.length,1);
  const role=prepared.inputRoles.find(entry=>entry.referenceId===referenceId);
  assert.equal(role.role,'previous frame continuity reference');
  assert.equal(role.scope,'continuity only');assert.deepEqual(role.labels,[]);
  assert.match(role.use,/Never copy this prior frame camera/);
  assert.match(prepared.prompt,/previous frame continuity only; never current geometry/);
  assert.match(prepared.prompt,/current MAIN camera/);
  assert.ok(prepared.images.some(entry=>entry.bytes.toString('base64')===project.references[0].source.split(',')[1]));
});

test('physical object counts and individual rear views stay distinct from disconnected selection counts',()=>{
  let project=enable(addReference(fixture(),image('Car appearance.png',4,4,60)));
  const added=addText(project,{content:'2',x:1,y:1,width:2,height:2,fontSize:1});
  project=linkReferences(added.project,added.layerId,[project.references[0].id]);
  project=attachObjectRegion(project,added.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:project.layers[0].id,sourceWidth:4,sourceHeight:4,mask:{width:4,height:4,counts:[0,1,2,1,8,1,2,1]},group:{areaCount:4}});
  // Selected-area requests must keep a supported native canvas size. Retain the
  // original 4x4 source/mask fixture and its disconnected-selection semantics.
  project.width=1024;project.height=1024;
  project.sceneConsistency.groups=[{label:'2',...groupPreset('car'),expectedObjectCount:10}];
  project.sceneConsistency.objects=[object(),object({id:'2B',view:'rear-three-quarter',visibility:'cropped',overlap:'Behind 2A'})];
  const prepared=prepareImageRequest(request(project,{guide:image('Numbered guide.png',1024,1024),areaMasks:[{id:added.layerId,image:image('Mask.png',1024,1024,255)}]}));
  assert.match(prepared.prompt,/"groupAreaCount": 4/);
  assert.match(prepared.prompt,/"expectedObjectCount":10/);
  assert.match(prepared.prompt,/"id":"2A".*"view":"top-rear-three-quarter"/);
  assert.match(prepared.prompt,/"id":"2B".*"view":"rear-three-quarter"/);
  assert.match(prepared.prompt,/selection-mask regions is never the physical object count/);
  assert.equal(sceneConsistencyPreflight(project).errors.length,0);
  assert.ok(sceneConsistencyPreflight(project).warnings.some(message=>/expects 10 physical objects but lists 2/.test(message)));
});

test('specific card identity and rule changes reach generation and alter frozen request fingerprints',()=>{
  const project=enable(fixture());
  project.sceneConsistency.groups=[{label:'9',...groupPreset('card'),expectedObjectCount:5}];
  project.sceneConsistency.objects=[object({id:'9A',label:'9',name:'Queen of clubs',kind:'card',direction:'from-main',view:'from-main',cardRank:'Q',cardSuit:'clubs',visibility:'full',overlap:'Behind die',notes:''})];
  const first=prepareImageRequest(request(project));
  assert.match(first.prompt,/Preserve each card’s individual rank, suit/);
  assert.match(first.prompt,/Never turn all cards into/);
  assert.match(first.prompt,/"cardRank":"Q","cardSuit":"clubs"/);
  project.sceneConsistency.objects[0].cardSuit='hearts';
  const second=prepareImageRequest(request(project));
  assert.notEqual(first.fingerprint,second.fingerprint);
  assert.match(second.prompt,/"cardRank":"Q","cardSuit":"hearts"/);
});

test('disabled scene settings leave ordinary prompts, image roles and request identity unchanged',()=>{
  const project=fixture(),first=prepareImageRequest(request(project)),plainPrompt=buildImageGenerationPrompt(project);
  project.sceneConsistency=getSceneConsistency(project);
  project.sceneConsistency.groups=[{label:'2',...groupPreset('car'),expectedObjectCount:10}];
  project.sceneConsistency.global.notes='Dormant rules must not affect this ordinary image request.';
  project.sceneConsistency.continuity.referenceIds=['stale-disabled-reference'];
  const disabled=prepareImageRequest(request(project));
  assert.equal(disabled.fingerprint,first.fingerprint);
  assert.equal(disabled.prompt,first.prompt);
  assert.deepEqual(disabled.inputRoles,first.inputRoles);
  assert.equal(buildImageGenerationPrompt(project),plainPrompt);
});

test('missing MAIN, missing continuity sources and incompatible aspect ratios fail before a request can be submitted',()=>{
  const project=enable(fixture());
  project.sceneConsistency.mainAssetId='missing';
  assert.throws(()=>prepareImageRequest(request(project)),/selected original MAIN/);
  project.sceneConsistency.mainAssetId=project.original.assetId;
  project.sceneConsistency.continuity.referenceIds=['missing-prior-frame'];
  assert.throws(()=>prepareImageRequest(request(project)),/Continuity reference.*missing/);
  project.sceneConsistency.continuity.referenceIds=[];
  const wide=enable(fixture(8,4));
  assert.throws(()=>prepareImageRequest(request(wide,{model:'gpt-image-1.5'})),/cannot keep.*exact aspect/);
});

test('portable instructions use selected scene MAIN with review off and preserve rules without claiming approval',()=>{
  let project=fixture();
  project=addRaster(project,image('Frame 20 MAIN.png',4,4,90)).project;
  enable(project);
  project.sceneConsistency.mainAssetId=Object.keys(project.assets).find(id=>id!==project.original.assetId);
  project.sceneConsistency.groups=[{label:'9',...groupPreset('card'),expectedObjectCount:5}];
  project.sceneConsistency.objects=[object({id:'9A',label:'9',name:'Queen of clubs',kind:'card',cardRank:'Q',cardSuit:'clubs'})];
  const records=Object.values(project.assets).map((asset,index)=>({assetId:asset.id,path:`originals/main/frame-${index}.png`,sha256:String(index+1).repeat(64),width:asset.width,height:asset.height,mimeType:'image/png',byteLength:100}));
  const mapping={project:{name:project.name,width:project.width,height:project.height,prompt:project.prompt},cleanMain:records[0],mainImages:records,numbers:[],unassignedReferences:[],
    sceneConsistency:structuredClone(project.sceneConsistency),sceneConsistencyInstructions:sceneConsistencyInstructions(project),sceneConsistencyPreflight:sceneConsistencyPreflight(project)};
  mapping.agentWorkflow=referencePackWorkflow(project,mapping);
  const text=referencePackAgentInstructions(mapping);
  assert.equal(mapping.agentWorkflow.source.image.assetId,project.sceneConsistency.mainAssetId);
  assert.equal(mapping.agentWorkflow.source.image.path,records[1].path);
  assert.equal(mapping.cleanMain.assetId,project.original.assetId);
  assert.equal(mapping.agentWorkflow.reviewStatus,'not-run');
  assert.deepEqual(mapping.agentWorkflow.reviewer,{model:'gpt-6-astra',reasoningEffort:'max',separateAgentRequired:true,allowSubstitution:false});
  assert.match(text,/SCENE CONSISTENCY CONTRACT/);
  assert.match(text,/"cardRank":"Q","cardSuit":"clubs"/);
  assert.match(text,/does not execute any agent, generate an image, or certify approval/);
  assert.match(text,/cannot certify exact Blender world dimensions/);
  assert.equal(getBlockoutReview(project).enabled,false);
});
