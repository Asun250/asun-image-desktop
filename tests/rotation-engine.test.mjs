import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addText,attachObjectRegion,updateLayer,addMaskStroke,parseProject,serializeProject,saveVariant,restoreVariant,History} from '../public/core.mjs';
import {normalizeRotation,layerPointToDocument,documentPointToLayer,layerBounds,layerIntersectsCanvas} from '../public/layer-transform.mjs';
import {rasterPointVisible,objectRegionContains,objectRegionBounds,rasterRegionBounds} from '../public/object-regions.mjs';
import {eraseObjectRegions} from '../public/object-erase.mjs';
import {fitCanvasToImage,canvasImageFitChanges,canvasImageFitTarget} from '../public/canvas-fit.mjs';
const source='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} must equal ${expected}`);
function fixture(){
  const added=addRaster(newProject(),{name:'Photo.png',source,width:160,height:120}),text=addText(added.project,{content:'1',x:20,y:20,width:20,height:20,fontSize:16});
  const project=attachObjectRegion(text.project,text.layerId,{version:1,assetId:added.project.layers[0].assetId,rasterLayerId:added.layerId,sourceWidth:160,sourceHeight:120,mask:{width:8,height:6,counts:[9,2,6,2,29]}});
  return {project,rasterId:added.layerId,labelId:text.layerId};
}
test('center-pivot rotation has a stable inverse at arbitrary and orthogonal angles',()=>{
  for(const rotation of [-720,-180,-90,-37.25,0,36,90,180,270,1080]){
    const layer={x:-42.5,y:17.25,width:320,height:80,rotation};
    for(const local of [{x:0,y:0},{x:160,y:40},{x:320,y:80},{x:23.7,y:51.2}]){const inverse=documentPointToLayer(layer,layerPointToDocument(layer,local));near(inverse.x,local.x);near(inverse.y,local.y);}
  }
  assert.equal(normalizeRotation(450),90);assert.equal(normalizeRotation(-450),-90);assert.equal(normalizeRotation(360),0);assert.equal(normalizeRotation(180),-180);
  assert.throws(()=>normalizeRotation(NaN),/finite/);assert.throws(()=>normalizeRotation('90'),/finite/);
  assert.deepEqual(layerBounds({x:30,y:40,width:40,height:20,rotation:90}),{x:40,y:30,width:20,height:40});
});
test('rotated visibility uses polygon intersection rather than empty AABB corners',()=>{
  assert.equal(layerIntersectsCanvas({x:30,y:40,width:40,height:20,rotation:90},{width:100,height:100}),true);
  assert.equal(layerIntersectsCanvas({x:100,y:0,width:20,height:20},{width:100,height:100}),false);
  const outside={x:-60,y:-30,width:80,height:20,rotation:-45},bounds=layerBounds(outside);
  assert.ok(bounds.x+bounds.width>0&&bounds.y+bounds.height>0,'The AABB touches the canvas');
  assert.equal(layerIntersectsCanvas(outside,{width:100,height:100}),false,'The actual rotated rectangle misses the canvas');
});
test('raster and detected region picking follow rotation, erasures and source-coordinate Restore',()=>{
  let {project,rasterId,labelId}=fixture();project=updateLayer(project,rasterId,{x:30,y:40,width:80,height:60,rotation:37});
  const raster=project.layers[0],inside=layerPointToDocument(raster,{x:15,y:15}),outside=layerPointToDocument(raster,{x:60,y:45});
  assert.equal(rasterPointVisible(project,raster,inside),true);assert.equal(objectRegionContains(project,project.layers[1],inside),true);assert.equal(objectRegionContains(project,project.layers[1],outside),false);
  const erased=eraseObjectRegions(project,[labelId]);assert.equal(rasterPointVisible(erased,erased.layers[0],inside),false);assert.equal(rasterPointVisible(erased,erased.layers[0],outside),true);
  const restored=addMaskStroke(erased,rasterId,{mode:'restore',size:8,points:[[30,30]]});assert.equal(rasterPointVisible(restored,restored.layers[0],inside),true);
  assert.equal(rasterPointVisible(project,raster,{x:raster.x,y:raster.y}),false,'Unrotated rectangle corner is outside the actual image');
});
test('bound label centers follow rotate, move, resize and reset while text stays upright',()=>{
  let {project,rasterId,labelId}=fixture();const before=structuredClone(project),local=documentPointToLayer(project.layers[0],{x:30,y:30});
  for(const patch of [{rotation:90},{x:80,y:30},{width:320,height:240},{rotation:0},{x:20,y:40}]){
    const old=project.layers[0],labelBefore=project.layers[1],anchor=documentPointToLayer(old,{x:labelBefore.x+labelBefore.width/2,y:labelBefore.y+labelBefore.height/2});
    project=updateLayer(project,rasterId,patch);const current=project.layers[0],label=project.layers.find(item=>item.id===labelId),expected=layerPointToDocument(current,{x:anchor.x*current.width/old.width,y:anchor.y*current.height/old.height});
    near(label.x+label.width/2,expected.x);near(label.y+label.height/2,expected.y);assert.equal(label.rotation,undefined);assert.deepEqual(label.text,before.layers[1].text);
  }
  assert.deepEqual(local,{x:30,y:30});assert.deepEqual(project.layers[1].objectRegion,before.layers[1].objectRegion);assert.deepEqual(project.assets,before.assets);
});
test('selection bounds return rotated AABB while raster region bounds retain transform geometry',()=>{
  const {project,rasterId}=fixture(),rotated=updateLayer(project,rasterId,{rotation:90});
  assert.deepEqual(rasterRegionBounds(rotated,rotated.layers[1]),{x:0,y:0,width:160,height:120,visible:true,opacity:1,rotation:90});
  assert.deepEqual(objectRegionBounds(rotated,rotated.layers[1]),{x:80,y:0,width:40,height:40});
});
test('native rotation and masks survive save/reopen, variants, Undo/Redo and old files',()=>{
  const {project,rasterId}=fixture(),history=new History(project),rotated=updateLayer(project,rasterId,{rotation:450});history.commit(rotated,'Rotate image');
  assert.equal(rotated.layers[0].rotation,90);assert.deepEqual(history.undo(),project);assert.deepEqual(history.redo(),rotated);
  const saved=saveVariant(rotated,'Clockwise'),reopened=parseProject(serializeProject(saved));assert.deepEqual(reopened,saved);
  assert.deepEqual(restoreVariant(updateLayer(reopened,rasterId,{rotation:0}),saved.variants[0].id).layers,rotated.layers);
  assert.equal(parseProject(serializeProject(project)).layers[0].rotation,undefined,'Old files do not receive extra default fields');
  assert.throws(()=>updateLayer(project,project.layers[1].id,{rotation:10}),/image layers/);
  for(const rotation of [NaN,Infinity,'90',null]){const invalid=structuredClone(project);invalid.layers[0].rotation=rotation;assert.throws(()=>parseProject(JSON.stringify(invalid)),/rotation/);}
});
test('Fit canvas to photo includes all rotated native corners and keeps annotation geometry',()=>{
  let {project,rasterId}=fixture();project=updateLayer(project,rasterId,{x:40,y:70,width:80,height:60,rotation:90});
  const sourceLabel=project.layers[1],raster=project.layers[0],anchor=documentPointToLayer(raster,{x:sourceLabel.x+sourceLabel.width/2,y:sourceLabel.y+sourceLabel.height/2});
  const fitted=fitCanvasToImage(project,rasterId);assert.deepEqual([fitted.width,fitted.height],[120,160]);
  assert.deepEqual(layerBounds(fitted.layers[0]),{x:0,y:0,width:120,height:160});assert.equal(fitted.layers[0].rotation,90);
  const label=fitted.layers[1],expected=layerPointToDocument(fitted.layers[0],{x:anchor.x*2,y:anchor.y*2});near(label.x+label.width/2,expected.x);near(label.y+label.height/2,expected.y);
  assert.deepEqual(fitted.assets,project.assets);assert.deepEqual(fitted.layers[1].objectRegion,project.layers[1].objectRegion);assert.equal(canvasImageFitChanges(fitted,rasterId),false);
  const angled=fitCanvasToImage(updateLayer(project,rasterId,{rotation:37}),rasterId),bounds=layerBounds(angled.layers[0]);assert.ok(bounds.x>=-1e-8&&bounds.y>=-1e-8&&bounds.x+bounds.width<=angled.width+1e-8&&bounds.y+bounds.height<=angled.height+1e-8);
});
test('Fit canvas explicitly rejects unrepresentable shear with other editable layers',()=>{
  const {project,rasterId}=fixture(),stretched=updateLayer(project,rasterId,{rotation:30,width:80,height:120}),before=structuredClone(stretched);
  assert.equal(canvasImageFitTarget(stretched,rasterId),null);assert.throws(()=>fitCanvasToImage(stretched,rasterId),/aspect ratio/);assert.deepEqual(stretched,before);
  const single={...stretched,layers:[stretched.layers[0]]};const fitted=fitCanvasToImage(single,rasterId);assert.equal(fitted.layers[0].width,160);assert.equal(fitted.layers[0].height,120);
});
