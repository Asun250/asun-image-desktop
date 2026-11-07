import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addText,attachObjectRegion} from '../public/core.mjs';
import {DEFAULT_GENERATION_QUALITY,DEFAULT_GENERATION_COMPLEXITY,generationQualityOptions,validateGenerationQuality,generationComplexityOptions,validateGenerationComplexity} from '../public/generation-settings.mjs';
import {supportedImageAspects,resolveImageOutput,validateImageOutputPixels,checkImageOutputSize} from '../public/image-output-settings.mjs';

const models=['gpt-image-2.6-sunburst','gpt-image-2.6-flare'];
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=';

test('2.6 quality and complexity are separate documented settings; existing quality default stays high',()=>{
  assert.equal(DEFAULT_GENERATION_QUALITY,'high');assert.equal(DEFAULT_GENERATION_COMPLEXITY,'high');
  for(const model of models){
    assert.deepEqual(generationQualityOptions(model),['auto','low','medium','high','xhigh','max']);
    assert.deepEqual(generationComplexityOptions(model),['low','medium','high']);
    for(const quality of generationQualityOptions(model))assert.equal(validateGenerationQuality(model,quality),quality);
    for(const complexity of generationComplexityOptions(model))assert.equal(validateGenerationComplexity(model,complexity),complexity);
    assert.equal(validateGenerationComplexity(model),'high');assert.equal(validateGenerationComplexity(model,null),'high');
    for(const value of ['auto','max','xhigh','',false,{},1])assert.throws(()=>validateGenerationComplexity(model,value),/supported complexity/);
    assert.throws(()=>validateGenerationQuality(model,'ultra'),/supported quality/);
  }
});

test('older models retain quality choices and omit complexity; explicit unsupported settings are rejected',()=>{
  for(const model of ['gpt-image-2.5-sunburst','gpt-image-2.5-flare','gpt-image-2.5-flare-2026-09-08']){
    assert.equal(validateGenerationQuality(model,'max'),'max');
    assert.deepEqual(generationComplexityOptions(model),[]);assert.equal(validateGenerationComplexity(model),undefined);
    assert.throws(()=>validateGenerationComplexity(model,'high'),/not supported/);
  }
  assert.deepEqual(generationQualityOptions('gpt-image-1.5'),['auto','low','medium','high']);
  assert.deepEqual(generationComplexityOptions('gpt-image-2.6-unknown'),[]);
});

test('2.6 uses verified standard sizes without substituting preferred 9:16 or mutating references',()=>{
  for(const model of models){
    assert.deepEqual(supportedImageAspects(model),['2:3','3:2','1:1']);
    const project=newProject(1600,1000),before=structuredClone(project);
    assert.throws(()=>resolveImageOutput(project,model),/not yet confirmed.*2\.6/);assert.deepEqual(project,before);
    for(const [aspect,size] of [['2:3','1024x1536'],['3:2','1536x1024'],['1:1','1024x1024']]){
      project.imageOutput={version:1,aspect};assert.equal(resolveImageOutput(project,model).size,size);
    }
    project.imageOutput.aspect='9:16';assert.throws(()=>resolveImageOutput(project,model),/preferred ratio is kept/);
    assert.equal(resolveImageOutput(project,'gpt-image-2.5-sunburst').size,'864x1536');
    assert.equal(project.imageOutput.aspect,'9:16');
  }
});

test('2.6 selected-area edits preserve exact supported canvas and selection alignment',()=>{
  for(const model of models){
    const raster=addRaster(newProject(1024,1536),{name:'Source.png',source:pixel,width:1024,height:1536});
    const text=addText(raster.project,{content:'1',x:100,y:100,width:30,height:30,fontSize:20});
    const layer=text.project.layers.find(item=>item.kind==='raster');
    const project=attachObjectRegion(text.project,text.layerId,{version:1,assetId:layer.assetId,rasterLayerId:layer.id,sourceWidth:1024,sourceHeight:1536,mask:{width:4,height:4,counts:[5,2,9]}});
    project.imageOutput={version:1,aspect:'16:9'};const before=structuredClone(project);
    const output=resolveImageOutput(project,model);assert.equal(output.size,'1024x1536');assert.equal(output.source,'edit-canvas');assert.deepEqual(project,before);
    assert.throws(()=>validateImageOutputPixels(model,864,1536),/outside.*verified sizes/);
    assert.equal(checkImageOutputSize(output.size,{width:1536,height:1024}).matches,false);
    assert.equal(checkImageOutputSize(output.size,{width:1024,height:1536}).matches,true);
  }
});
