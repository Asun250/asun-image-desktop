import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addText,attachObjectRegion,updateLayer,addMaskStroke} from '../public/core.mjs';
import {brushObjectSelection,selectionTarget,MANUAL_SELECTION_MAX_SIDE} from '../public/edit-selection.mjs';
import {validateRegionMask,regionContainsPoint,regionMaskInfo} from '../public/object-regions.mjs';

const source='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function scene(width=200,height=100){return addRaster(newProject(width,height),{name:'Original.png',source,width,height});}
function contains(hit,x,y){return regionContainsPoint(hit.mask,(x-hit.raster.x)*hit.mask.width/hit.raster.width,(y-hit.raster.y)*hit.mask.height/hit.raster.height);}
function paint(project,layerId,points,size=12,mask=null,mode='add'){return brushObjectSelection(project,{rasterId:layerId,points,size,mask,mode});}
function encoded(width,height,fn){
  const counts=[];let prior=0,count=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const value=Number(fn(x,y));if(value===prior)count++;else{counts.push(count);prior=value;count=1;}}
  counts.push(count);return {width,height,counts};
}

test('separate strokes form one editable selection without filling the gap or changing sources',()=>{
  const {project,layerId}=scene(),original=structuredClone(project);
  const first=paint(project,layerId,[[30,40]],20);
  const combined=paint(project,layerId,[{x:150,y:40}],20,first.mask);
  assert(contains(combined,30,40));assert(contains(combined,150,40));assert(!contains(combined,90,40));
  assert.equal(combined.raster,project.layers[0]);assert.equal(combined.asset,project.assets[combined.raster.assetId]);
  assert.equal(combined.project,project);assert.equal(combined.manual,true);
  assert(contains(combined,combined.point.x,combined.point.y),'label centre stays in foreground, not the gap');
  assert.deepEqual(project,original);assert(contains(first,30,40));assert(!contains(first,150,40));
});

test('refining a moved and nonuniformly resized image uses document brush size and native mask coordinates',()=>{
  let {project,layerId}=scene(800,600);
  project=updateLayer(project,layerId,{x:50,y:20,width:400,height:120});
  const hit=paint(project,layerId,[[250,80]],40),[x,y,w,h]=regionMaskInfo(hit.mask).bbox;
  assert(contains(hit,250,80));assert(!contains(hit,275,80));assert(!contains(hit,250,105));
  assert(Math.abs(w*400/800-40)<3);assert(Math.abs(h*120/600-40)<3);
  assert(Math.abs(x*400/800+50-230)<2);assert(Math.abs(y*120/600+20-60)<2);
  assert(contains(hit,hit.point.x,hit.point.y));
});

test('subtract makes holes, preserves other components, and returns null when the last selection is cleared',()=>{
  const {project,layerId}=scene();
  const first=paint(project,layerId,[[50,50]],50);
  const next=paint(project,layerId,[[150,50]],12,first.mask);
  const hole=paint(project,layerId,[[50,50]],20,next.mask,'subtract');
  assert(!contains(hole,50,50));assert(contains(hole,70,50));assert(contains(hole,150,50));
  assert(contains(hole,hole.point.x,hole.point.y));
  assert.equal(paint(project,layerId,[[100,50]],1000,hole.mask,'subtract'),null);
  assert.equal(paint(project,layerId,[[50,50]],10,null,'subtract'),null);
  assert(contains(first,50,50),'subtract must not mutate the previous selection');
});

test('tiny clicks and long diagonal strokes remain connected on a bounded grid',()=>{
  const {project,layerId}=scene(8192,2048);
  const tiny=paint(project,layerId,[[4096,1024]],.01);
  assert(tiny);assert.equal(tiny.mask.width,MANUAL_SELECTION_MAX_SIDE);assert.equal(tiny.mask.height,256);
  assert(contains(tiny,4096,1024));assert(regionMaskInfo(tiny.mask).area<=4);
  const diagonal=paint(project,layerId,[[10,10],[8180,2030]],2);
  for(let i=0;i<=100;i++){const t=i/100;assert(contains(diagonal,10+8170*t,10+2020*t));}
});

test('brushes clip to visible image and document bounds and ignore hidden raster pixels',()=>{
  let {project,layerId}=scene();
  assert.equal(paint(project,layerId,[[-100,-100]],5),null);
  const edge=paint(project,layerId,[[0,0]],20);assert(edge);assert.deepEqual(regionMaskInfo(edge.mask).bbox.slice(0,2),[0,0]);
  project=addMaskStroke(project,layerId,{mode:'hide',size:30,points:[[50,50]]});
  const masked=paint(project,layerId,[[50,50]],50);assert(masked);assert(!contains(masked,50,50));assert(contains(masked,70,50));
  project=updateLayer(project,layerId,{x:-50,y:0});
  const cropped=paint(project,layerId,[[-40,30],[40,30]],20);
  assert(!contains(cropped,-30,30));assert(contains(cropped,20,30));
});

test('existing detector masks retain their resolution, thin components and holes during refinement',()=>{
  const {project,layerId}=scene(200,100);
  const mask=encoded(1600,800,(x,y)=>(x===5&&y>=1&&y<799)||(x>=300&&x<500&&y>=300&&y<500&&!(x>340&&x<460&&y>340&&y<460)));
  const before=structuredClone(mask),hit=paint(project,layerId,[[180,80]],10,mask);
  assert.equal(hit.mask.width,1600);assert.equal(hit.mask.height,800);
  assert(regionContainsPoint(hit.mask,5,450));assert(!regionContainsPoint(hit.mask,400,400));
  assert(regionContainsPoint(hit.mask,320,320));assert(contains(hit,180,80));
  assert.deepEqual(mask,before);validateRegionMask(hit.mask);
});

test('painting excludes existing object erasures and follows their ordered restores',()=>{
  const {project,layerId}=scene(),raster=project.layers[0];
  const region=encoded(20,10,(x,y)=>x>=4&&x<8&&y>=3&&y<7);
  raster.mask.push({mode:'hide',region,sourceWidth:200,sourceHeight:100});
  let hit=paint(project,layerId,[[60,50]],80);assert(hit);assert(!contains(hit,60,50));assert(contains(hit,90,50));
  raster.mask.push({mode:'restore',region,sourceWidth:200,sourceHeight:100});
  hit=paint(project,layerId,[[60,50]],80);assert(contains(hit,60,50));
});

test('target resolution respects selected images and object bindings before the original',()=>{
  let {project,layerId}=scene();
  const second=addRaster(project,{name:'Other.png',source,width:100,height:100});project=second.project;
  assert.equal(selectionTarget(project)?.id,layerId);assert.equal(selectionTarget(project,second.layerId)?.id,second.layerId);
  const added=addText(project,{content:'1',x:30,y:30,width:15,height:20});project=added.project;
  const raster=project.layers.find(layer=>layer.id===second.layerId),asset=project.assets[raster.assetId];
  project=attachObjectRegion(project,added.layerId,{version:1,assetId:raster.assetId,rasterLayerId:raster.id,sourceWidth:asset.width,sourceHeight:asset.height,mask:{width:1,height:1,counts:[0,1]}});
  assert.equal(selectionTarget(project,added.layerId)?.id,second.layerId);
  project=updateLayer(project,second.layerId,{visible:false});assert.equal(selectionTarget(project,added.layerId)?.id,layerId);
  project=updateLayer(project,layerId,{opacity:0});assert.equal(selectionTarget(project),null);
  assert.equal(selectionTarget(newProject()),null);
});

test('invalid masks, targets, dimensions and stroke inputs fail before modifying project data',()=>{
  const {project,layerId}=scene(),before=structuredClone(project);
  const args={rasterId:layerId,points:[[20,20]],size:10};
  for(const change of [{rasterId:'missing'},{size:0},{size:NaN},{mode:'erase'},{points:[]},{points:[[NaN,0]]},{points:[[1,2,3]]},{points:[[1e7,0]]},{mask:{width:2,height:2,counts:[0,5]}},{mask:{width:1601,height:1,counts:[0,1601]}}])assert.throws(()=>brushObjectSelection(project,{...args,...change}));
  assert.throws(()=>brushObjectSelection(updateLayer(project,layerId,{visible:false}),args),/visible image/);
  const bad=structuredClone(project);bad.layers[0].width=0;assert.throws(()=>brushObjectSelection(bad,args),/invalid dimensions/);
  assert.deepEqual(project,before);
});
