import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addReference,addText,attachObjectRegion,serializeProject,parseProject} from '../public/core.mjs';
import {DEFAULT_IMAGE_ASPECT,supportedImageAspects,resolveImageOutput,validateImageOutputPixels,isSelectedAreaEdit,imageAspectRatio,checkImageOutputSize} from '../public/image-output-settings.mjs';
import {IMAGE_ASPECT_PREFERENCE_KEY,readImageAspectPreference,writeImageAspectPreference,withImageAspectPreference} from '../public/image-output-preferences.mjs';

const model='gpt-image-2.5-sunburst';
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=';
const photo=(name,width,height)=>({name,width,height,source:pixel});
function storage(){const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value))};}
function selectedProject(width=1536,height=1024){
  const added=addRaster(newProject(width,height),photo('Source.png',width,height));
  const labeled=addText(added.project,{content:'1',x:100,y:100,width:20,height:30,fontSize:20});
  const raster=labeled.project.layers[0];
  return attachObjectRegion(labeled.project,labeled.layerId,{version:1,assetId:raster.assetId,rasterLayerId:raster.id,sourceWidth:width,sourceHeight:height,mask:{width:4,height:4,counts:[5,2,9]}});
}

test('model capabilities expose only verified ratios and reject retired or unverified models',()=>{
  const five=['9:16','16:9','2:3','3:2','1:1'];
  for(const id of [model,'gpt-image-2.5-flare','gpt-image-2','gpt-image-2-2026-04-21','gpt-image-2.5-flare-2026-09-08','gpt-image-2.5-sunburst-2026-09-08'])assert.deepEqual(supportedImageAspects(id),five);
  for(const id of ['gpt-image-1.5','gpt-image-1-mini'])assert.deepEqual(supportedImageAspects(id),['2:3','3:2','1:1']);
  for(const id of ['gpt-image-1','unverified-model','']){assert.deepEqual(supportedImageAspects(id),[]);assert.throws(()=>resolveImageOutput(newProject(),id),/retired|not been verified/);}
});

test('default and every supported preset map to exact supported API pixels',()=>{
  assert.equal(DEFAULT_IMAGE_ASPECT,'9:16');assert.equal(resolveImageOutput(newProject(),model).size,'864x1536');
  const sizes={'9:16':'864x1536','16:9':'1536x864','2:3':'1024x1536','3:2':'1536x1024','1:1':'1024x1024'};
  for(const [aspect,size] of Object.entries(sizes)){
    const project={...newProject(),imageOutput:{version:1,aspect}};
    const result=resolveImageOutput(project,model);assert.equal(result.size,size);assert.equal(result.ratio,aspect);
    assert.equal(validateImageOutputPixels(model,result.width,result.height),size);
  }
});

test('explicit ratio overrides references, prompt wording and preferred ratio without altering input',()=>{
  let project=addReference(newProject(),photo('Wide main reference.png',1920,1080));
  project=addReference(project,photo('Portrait appearance.png',1080,1920));project.prompt='Make a landscape image.';
  project.imageOutput={version:1,aspect:'9:16'};const before=structuredClone(project);
  assert.equal(resolveImageOutput(project,model,{preferredAspect:'16:9'}).size,'864x1536');assert.deepEqual(project,before);
  project.imageOutput.aspect='16:9';assert.equal(resolveImageOutput(project,model,{preferredAspect:'9:16'}).size,'1536x864');
  project.imageOutput.aspect='source';assert.equal(resolveImageOutput(project,model).size,'1536x864');
});

test('switching models preserves supported choices and blocks unsupported choices without substitution',()=>{
  const project={...newProject(),imageOutput:{version:1,aspect:'9:16'}},before=structuredClone(project);
  assert.equal(resolveImageOutput(project,model).size,'864x1536');
  assert.throws(()=>resolveImageOutput(project,'gpt-image-1.5'),/1024 × 1536 \(2:3\).*No size was substituted/);
  assert.deepEqual(project,before);assert.equal(resolveImageOutput(project,'gpt-image-2.5-flare').size,'864x1536');
  project.imageOutput.aspect='2:3';
  for(const id of [model,'gpt-image-1.5','gpt-image-1-mini'])assert.equal(resolveImageOutput(project,id).size,'1024x1536');
});

test('preferences survive a new reader and project serialization; explicit project choice wins',()=>{
  const saved=storage();assert.equal(readImageAspectPreference(saved),'9:16');
  assert.equal(writeImageAspectPreference('16:9',saved),true);assert.equal(saved.getItem(IMAGE_ASPECT_PREFERENCE_KEY),'16:9');
  assert.equal(readImageAspectPreference(saved),'16:9');
  const project=newProject();assert.equal(resolveImageOutput(project,model,{preferredAspect:readImageAspectPreference(saved)}).size,'1536x864');
  project.imageOutput={version:1,aspect:'2:3'};
  const reopened=parseProject(serializeProject(project));assert.equal(resolveImageOutput(reopened,model,{preferredAspect:'16:9'}).size,'1024x1536');
  const snapshot=withImageAspectPreference(project);assert.deepEqual(snapshot.imageOutput,project.imageOutput);assert.notEqual(snapshot.imageOutput,project.imageOutput);
  saved.setItem(IMAGE_ASPECT_PREFERENCE_KEY,'bad');assert.equal(readImageAspectPreference(saved),'9:16');
  assert.throws(()=>writeImageAspectPreference('8:7',saved),/supported aspect/);
  const denied={getItem(){throw new Error('unavailable');},setItem(){throw new Error('unavailable');}};
  assert.equal(readImageAspectPreference(denied),'9:16');assert.equal(writeImageAspectPreference('9:16',denied),false);
});

test('selected-area edits preserve exact canvas and mask coordinates despite saved portrait preference',()=>{
  const project=selectedProject();project.imageOutput={version:1,aspect:'9:16'};const before=structuredClone(project);
  assert.equal(isSelectedAreaEdit(project),true);
  const result=resolveImageOutput(project,model,{preferredAspect:'9:16'});
  assert.equal(result.size,'1536x1024');assert.equal(result.ratio,'3:2');assert.equal(result.aspect,'canvas');assert.equal(result.source,'edit-canvas');assert.deepEqual(project,before);
  assert.equal(resolveImageOutput(project,'gpt-image-1.5').size,'1536x1024');
  project.layers[1].visible=false;assert.equal(isSelectedAreaEdit(project),false);assert.equal(resolveImageOutput(project,model).size,'864x1536');
});

test('sketch references remain generation inputs and do not lock remembered ratio to selection canvas',()=>{
  const project=selectedProject();project.sketch={version:1,background:'#ffffff',surfaceLayerId:project.layers[0].id};
  assert.equal(isSelectedAreaEdit(project),false);assert.equal(resolveImageOutput(project,model).size,'864x1536');
});

test('unsupported native editing dimensions reject unchanged instead of resizing image or mask',()=>{
  for(const [width,height,message] of [[941,1672,/multiples of 16/],[512,512,/total pixels/],[4096,2048,/at most 3840/],[2048,512,/aspect 1:3/]]){
    const project=selectedProject(width,height),before=structuredClone(project);
    assert.throws(()=>resolveImageOutput(project,model),message);assert.deepEqual(project,before);
  }
  const project=selectedProject(864,1536);assert.throws(()=>resolveImageOutput(project,'gpt-image-1.5'),/cannot preserve.*864 × 1536.*exactly/);
  assert.equal(resolveImageOutput(project,model).size,'864x1536');
});

test('actual ratio uses encoded dimensions with strict zero-pixel tolerance and distinguishes resolution mismatch',()=>{
  assert.equal(imageAspectRatio(864,1536),'9:16');assert.equal(imageAspectRatio(1536,864),'16:9');assert.equal(imageAspectRatio(0,1536),null);
  for(const image of [{width:1536,height:864},{width:1080,height:1920},{width:865,height:1536}]){
    const check=checkImageOutputSize('864x1536',image);assert.equal(check.matches,false);assert.equal(check.roundingAllowancePx,0);assert.equal(check.actualRatio,imageAspectRatio(image.width,image.height));
    assert.equal(check.aspectMatches,image.width===1080);assert.match(check.message,/original output is saved unchanged/);
  }
  assert.match(checkImageOutputSize('864x1536',{width:1080,height:1920}).message,/aspect ratio matches, but the pixel dimensions differ/);
  assert.equal(checkImageOutputSize('864x1536',{width:864,height:1536}).matches,true);
});
