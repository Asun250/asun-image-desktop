import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addText,attachObjectRegion,addReference,linkReferences,addMaskStroke,updateLayer,serializeProject,parseProject,saveVariant,restoreVariant,History,validateProject} from '../public/core.mjs';
import {eraseObjectRegions} from '../public/object-erase.mjs';
import {rasterPointVisible} from '../public/object-regions.mjs';
const source='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function mask(width,height,contains) {
  const counts=[];let previous=0,count=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const value=Number(contains(x,y));if(value===previous)count++;else{counts.push(count);count=1;previous=value;}}
  counts.push(count);return {width,height,counts};
}
function fixture() {
  let {project,layerId:rasterId}=addRaster(newProject(),{name:'Original.png',source,width:160,height:120});
  const added=addText(project,{content:'1',x:10,y:10,width:20,height:30,fontSize:20});project=added.project;
  const selection=mask(16,12,(x,y)=>(x>=2&&x<6&&y>=2&&y<6&&!(x===3&&y===3))||(x>=10&&x<13&&y>=7&&y<10));
  project=attachObjectRegion(project,added.layerId,{version:1,assetId:project.layers[0].assetId,rasterLayerId:rasterId,sourceWidth:160,sourceHeight:120,mask:selection,group:{areaCount:2}});
  project=addReference(project,{name:'Bird.png',source,width:160,height:120});
  project=linkReferences(project,added.layerId,[project.references[0].id]);
  return {project,rasterId,labelId:added.layerId,selection};
}
test('exact object masks erase disconnected pieces and retain holes after move and resize',()=>{
  let {project,rasterId,labelId,selection}=fixture();project=updateLayer(project,rasterId,{x:40,y:20,width:320,height:60});
  const original=structuredClone(project),erased=eraseObjectRegions(project,[labelId,labelId]),raster=erased.layers[0];
  const visible=(x,y)=>rasterPointVisible(erased,raster,{x:40+x*20,y:20+y*5});
  assert.equal(visible(2.5,2.5),false);assert.equal(visible(11.5,8.5),false);
  assert.equal(visible(3.5,3.5),true,'An inner hole remains visible');assert.equal(visible(8.5,6.5),true,'Gap between grouped objects remains visible');
  assert.equal(raster.mask.length,1,'Duplicate selection IDs do not add repeated operations');
  assert.deepEqual(raster.mask[0].region,selection);assert.equal(erased.layers[1].visible,false,'The annotation number does not remain on erased output');
  assert.deepEqual(erased.layers[1].referenceIds,project.layers[1].referenceIds);assert.deepEqual(erased.references,project.references);assert.deepEqual(erased.assets,project.assets);assert.deepEqual(project,original,'Input remains unchanged');
  erased.layers[0].mask[0].region.counts[0]=99;assert.deepEqual(project.layers[1].objectRegion.mask,selection,'Masks are independent copies');
});
test('ordered brush restoration and hiding continue to work after precise object erasure',()=>{
  let {project,rasterId,labelId}=fixture();project=eraseObjectRegions(project,[labelId]);
  assert.equal(rasterPointVisible(project,project.layers[0],[25,25]),false);
  project=addMaskStroke(project,rasterId,{mode:'restore',size:6,points:[[25,25]]});
  assert.equal(rasterPointVisible(project,project.layers[0],[25,25]),true);
  assert.equal(rasterPointVisible(project,project.layers[0],[45,45]),false,'Other erased pixels stay hidden');
  project=addMaskStroke(project,rasterId,{mode:'hide',size:4,points:[[25,25]]});
  assert.equal(rasterPointVisible(project,project.layers[0],[25,25]),false);
});
test('precise erasure survives save/reopen, variants, Undo and Redo without changing originals or references',()=>{
  const {project,labelId,rasterId}=fixture(),history=new History(project),erased=eraseObjectRegions(project,[labelId]);
  history.commit(erased,'Erase object');assert.deepEqual(history.undo(),project);assert.deepEqual(history.redo(),erased);
  const saved=saveVariant(erased,'Birds erased'),reopened=parseProject(serializeProject(saved));assert.deepEqual(reopened,saved);
  const cleared=updateLayer(reopened,rasterId,{mask:[]});assert.deepEqual(restoreVariant(cleared,cleared.variants[0].id).layers,erased.layers);
  assert.equal(reopened.assets[reopened.original.assetId].source,source);assert.deepEqual(reopened.references,project.references);
});
test('stale, hidden, invalid and non-raster selections reject atomically',()=>{
  const {project,labelId,rasterId}=fixture(),original=structuredClone(project);
  assert.throws(()=>eraseObjectRegions(project,[]),/Select an object/);
  assert.throws(()=>eraseObjectRegions(project,[labelId,'missing']),/no longer available/);
  assert.throws(()=>eraseObjectRegions(project,[rasterId]),/no longer available/);
  for(const [id,patch] of [[labelId,{visible:false}],[labelId,{opacity:0}],[rasterId,{visible:false}],[rasterId,{opacity:0}]])assert.throws(()=>eraseObjectRegions(updateLayer(project,id,patch),[labelId]),/hidden/);
  const stale=structuredClone(project);stale.layers[1].objectRegion.sourceWidth=159;assert.throws(()=>eraseObjectRegions(stale,[labelId]),/does not match/);
  assert.deepEqual(project,original);
});
test('native format rejects malformed or foreign region-mask bindings, including variants and annotations',()=>{
  const {project,labelId}=fixture(),erased=eraseObjectRegions(project,[labelId]);
  for(const patch of [{sourceWidth:159},{sourceHeight:119},{mode:'cut'},{points:[[1,1]]},{region:{width:2,height:2,counts:[0,3]}}]) {
    const invalid=structuredClone(erased);Object.assign(invalid.layers[0].mask[0],patch);assert.throws(()=>parseProject(JSON.stringify(invalid)),/mask/);
  }
  const text=structuredClone(erased);text.layers[1].mask=[structuredClone(text.layers[0].mask[0])];assert.throws(()=>validateProject(text),/object erasure mask/);
  const variant=saveVariant(erased,'Removed');variant.variants[0].layers[0].mask[0].sourceWidth=2;assert.throws(()=>parseProject(JSON.stringify(variant)),/does not match/);
  const reference=structuredClone(erased);reference.references[0].annotations=[structuredClone(project.layers[1])];delete reference.references[0].annotations[0].referenceIds;delete reference.references[0].annotations[0].objectRegion;reference.references[0].annotations[0].mask=[structuredClone(erased.layers[0].mask[0])];assert.throws(()=>validateProject(reference),/reference annotation mask/);
});
