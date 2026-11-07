import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addReference,addRaster,updateLayer,addText,linkReferences} from '../public/core.mjs';
import {resolveImageOutput,exactImageOutputSize,validateImageOutput,checkImageOutputSize} from '../public/image-output-settings.mjs';
import {blockoutReviewDisplay} from '../public/generation-details.mjs';
const model='gpt-image-2.5-sunburst';
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=';
const photo=(name,width,height)=>({name,width,height,source:pixel});

test('empty canvas follows first global reference shape, not blank default or later reference',()=>{
  let project=addReference(newProject(),photo('Blender portrait.png',2160,3840));
  project=addReference(project,photo('Appearance.png',1536,1024));project.prompt='Preserve 9:16';
  project.imageOutput={version:1,aspect:'source'};
  const before=structuredClone(project),result=resolveImageOutput(project,model);
  assert.equal(result.size,'864x1536');assert.equal(result.source,'reference');assert.equal(result.sourceName,'Blender portrait.png');assert.equal(result.ratio,'9:16');assert.deepEqual(project,before);
});
test('actual composition controls auto framing; hidden or off-canvas images do not',()=>{
  let project=addRaster(newProject(1600,1000),photo('Composition.png',1600,1000)).project;
  project=addReference(project,photo('Portrait appearance.png',2160,3840));
  project.imageOutput={version:1,aspect:'source'};
  assert.equal(resolveImageOutput(project,model).size,'1536x960');
  project=updateLayer(project,project.layers[0].id,{visible:false});
  assert.equal(resolveImageOutput(project,model).size,'864x1536');
  project=updateLayer(project,project.layers[0].id,{visible:true,x:99999});
  assert.equal(resolveImageOutput(project,model).size,'864x1536');
});
test('area-only references do not become global framing sources',()=>{
  let project=addReference(newProject(),photo('Area appearance.png',2160,3840));
  const added=addText(project,{content:'1',x:0,y:0,width:20,height:30,fontSize:20});project=linkReferences(added.project,added.layerId,[project.references[0].id]);
  project.imageOutput={version:1,aspect:'source'};
  assert.equal(resolveImageOutput(project,model).source,'canvas');
});
test('explicit portrait output does not mutate source size, references or layers',()=>{
  const project=newProject(1600,1000);project.imageOutput={version:1,aspect:'9:16'};
  const before=structuredClone(project),output=resolveImageOutput(project,model);
  assert.equal(output.size,'864x1536');assert.equal(output.source,'preset');assert.deepEqual(project,before);
});
test('MAIN and blockout remain framing authority and reject conflicting forced landscape',()=>{
  const project=addRaster(newProject(),photo('MAIN.png',2160,3840),{fitDocument:true}).project;
  project.blockoutReview={enabled:true,assetId:project.original.assetId};project.width=1600;project.height=1000;
  assert.equal(resolveImageOutput(project,model).size,'864x1536');
  project.imageOutput={version:1,aspect:'16:9'};assert.throws(()=>resolveImageOutput(project,model),/conflicts with the locked/);
  project.imageOutput.aspect='9:16';assert.equal(resolveImageOutput(project,model).size,'864x1536');
});
test('documented custom-size models keep exact9:16; unsupported models report portrait choices without substitution',()=>{
  for(const id of [model,'gpt-image-2.5-flare','gpt-image-2','gpt-image-2.5-sunburst-2026-09-08'])assert.equal(exactImageOutputSize(id,1080,1920),'864x1536');
  assert.throws(()=>exactImageOutputSize('gpt-image-1.5',1080,1920),/supported portrait size is 1024 × 1536/);
  assert.equal(exactImageOutputSize('gpt-image-1.5',1024,1536),'1024x1536');
  assert.throws(()=>exactImageOutputSize(model,941,1672),/cannot fit.*supported pixel sizes/);
  assert.throws(()=>exactImageOutputSize(model,1,4),/between 1:3 and 3:1/);
});
test('bad saved output setting fails; missing setting uses preferred 9:16 default',()=>{
  assert.deepEqual(validateImageOutput(newProject()),{version:1,aspect:'9:16'});
  for(const value of [null,{version:1,aspect:'16:8'},{version:2,aspect:'9:16'}])assert.throws(()=>validateImageOutput({...newProject(),imageOutput:value}),/supported image output/);
});
test('output check reports actual pixel mismatch without modifying image or using provider metadata',()=>{
  const image={width:1536,height:1024,source:'unchanged'};
  assert.equal(checkImageOutputSize('864x1536',image).matches,false);assert.match(checkImageOutputSize('864x1536',image).message,/not cropped or stretched/);assert.deepEqual(image,{width:1536,height:1024,source:'unchanged'});
  assert.equal(checkImageOutputSize('864x1536',{width:864,height:1536}).matches,true);
  assert.equal(checkImageOutputSize('864x1536',{}),null);
});
test('historical approval cannot hide known wrong output dimensions',()=>{
  const record={status:'completed',settings:{size:'864x1536'},review:{enabled:true,status:'accepted'},output:{width:1536,height:1024}};
  assert.equal(blockoutReviewDisplay(record).accepted,false);assert.match(blockoutReviewDisplay(record).label,/not approved/);
  record.output={width:864,height:1536};assert.equal(blockoutReviewDisplay(record).accepted,true);
});
