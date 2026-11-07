import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addDrawing,updateLayer,addText,attachObjectRegion,validateProject} from '../public/core.mjs';
import {layerPointToDocument,documentPointToLayer} from '../public/layer-transform.mjs';
import {brushObjectSelection} from '../public/edit-selection.mjs';
import {regionContainsPoint} from '../public/object-regions.mjs';
import {guidedMarkTarget} from '../public/guided-detection.mjs';
import {imageGenerationPlan} from '../public/image-generation-request.mjs';
import {objectRemovalRequest} from '../public/object-removal-request.mjs';
import {sketchSurface,sketchContentSignature} from '../public/sketch-detection.mjs';

const source='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const fixture=()=>addRaster(newProject(800,600),{name:'Source.png',source,width:800,height:600});
const approximately=(actual,expected)=>assert(Math.abs(actual-expected)<1e-8,`${actual} equals ${expected}`);

test('sketch paper stays upright while placed image rotations invalidate sketch detection',()=>{
  const added=fixture(),project=added.project;project.sketch={version:1,background:'#ffffff',surfaceLayerId:added.layerId};
  assert(sketchSurface(project));assert.throws(()=>updateLayer(project,added.layerId,{rotation:30}),/drawing page upright/);
  const invalid=structuredClone(project);invalid.layers[0].rotation=30;
  assert.equal(sketchSurface(invalid),null);assert.throws(()=>validateProject(invalid),/drawing page upright/);
  const placed=addRaster(project,{name:'Placed.png',source,width:100,height:100});
  const rotated=updateLayer(placed.project,placed.layerId,{rotation:30});
  assert.notEqual(sketchContentSignature(placed.project),sketchContentSignature(rotated));assert(sketchSurface(rotated));
});

test('rotated manual painting and refinement stay in source coordinates without changing brush size or original bytes',()=>{
  const added=fixture(),project=updateLayer(added.project,added.layerId,{x:100,y:100,width:400,height:200,rotation:90}),raster=project.layers[0],before=structuredClone(project);
  const a=layerPointToDocument(raster,{x:100,y:50}),b=layerPointToDocument(raster,{x:300,y:150});
  const one=brushObjectSelection(project,{rasterId:raster.id,points:[a],size:20});
  assert(regionContainsPoint(one.mask,200,150));assert(!regionContainsPoint(one.mask,300,150));
  const both=brushObjectSelection(project,{rasterId:raster.id,points:[b],size:20,mask:one.mask});
  assert(regionContainsPoint(both.mask,200,150));assert(regionContainsPoint(both.mask,600,450));assert(!regionContainsPoint(both.mask,400,300));
  const refined=brushObjectSelection(project,{rasterId:raster.id,points:[a],size:40,mask:both.mask,mode:'subtract'});
  assert(!regionContainsPoint(refined.mask,200,150));assert(regionContainsPoint(refined.mask,600,450));
  const label=documentPointToLayer(raster,refined.point);assert(regionContainsPoint(refined.mask,label.x*2,label.y*3));assert.deepEqual(project,before);
});

test('brush painting clips a rotated layer to the document rather than its old axis-aligned rectangle',()=>{
  const added=fixture(),project=updateLayer(added.project,added.layerId,{x:-80,y:0,width:200,height:100,rotation:90}),raster=project.layers[0];
  const target=layerPointToDocument(raster,{x:100,y:20});assert(target.x>=0&&target.y>=0);
  const hit=brushObjectSelection(project,{rasterId:raster.id,points:[target],size:40});assert(hit);assert(regionContainsPoint(hit.mask,400,120));
  for(let y=0;y<hit.mask.height;y++)for(let x=0;x<hit.mask.width;x++)if(regionContainsPoint(hit.mask,x,y)){
    const p=layerPointToDocument(raster,{x:(x+.5)*raster.width/hit.mask.width,y:(y+.5)*raster.height/hit.mask.height});assert(p.x>=0&&p.y>=0&&p.x<project.width&&p.y<project.height);
  }
});

test('guided source box inverse-rotates a document highlight and rejects empty rotated bounding corners',()=>{
  const added=fixture();let project=updateLayer(added.project,added.layerId,{x:100,y:100,width:400,height:200,rotation:90});
  let mark=addDrawing(project,{mode:'highlight',size:10,points:[[350,100],[350,120]]});
  const target=guidedMarkTarget(mark.project,mark.layerId);assert(target);[190,135,250,165].forEach((value,index)=>approximately(target.sourceBox[index],value));
  project=updateLayer(project,added.layerId,{x:200,y:150,width:200,height:100,rotation:45});mark=addDrawing(project,{mode:'highlight',size:2,points:[[195,100]]});
  assert.equal(guidedMarkTarget(mark.project,mark.layerId),null,'Empty AABB corner does not count as an image under the highlight.');
});

test('generation includes rotated pixels entering the document and excludes empty rotated bounding corners',()=>{
  const added=fixture();let project=updateLayer(added.project,added.layerId,{x:110,y:0,width:20,height:120});project.width=100;project.height=100;project.prompt='Keep the composition.';
  assert.equal(imageGenerationPlan(project).hasComposition,false);
  project=updateLayer(project,added.layerId,{rotation:90});assert.equal(imageGenerationPlan(project).hasComposition,true);
  project=updateLayer(project,added.layerId,{x:80,y:125,width:100,height:10,rotation:-45});assert.equal(imageGenerationPlan(project).hasComposition,false);
});

test('a visible selection rotated onto the canvas remains eligible for remove and fill',()=>{
  const added=fixture();let project=updateLayer(added.project,added.layerId,{x:110,y:0,width:20,height:120,rotation:90});project.width=100;project.height=100;
  const raster=project.layers[0],label=addText(project,{content:'1',fontSize:12,x:70,y:50,width:10,height:15});
  project=attachObjectRegion(label.project,label.layerId,{version:1,assetId:raster.assetId,rasterLayerId:raster.id,sourceWidth:800,sourceHeight:600,mask:{width:1,height:1,counts:[0,1]}});
  assert.equal(objectRemovalRequest(project,[label.layerId]).imageEditRequest.action,'remove-fill');
  project=updateLayer(project,raster.id,{rotation:0});assert.throws(()=>objectRemovalRequest(project,[label.layerId]),/visible selection/);
});
