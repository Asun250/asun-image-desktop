import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addDrawing,addText,attachObjectRegion,updateLayer,addReference,linkReferences,referenceLinks,parseProject,serializeProject,History} from '../public/core.mjs';
import {guidedMarkTargets,unionRegionMasks,regionInteriorPoint,MAX_GUIDED_GROUP_AREAS} from '../public/guided-group.mjs';
import {regionContainsPoint,regionMaskInfo,validateObjectRegion,validateRegionMask,objectRegionContains,MAX_REGION_RUNS} from '../public/object-regions.mjs';

const source='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const picture=(name='Birds.png',width=800,height=600)=>({name,source,width,height});
function mask(width,height,contains) {
  const counts=[];let previous=0,count=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const pixel=Number(contains(x,y));
    if(pixel===previous)count++;else{counts.push(count);count=1;previous=pixel;}
  }
  counts.push(count);return {width,height,counts};
}
function addMark(project,x,y,mode='highlight') {
  return addDrawing(project,{mode,color:'#ffff00',size:12,points:[[x,y],[x+16,y+10]]});
}
function fourMarks() {
  const image=addRaster(newProject(),picture());let project=image.project;const ids=[];
  for(const [x,y] of [[60,60],[600,60],[60,400],[600,400]]){
    const added=addMark(project,x,y);project=added.project;ids.push(added.layerId);
  }
  return {project,ids,rasterId:image.layerId};
}

test('four visible highlight marks on the same raster become four targets in layer order',()=>{
  const {project,ids,rasterId}=fourMarks(),before=serializeProject(project);
  for(const selected of ids) {
    const targets=guidedMarkTargets(project,selected);
    assert.deepEqual(targets.map(item=>item.mark.id),ids);
    assert.ok(targets.every(item=>item.raster.id===rasterId));
    assert.equal(new Set(targets.map(item=>JSON.stringify(item.sourceBox))).size,4,'Each object has its own prompt geometry');
  }
  assert.equal(serializeProject(project),before);
});

test('hidden, transparent, off-board and different-raster highlights are excluded',()=>{
  let {project,ids}=fourMarks();
  project=updateLayer(project,ids[1],{visible:false});
  project=updateLayer(project,ids[2],{opacity:0});
  project=updateLayer(project,ids[3],{x:-1000,y:-1000});
  const another=addRaster(project,picture('Second.png',200,100));
  project=updateLayer(another.project,another.layerId,{x:400,y:300,width:200,height:100});
  const secondMark=addMark(project,450,330);project=secondMark.project;
  assert.deepEqual(guidedMarkTargets(project,ids[0]).map(item=>item.mark.id),[ids[0]]);
  assert.deepEqual(guidedMarkTargets(project,secondMark.layerId).map(item=>item.mark.id),[secondMark.layerId]);
  assert.deepEqual(guidedMarkTargets(project,ids[1]),[]);
  assert.deepEqual(guidedMarkTargets(project,'missing'),[]);
});

test('pencil marks preserve single-mark behavior and cannot collect highlights',()=>{
  const {project,ids}=fourMarks(),pencil=addMark(project,300,200,'pencil');
  assert.deepEqual(guidedMarkTargets(pencil.project,pencil.layerId).map(item=>item.mark.id),[pencil.layerId]);
  assert.deepEqual(guidedMarkTargets(pencil.project,ids[0]).map(item=>item.mark.id),ids);
});

test('group collection bounds excessive highlights and allows hidden marks to be left out',()=>{
  const image=addRaster(newProject(),picture()),single=addMark(image.project,100,100);
  let project=structuredClone(single.project);project.layers=project.layers.slice(0,1);const ids=[];
  for(let index=0;index<=MAX_GUIDED_GROUP_AREAS;index++){
    const drawing=structuredClone(single.project.layers.at(-1));drawing.id=`oversized-input-${index}`;
    project.layers.push(drawing);ids.push(drawing.id);
  }
  assert.throws(()=>guidedMarkTargets(project,ids.at(-1)),/at most 100/);
  project.layers[1].visible=false;
  assert.equal(guidedMarkTargets(project,ids.at(-1)).length,100);
});

test('union preserves all four disconnected objects and leaves unselected background clear',()=>{
  const positions=[[1,1],[14,1],[1,10],[14,10]],masks=positions.map(([left,top])=>mask(20,15,(x,y)=>x>=left&&x<left+3&&y>=top&&y<top+3));
  const original=JSON.stringify(masks),union=unionRegionMasks(masks);
  assert.equal(regionMaskInfo(union).area,36);
  for(const [x,y] of positions)assert.equal(regionContainsPoint(union,x+1,y+1),true);
  assert.equal(regionContainsPoint(union,10,7),false);
  assert.equal(regionContainsPoint(union,5,2),false);
  assert.equal(JSON.stringify(masks),original);
  assert.equal(validateRegionMask(union),union);
});

test('overlapping and duplicate masks union once; holes and end-of-image selections remain canonical',()=>{
  const ring=mask(8,6,(x,y)=>x>=1&&x<=5&&y>=1&&y<=4&&!(x>=2&&x<=4&&y>=2&&y<=3));
  const corner=mask(8,6,(x,y)=>x>=6&&y>=4);
  const union=unionRegionMasks([ring,ring,corner]);
  assert.equal(regionMaskInfo(union).area,18);
  assert.equal(regionContainsPoint(union,3,2),false);
  assert.equal(regionContainsPoint(union,7.9,5.9),true);
  assert.equal(union.counts.length%2,0,'A foreground final run needs no trailing zero');
  const all=unionRegionMasks([{width:8,height:6,counts:[0,48]},ring]);
  assert.deepEqual(all,{width:8,height:6,counts:[0,48]});
  assert.notEqual(unionRegionMasks([ring]).counts,ring.counts);
});

test('invalid, mismatched, empty and overlarge mask groups reject before yielding a mask',()=>{
  const valid=mask(10,10,(x,y)=>x<2&&y<2);
  for(const input of [null,{},[],Array(101).fill(valid)])assert.throws(()=>unionRegionMasks(input),/1 and 100/);
  assert.throws(()=>unionRegionMasks([valid,mask(11,10,(x,y)=>x<2&&y<2)]),/same image dimensions/);
  assert.throws(()=>unionRegionMasks([valid,{width:10,height:10,counts:[100]}]),/mask/);
  const complex=mask(1600,250,x=>x%2===0);
  assert.ok(complex.counts.length<=MAX_REGION_RUNS);
  assert.throws(()=>unionRegionMasks(Array(11).fill(complex)),/too much detail/);
  const odd=mask(1600,400,x=>x%4===1),other=mask(1600,400,x=>x%4===3);
  assert.throws(()=>unionRegionMasks([odd,other]),/combined selection contains too much detail/);
});

test('interior point stays inside a disconnected group even when its centroid is background',()=>{
  const two=mask(20,8,(x,y)=>y>=2&&y<6&&(x<3||x>=17));
  const point=regionInteriorPoint(two);
  assert.equal(regionContainsPoint(two,10,4),false);
  assert.equal(regionContainsPoint(two,point.x,point.y),true);
  assert.equal(point.x,2.5,'Equal-distance candidates use stable row-major order');
  assert.equal(point.y,3.5);
});

test('interior point follows selected-pixel area rather than bounding-box center and avoids holes',()=>{
  const dominant=mask(30,10,(x,y)=>(x<10&&y<10)||(x===29&&y===9)),point=regionInteriorPoint(dominant);
  assert.ok(point.x<10);assert.equal(regionContainsPoint(dominant,point.x,point.y),true);
  const ring=mask(9,9,(x,y)=>x===0||x===8||y===0||y===8),ringPoint=regionInteriorPoint(ring);
  assert.deepEqual(ringPoint,{x:4.5,y:.5});
  assert.deepEqual(regionInteriorPoint({width:1,height:1,counts:[0,1]}),{x:.5,y:.5});
  assert.throws(()=>regionInteriorPoint({width:2,height:2,counts:[4]}),/mask/);
});

test('group metadata accepts only its bounded area count and round-trips with shared references',()=>{
  const {project:initial,rasterId}=fourMarks(),raster=initial.layers.find(item=>item.id===rasterId),asset=initial.assets[raster.assetId];
  const union=unionRegionMasks([mask(80,60,(x,y)=>x<10&&y<10),mask(80,60,(x,y)=>x>60&&y>40)]);
  const label=addText(initial,{content:'1',x:50,y:50,width:30,height:40});
  const region={version:1,assetId:asset.id,rasterLayerId:rasterId,sourceWidth:asset.width,sourceHeight:asset.height,mask:union,group:{areaCount:4}};
  let project=attachObjectRegion(label.project,label.layerId,region);
  project=addReference(project,picture('Bird-reference.png',200,200));
  project=linkReferences(project,label.layerId,[project.references[0].id]);
  project=parseProject(serializeProject(project));
  const restored=project.layers.find(item=>item.id===label.layerId);
  assert.deepEqual(restored.objectRegion.group,{areaCount:4});
  assert.equal(referenceLinks(restored).length,1);
  assert.equal(objectRegionContains(project,restored,[50,50]),true);
  assert.equal(objectRegionContains(project,restored,[700,500]),true);
  assert.equal(objectRegionContains(project,restored,[400,300]),false);
  const history=new History(initial);history.commit(project,'Grouped highlights');
  assert.equal(history.undo().layers.some(item=>item.objectRegion?.group),false);
  assert.deepEqual(history.redo().layers.find(item=>item.id===label.layerId).objectRegion.group,{areaCount:4});
  const withoutGroup={...region};delete withoutGroup.group;
  assert.equal(validateObjectRegion(withoutGroup,project.assets,project.layers),withoutGroup);
  for(const group of [null,[],{},'4',{areaCount:0},{areaCount:101},{areaCount:1.5},{areaCount:'4'},{areaCount:true},{areaCount:4,extra:true}]){
    assert.throws(()=>validateObjectRegion({...region,group},project.assets,project.layers),/grouped object/);
  }
  for(const areaCount of [1,100])assert.doesNotThrow(()=>validateObjectRegion({...region,group:{areaCount}},project.assets,project.layers));
});
