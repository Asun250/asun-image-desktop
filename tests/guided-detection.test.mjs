import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addDrawing,updateLayer,addMaskStroke,reorderLayer,addText,attachObjectRegion,parseProject,serializeProject} from '../public/core.mjs';
import {guidedMarkTarget,mapGuidedResult} from '../public/guided-detection.mjs';
import {regionContainsPoint,regionMaskInfo,validateDetectionResult,objectRegionContains} from '../public/object-regions.mjs';
const source='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const picture=(name,width=800,height=600)=>({name,source,width,height});
function marked(points=[[300,200],[340,220]],size=10) {
  const image=addRaster(newProject(),picture('MAIN.png')),stroke=addDrawing(image.project,{mode:'highlight',color:'#ffff00',size,points});
  return {...stroke,rasterId:image.layerId};
}
function mask(width,height,contains) {
  const counts=[];let previous=0,count=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const value=Number(contains(x,y));if(value===previous)count++;else{counts.push(count);count=1;previous=value;}}
  counts.push(count);return {width,height,counts};
}
const response=(width,height,predicate=(x,y)=>x>=2&&x<4&&y>=1&&y<3)=>({width,height,regions:[{id:'SAM',mask:mask(width,height,predicate)}],model:'SAM 2.1',device:'cuda',elapsedMs:12});
const working=(crop={x:20,y:30,width:80,height:60},fullWidth=200,fullHeight=150,width=8,height=6)=>({crop,fullWidth,fullHeight,request:{width,height}});

test('guided target follows transformed drawing points and anisotropic brush width into a resized offset raster',()=>{
  let {project,layerId,rasterId}=marked();
  project=updateLayer(project,rasterId,{x:100,y:50,width:400,height:300});
  const mark=project.layers.find(layer=>layer.id===layerId);
  project=updateLayer(project,layerId,{x:200,y:100,width:mark.width*2,height:mark.height*3});
  const before=serializeProject(project),target=guidedMarkTarget(project,layerId);
  // Native mark points start six units from its original padded drawing origin.
  assert.deepEqual(target.markBounds,{x:202,y:103,width:100,height:90});
  assert.deepEqual(target.sourceBox,[204,106,404,286]);
  assert.deepEqual(target.crop,{x:4,y:0,width:600,height:466});
  assert.equal(target.raster.id,rasterId);assert.equal(serializeProject(project),before);
});

test('guided targeting uses topmost overlapping raster below the mark, including a second imported image',()=>{
  let added=addRaster(newProject(),picture('MAIN.png')),project=added.project,mainId=added.layerId;
  added=addRaster(project,picture('SECOND.png',200,150));project=updateLayer(added.project,added.layerId,{x:280,y:200,width:200,height:150});const secondId=added.layerId;
  added=addDrawing(project,{mode:'pencil',size:4,points:[[300,230],[340,250]]});project=added.project;
  assert.equal(guidedMarkTarget(project,added.layerId).raster.id,secondId);
  assert.equal(guidedMarkTarget(updateLayer(project,secondId,{visible:false}),added.layerId).raster.id,mainId);
  assert.equal(guidedMarkTarget(updateLayer(project,secondId,{opacity:0}),added.layerId).raster.id,mainId);
  assert.equal(guidedMarkTarget(reorderLayer(project,secondId,project.layers.length-1),added.layerId).raster.id,mainId,'A raster drawn above the mark is not a source behind the mark');
});

test('invalid, hidden, off-board and fully erased marks cannot target a source, and edge crops remain clipped',()=>{
  let {project,layerId,rasterId}=marked([[1,1],[8,2]],10);
  const target=guidedMarkTarget(project,layerId);assert.deepEqual(target.sourceBox,[0,0,13,7]);assert.deepEqual(target.crop,{x:0,y:0,width:45,height:39});
  assert.equal(guidedMarkTarget(project,rasterId),null);assert.equal(guidedMarkTarget(project,'missing'),null);
  for(const patch of [{visible:false},{opacity:0},{x:-500,y:-500}])assert.equal(guidedMarkTarget(updateLayer(project,layerId,patch),layerId),null);
  assert.equal(guidedMarkTarget(updateLayer(project,rasterId,{visible:false}),layerId),null);
  project=addMaskStroke(project,rasterId,{mode:'hide',size:100,points:[[0,0]]});assert.equal(guidedMarkTarget(project,layerId),null);
  project=addMaskStroke(project,rasterId,{mode:'restore',size:20,points:[[6,4]]});assert.equal(guidedMarkTarget(project,layerId).raster.id,rasterId);
  const edge=marked([[795,595],[799,599]],6),last=guidedMarkTarget(edge.project,edge.layerId);
  assert.ok(last.crop.x>=0&&last.crop.y>=0&&last.crop.x+last.crop.width<=800&&last.crop.y+last.crop.height<=600);
  assert.deepEqual(last.sourceBox,[792,592,800,600]);
});

test('ROI masks map to native positions on the full-raster grid without mutating result or working geometry',()=>{
  const raw=response(8,6),geometry=working(),before=JSON.stringify({raw,geometry}),mapped=mapGuidedResult(raw,geometry),region=mapped.regions[0];
  assert.deepEqual([mapped.width,mapped.height],[200,150]);assert.deepEqual(region.bbox,[40,40,20,20]);assert.equal(region.area,400);
  assert.equal(regionContainsPoint(region.mask,40,40),true);assert.equal(regionContainsPoint(region.mask,59.99,59.99),true);assert.equal(regionContainsPoint(region.mask,60,60),false);assert.equal(regionContainsPoint(region.mask,0,0),false);
  assert.equal(mapped.model,'SAM 2.1');assert.equal(JSON.stringify({raw,geometry}),before);
});

test('full-raster normalization keeps tiny disconnected selections, holes, validated unique IDs and deduplicated candidates',()=>{
  const geometry=working({x:3900,y:2900,width:80,height:60},8000,6000),raw=response(8,6,(x,y)=>(x===0&&y===0)||(x>=2&&x<=4&&y>=1&&y<=4&&!(x===3&&y===2)));
  raw.regions.push({id:'same pixels another candidate',mask:structuredClone(raw.regions[0].mask)});
  const mapped=mapGuidedResult(raw,geometry),region=mapped.regions[0];assert.deepEqual([mapped.width,mapped.height],[1600,1200]);assert.equal(mapped.regions.length,1);
  assert.equal(regionContainsPoint(region.mask,780,580),true);assert.equal(regionContainsPoint(region.mask,786,584),false);assert.equal(regionContainsPoint(region.mask,788,584),true);
  assert.notEqual(mapGuidedResult(raw,geometry).regions[0].id,region.id);assert.doesNotThrow(()=>validateDetectionResult(mapped));
  const thin=mapGuidedResult(response(8,6,(x,y)=>x===3&&y===2),working({x:200,y:200,width:8,height:6},8000,6000));assert.ok(regionMaskInfo(thin.regions[0].mask).area>0,'A source pixel smaller than a destination cell remains selectable');
});

test('mapped masks attach to editable labels and track their source transform after serialization',()=>{
  const markedScene=marked(),target=guidedMarkTarget(markedScene.project,markedScene.layerId),geometry=working({x:200,y:100,width:80,height:60},800,600),region=mapGuidedResult(response(8,6),geometry).regions[0];
  const added=addText(markedScene.project,{content:'1',x:220,y:110,width:30,height:40});
  let project=attachObjectRegion(added.project,added.layerId,{version:1,assetId:target.asset.id,rasterLayerId:target.raster.id,sourceWidth:800,sourceHeight:600,mask:region.mask});
  project=parseProject(serializeProject(project));assert.equal(objectRegionContains(project,project.layers.at(-1),[225,115]),true);
  project=updateLayer(project,target.raster.id,{x:100,y:50,width:400,height:300});assert.equal(objectRegionContains(project,project.layers.at(-1),[212.5,107.5]),true);assert.equal(project.assets[target.asset.id].source,source);
});

test('bad ROI masks and wrong dimensions reject before producing a partial selection',()=>{
  const geometry=working();
  assert.throws(()=>mapGuidedResult(response(4,3),geometry),/incompatible/);
  assert.throws(()=>mapGuidedResult({width:8,height:6,regions:[{id:'bad',mask:{width:8,height:6,counts:[0,47]}}]},geometry),/mask/);
  for(const crop of [{x:-1,y:0,width:8,height:6},{x:190,y:0,width:80,height:60},{x:0,y:0,width:.5,height:60}])assert.throws(()=>mapGuidedResult(response(8,6),{...geometry,crop}),/coordinates/);
  assert.deepEqual(mapGuidedResult({...response(8,6),regions:[]},geometry).regions,[]);
});
