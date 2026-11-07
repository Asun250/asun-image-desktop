import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addText,attachObjectRegion,updateText,updateLayer,duplicateLayer,removeLayer,saveVariant,restoreVariant,serializeProject,parseProject,addReference,linkReferences,updateReferenceAnnotations,addMaskStroke,History} from '../public/core.mjs';
import {validateRegionMask,validateDetectionResult,regionContainsPoint,regionMaskInfo,pickRegion,objectRegionContains,objectRegionBounds,rasterRegionBounds,rasterPointVisible,nextObjectNumber} from '../public/object-regions.mjs';
const source='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function mask(width,height,contains) {
  const counts=[];let previous=0,count=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) { const value=Number(contains(x,y));if(value===previous)count++;else {counts.push(count);count=1;previous=value;} }
  counts.push(count);return {width,height,counts};
}
function selection() {
  let {project,layerId:rasterLayerId}=addRaster(newProject(),{name:'Original.png',source,width:800,height:600});
  const added=addText(project,{content:'1',x:300,y:250,width:30,height:45,fontSize:30});
  project=added.project;
  const region={version:1,assetId:project.layers[0].assetId,rasterLayerId,sourceWidth:800,sourceHeight:600,mask:mask(8,6,(x,y)=>x>=2&&x<6&&y>=1&&y<5&&!(x===3&&y===2))};
  return {project:attachObjectRegion(project,added.layerId,region),rasterLayerId,labelId:added.layerId,region};
}
test('RLE containment follows disconnected foreground and holes, including all-foreground masks',()=> {
  const value=mask(8,6,(x,y)=>(x>=2&&x<6&&y>=1&&y<5&&!(x===3&&y===2))||(x===7&&y===5));
  assert.deepEqual(regionMaskInfo(value),{area:16,bbox:[2,1,6,5]});
  assert.equal(regionContainsPoint(value,2.2,1.8),true);assert.equal(regionContainsPoint(value,3.1,2.1),false);
  assert.equal(regionContainsPoint(value,7,5),true);assert.equal(regionContainsPoint(value,8,5),false);assert.equal(regionContainsPoint(value,-0.1,0),false);assert.equal(regionContainsPoint(value,NaN,0),false);
  const filled={width:2,height:2,counts:[0,4]};assert.equal(validateRegionMask(filled),filled);assert.equal(regionContainsPoint(filled,1.9,1.9),true);
});
test('malformed and excessive selection runs reject before allocation',()=> {
  for(const value of [{width:1601,height:1,counts:[0,1601]},{width:2,height:2,counts:[4]},{width:2,height:2,counts:[1,0,3]},{width:2,height:2,counts:[0,3]},{width:2,height:2,counts:[0,5]},{width:2,height:2,counts:[0,1.5,2.5]},{width:2,height:2,counts:[0,4],unexpected:true}])assert.throws(()=>validateRegionMask(value),/selection mask/);
});
test('detector response validates dimensions and IDs and recomputes overlap geometry from masks',()=> {
  const large=mask(8,6,(x,y)=>x>=1&&x<=6&&y>=1&&y<=4),small=mask(8,6,(x,y)=>x===3&&y===2);
  const result=validateDetectionResult({width:8,height:6,regions:[{id:'table',bbox:[0,0,1,1],area:999,segmentation:large},{id:'cup',segmentation:small}],model:'SAM 2.1',device:'cuda',elapsedMs:25});
  assert.deepEqual(result.regions[0].bbox,[1,1,6,4]);assert.equal(result.regions[0].area,24);
  assert.equal(pickRegion(result.regions,3.5,2.5).id,'cup');assert.equal(pickRegion(result.regions,3.5,2.5,1).id,'table');assert.equal(pickRegion(result.regions,3.5,2.5,-1).id,'table');assert.equal(pickRegion(result.regions,0,0),null);
  assert.throws(()=>validateDetectionResult({width:8,height:6,regions:[{id:'x',segmentation:large},{id:'x',segmentation:small}]}),/duplicate/);
  assert.throws(()=>validateDetectionResult({width:7,height:6,regions:[{id:'x',segmentation:large}]}),/different image/);
  assert.throws(()=>validateDetectionResult({width:8,height:6,regions:Array(257).fill({})}),/too many/);
});
test('saved selections remain native-coordinate annotations through crop, raster move and resize',()=> {
  let {project,rasterLayerId,labelId}=selection();const label=()=>project.layers.find(layer=>layer.id===labelId);
  assert.deepEqual(objectRegionBounds(project,label()),{x:200,y:100,width:400,height:400});assert.equal(objectRegionContains(project,label(),{x:250,y:150}),true);assert.equal(objectRegionContains(project,label(),[350,250]),false);
  project=updateLayer(project,rasterLayerId,{x:-100,y:-50,width:400,height:300});project.width=250;project.height=200;
  assert.deepEqual(objectRegionBounds(project,label()),{x:0,y:0,width:200,height:200});assert.equal(objectRegionContains(project,label(),[25,25]),true);assert.equal(objectRegionContains(project,label(),[75,75]),false);
  project=updateLayer(project,labelId,{x:999,y:999});assert.deepEqual(objectRegionBounds(project,label()),{x:0,y:0,width:200,height:200});
  assert.equal(project.assets[project.original.assetId].source,source);assert.equal(rasterRegionBounds(project,label()).x,-100);
});
test('label editing, photos, history, variants and project reopen retain independent selection data',()=> {
  let {project,labelId}=selection();const history=new History(project);
  project=addReference(project,{name:'Cup.png',source,width:50,height:50});project=linkReferences(project,labelId,[project.references[0].id]);
  project=updateText(project,labelId,{content:'2',color:'#ff0000'});project=saveVariant(project,'Selected cup');history.commit(project,'Number and link');
  assert.equal(history.undo().layers.at(-1).text.content,'1');assert.deepEqual(history.redo(),project);
  const reopened=parseProject(serializeProject(project));assert.deepEqual(reopened,project);
  const duplicate=duplicateLayer(reopened,labelId);duplicate.project.layers.at(-1).objectRegion.mask.counts[0]=123;
  assert.notEqual(duplicate.project.layers.at(-2).objectRegion.mask.counts[0],123);assert.deepEqual(reopened,project);
  const changed=attachObjectRegion(reopened,labelId,null);assert.equal(changed.layers.at(-1).objectRegion,undefined);
  assert.deepEqual(restoreVariant(changed,changed.variants[0].id).layers.at(-1).objectRegion,project.layers.at(-1).objectRegion);
});
test('hiding either linked label or raster suppresses region hit testing and deleting raster detaches safely',()=> {
  const {project,labelId,rasterLayerId}=selection(),point=[250,150];
  for(const [id,patch] of [[labelId,{visible:false}],[labelId,{opacity:0}],[rasterLayerId,{visible:false}],[rasterLayerId,{opacity:0}]]) {
    const changed=updateLayer(project,id,patch);assert.equal(objectRegionContains(changed,changed.layers.find(layer=>layer.id===labelId),point),false);
  }
  const removed=removeLayer(project,rasterLayerId);assert.equal(removed.layers.length,1);assert.equal(removed.layers[0].text.content,'1');assert.equal(removed.layers[0].objectRegion,undefined);assert.equal(removed.assets[project.original.assetId].source,source);
  assert.deepEqual(parseProject(serializeProject(removed)),removed);
});
test('import rejects foreign source bindings, wrong original dimensions, non-text selections and nested reference selections',()=> {
  const {project,labelId,region}=selection();
  for(const patch of [{assetId:'missing'},{rasterLayerId:'missing'},{sourceWidth:799},{version:2},{unexpected:'ignored'}])assert.throws(()=>attachObjectRegion(project,labelId,{...region,...patch}),/detected object/);
  const drawing=structuredClone(project);drawing.layers[0].objectRegion=region;assert.throws(()=>parseProject(JSON.stringify(drawing)),/main scene text/);
  let referenced=addReference(project,{name:'Ref.png',source,width:800,height:600});assert.throws(()=>updateReferenceAnnotations(referenced,referenced.references[0].id,[project.layers.at(-1)]),/nested content/);
});
test('automatic numbering uses the first unused positive whole number, including manual and hidden labels',()=> {
  let project=newProject();for(const content of ['1','03','4','0','1.5','note',' 2 '])project=addText(project,{content,x:0,y:0,width:40,height:40}).project;
  assert.equal(nextObjectNumber(project),'5');project=updateLayer(project,project.layers[0].id,{visible:false});assert.equal(nextObjectNumber(project),'5');project=removeLayer(project,project.layers[0].id);assert.equal(nextObjectNumber(project),'1');
});
test('object hit testing respects native hide/restore strokes after raster transforms',()=> {
  let {project,labelId,rasterLayerId}=selection();project=updateLayer(project,rasterLayerId,{x:100,y:50,width:400,height:300});
  const point={x:225,y:125};assert.equal(objectRegionContains(project,project.layers.at(-1),point),true);
  project=addMaskStroke(project,rasterLayerId,{mode:'hide',size:50,points:[[230,150],[270,150]]});
  assert.equal(rasterPointVisible(project,project.layers[0],point),false);assert.equal(objectRegionContains(project,project.layers.at(-1),point),false);
  project=addMaskStroke(project,rasterLayerId,{mode:'restore',size:8,points:[[250,150]]});assert.equal(objectRegionContains(project,project.layers.find(layer=>layer.id===labelId),point),true);
  assert.equal(rasterPointVisible(project,project.layers[0],{x:99,y:100}),false);assert.equal(project.assets[project.original.assetId].source,source);
});
