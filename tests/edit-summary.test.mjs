import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addText,addDrawing,updateText,updateLayer,attachObjectRegion,removeLayer,addReference,linkReferences,updateReferenceNotes,updateReferenceAnnotations,updateLabelComment,serializeProject,parseProject,saveVariant,restoreVariant,duplicateLayer,History} from '../public/core.mjs';
import {editSummary} from '../public/edit-summary-model.mjs';
import {linkedReferences,linkedLabelComments,referenceBoardPages} from '../public/reference-board.mjs';

const source='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const image=(name='Scene.png')=>({name,source,width:800,height:600});
function label(project,content='1',options={}) {return addText(project,{content,x:100,y:80,width:45,height:50,fontSize:32,...options});}
function fixture() {
  const raster=addRaster(newProject(),image()),added=label(raster.project);
  return {...added,rasterId:raster.layerId};
}
function mask(width,height,contains) {
  const counts=[];let previous=0,count=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {const value=Number(contains(x,y));if(value===previous)count++;else {counts.push(count);count=1;previous=value;}}
  counts.push(count);return {width,height,counts};
}
function region(project,rasterId) {
  const assetId=project.layers.find(layer=>layer.id===rasterId).assetId;
  return {version:1,assetId,rasterLayerId:rasterId,sourceWidth:800,sourceHeight:600,mask:mask(8,6,(x,y)=>x>=2&&x<6&&y>=1&&y<5&&!(x===3&&y===2))};
}
function freeze(value) {if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}

test('summary is derived from current numbered or linked areas, retains pending numbers and never changes project data',()=> {
  let {project,layerId,rasterId}=fixture();
  const linked=label(project,'Cup');project=addReference(linked.project,image('Cup.png'));project=linkReferences(project,linked.layerId,[project.references[0].id]);
  const commented=label(project,'Glass');project=updateLabelComment(commented.project,commented.layerId,'Remove the black bar.\nPreserve the whole scene.');
  const selected=label(project,'Area');project=attachObjectRegion(selected.project,selected.layerId,region(project,rasterId));
  project=label(project,'Scene title').project;project=addDrawing(project,{mode:'highlight',color:'#ffff00',size:30,points:[[1,1],[20,20]]}).project;
  project=addReference(project,image('Unassigned.png'));project.prompt='Keep the camera and composition.\nOnly apply the listed edits.';
  project=saveVariant(project,'Current selection');project.variants[0].layers.push({...structuredClone(project.layers.find(layer=>layer.id===layerId)),id:'variant-only',text:{...project.layers.find(layer=>layer.id===layerId).text,content:'99'}});
  const before=serializeProject(project),summary=editSummary(freeze(project));
  assert.deepEqual(summary.items.map(item=>item.label),['1','Cup','Glass','Area']);
  assert.equal(summary.items[0].pending,true);assert.equal(summary.items[0].status,'pending');assert.equal(summary.items[0].boardIncluded,true);
  assert.equal(summary.items[2].comment,'Remove the black bar.\nPreserve the whole scene.');
  assert.equal(summary.globalPrompt,project.prompt);assert.equal(summary.counts.total,4);assert.equal(summary.counts.unassignedReferences,1);
  assert.equal(summary.items[1].references[0],project.references[0]);assert.equal(serializeProject(project),before);assert.equal(project.version,3);assert.equal(project.assets[project.original.assetId].source,source);
});

test('number order is natural without losing large values and literal labels remain editable',()=> {
  let project=newProject();
  const values=['10','2','note B','01','1','note A','0','9007199254740993','9007199254740992',' 3 '],ids=[];
  for(const content of values) {const added=label(project,content);project=added.project;ids.push(added.layerId);if(content.startsWith('note'))project=updateLabelComment(project,added.layerId,'Keep this area.');}
  const summary=editSummary(project);
  assert.deepEqual(summary.items.map(item=>item.label),['0','01','1','2','3','10','9007199254740992','9007199254740993','note B','note A']);
  assert.equal(summary.items.find(item=>item.label==='3').literalLabel,' 3 ');assert.equal(summary.items.find(item=>item.label==='3').layerId,ids.at(-1));
  assert.equal(summary.items.find(item=>item.label==='1').layerIndex,4);
});

test('multiple and shared reference photos retain exact notes, annotations and sources independently of area comments',()=> {
  let {project,layerId}=fixture();project=addReference(project,image('Glasses.png'));project=addReference(project,image('Side view.png'));
  const [first,second]=project.references.map(reference=>reference.id);
  project=updateReferenceNotes(project,first,'Use only the frame.\nKeep the original face.');
  const annotation=label(newProject(800,600),'Frame',{x:10,y:10}).project.layers;
  project=updateReferenceAnnotations(project,first,annotation);project=linkReferences(project,layerId,[first,second]);project=updateLabelComment(project,layerId,'Replace the glasses.');
  const other=label(project,'2');project=linkReferences(other.project,other.layerId,[first]);
  const summary=editSummary(project);
  assert.equal(summary.items[0].references.length,2);assert.equal(summary.items[0].references[0].notes,'Use only the frame.\nKeep the original face.');
  assert.deepEqual(summary.items[0].references[0].annotations,annotation);assert.equal(summary.items[0].references[0].source,source);
  assert.equal(summary.items[0].references[0],summary.items[1].references[0]);assert.equal(summary.items[0].comment,'Replace the glasses.');assert.equal(summary.items[1].comment,'');
  assert.equal(summary.counts.referenceLinks,3);assert.equal(summary.counts.uniqueReferences,2);assert.equal(summary.counts.withReferences,2);assert.equal(summary.counts.withComments,1);
});

test('comment-only and photo-only instructions become pending when cleared, with no invented reference requirement',()=> {
  let {project,layerId}=fixture();project=updateLabelComment(project,layerId,'Remove black bar and preserve the whole scene.');
  assert.equal(editSummary(project).items[0].status,'ready');assert.equal(editSummary(project).items[0].references.length,0);
  project=updateLabelComment(project,layerId,'');assert.equal(editSummary(project).items[0].status,'pending');
  project=addReference(project,image('Reference.png'));project=linkReferences(project,layerId,[project.references[0].id]);assert.equal(editSummary(project).items[0].status,'ready');
  project=linkReferences(project,layerId,[]);assert.equal(editSummary(project).items[0].status,'pending');assert.equal(editSummary(project).counts.unassignedReferences,1);
});

test('hidden, transparent and off-canvas labels stay in the whole summary with accurate board exclusion reasons',()=> {
  let project=newProject(800,600);
  for(const [content,patch] of [['1',{visible:false}],['2',{opacity:0}],['3',{x:800}],['4',{y:-50}],['5',{x:-44}],['6',{visible:false,opacity:0,x:900}]]) {
    const added=label(project,content);project=updateLayer(updateLabelComment(added.project,added.layerId,`Edit ${content}`),added.layerId,patch);
  }
  const summary=editSummary(project);
  assert.deepEqual(summary.items.map(item=>item.boardIncluded),[false,false,false,false,true,false]);
  assert.deepEqual(summary.items[0].exclusionReasons,['Label is hidden.']);assert.deepEqual(summary.items[1].exclusionReasons,['Label opacity is zero.']);assert.deepEqual(summary.items[2].exclusionReasons,['Label is outside the canvas.']);
  assert.equal(summary.items[5].exclusionReasons.length,3);assert.equal(summary.items[5].status,'excluded');assert.equal(summary.counts.excluded,5);
  assert.deepEqual(linkedLabelComments(project).map(group=>group.label),['5']);
});

test('detected region previews follow the source raster transform while native crop and original bytes remain stable',()=> {
  let {project,layerId,rasterId}=fixture();project=attachObjectRegion(project,layerId,region(project,rasterId));
  const original=editSummary(project).items[0];
  assert.deepEqual(original.regionBounds,{x:200,y:100,width:400,height:400});assert.deepEqual(original.regionSource.nativeBounds,{x:200,y:100,width:400,height:400});
  project=updateLayer(project,rasterId,{x:-100,y:-50,width:400,height:300});project=updateLayer(project,layerId,{x:20,y:30});project.width=250;project.height=200;
  const item=editSummary(project).items[0];assert.deepEqual(item.regionBounds,{x:0,y:0,width:200,height:200});assert.deepEqual(item.regionSource.nativeBounds,original.regionSource.nativeBounds);
  assert.deepEqual(item.labelBounds,{x:20,y:30,width:45,height:50});assert.equal(item.regionSource.asset.source,source);assert.equal(item.regionSource.raster,project.layers[0]);assert.equal(item.objectRegion,project.layers.at(-1).objectRegion);
});

test('hidden or cropped source regions warn separately from still-visible board instructions and safe raster deletion',()=> {
  let {project,layerId,rasterId}=fixture();project=updateLabelComment(attachObjectRegion(project,layerId,region(project,rasterId)),layerId,'Change this selected area.');
  project=updateLayer(project,rasterId,{visible:false,x:900});
  // Move the independently editable instruction back onto the board after its
  // source-bound label follows the raster out of the canvas.
  project=updateLayer(project,layerId,{x:100,y:80});
  const item=editSummary(project).items[0];assert.equal(item.boardIncluded,true);assert.equal(item.status,'ready');assert.equal(item.warnings.length,2);assert.equal(item.exclusionReasons.length,0);
  assert.deepEqual(linkedLabelComments(project).map(group=>group.label),['1']);
  project=removeLayer(project,rasterId);const removed=editSummary(project).items[0];assert.equal(removed.objectRegion,null);assert.equal(removed.regionSource,null);assert.equal(removed.regionBounds,null);assert.equal(removed.comment,'Change this selected area.');assert.equal(project.assets[project.original.assetId].source,source);
});

test('rotated selected areas warn only when their actual rectangle is outside the canvas',()=> {
  let {project,layerId,rasterId}=fixture();const selected=region(project,rasterId);selected.mask={width:1,height:1,counts:[0,1]};
  project=attachObjectRegion(project,layerId,selected);project.width=100;project.height=100;
  project=updateLayer(project,rasterId,{x:110,y:0,width:20,height:120,rotation:90});
  project=updateLayer(project,layerId,{x:10,y:10});
  const visible=editSummary(project).items[0];assert.equal(visible.boardIncluded,true);assert.deepEqual(visible.warnings,[]);
  project=updateLayer(project,rasterId,{x:80,y:125,width:100,height:10,rotation:-45});
  project=updateLayer(project,layerId,{x:10,y:10});
  const outside=editSummary(project).items[0];assert.equal(outside.boardIncluded,true);assert.match(outside.warnings[0],/outside the canvas/);
  assert.deepEqual(outside.regionSource.nativeBounds,visible.regionSource.nativeBounds);
});

test('duplicate labels flag exactly the board ambiguity rule while identical or reordered reference lists remain valid',()=> {
  let {project,layerId}=fixture();project=addReference(project,image('First.png'));project=addReference(project,image('Second.png'));const ids=project.references.map(reference=>reference.id);
  project=updateLabelComment(linkReferences(project,layerId,ids),layerId,'Keep the camera.');const duplicate=duplicateLayer(project,layerId);project=linkReferences(duplicate.project,duplicate.layerId,[...ids].reverse());
  assert.equal(editSummary(project).counts.conflicts,0);assert.equal(linkedReferences(project).length,2);assert.equal(linkedLabelComments(project).length,1);
  project=updateLabelComment(project,duplicate.layerId,'Move the camera.');
  let summary=editSummary(project);assert.equal(summary.counts.conflicts,2);assert.ok(summary.items.every(item=>item.status==='conflict'&&item.conflictReasons.length===1));assert.throws(()=>referenceBoardPages(project),/different instructions/);
  project=linkReferences(project,duplicate.layerId,[ids[0]]);summary=editSummary(project);assert.ok(summary.items.every(item=>item.conflictReasons.length===2));assert.throws(()=>referenceBoardPages(project),/different photos/);
  project=updateLayer(project,duplicate.layerId,{visible:false});summary=editSummary(project);assert.equal(summary.counts.conflicts,0);assert.equal(summary.items.find(item=>item.layerId===duplicate.layerId).status,'excluded');
});

test('a visible ordinary text duplicate participates in board conflicts without turning unrelated titles into summary areas',()=> {
  let project=newProject();const first=label(project,'Glasses');project=updateLabelComment(first.project,first.layerId,'Use thinner frames.');project=label(project,'Glasses').project;project=label(project,'Other title').project;
  const summary=editSummary(project);assert.equal(summary.items.length,1);assert.equal(summary.items[0].conflict,true);assert.throws(()=>referenceBoardPages(project),/different instructions/);
});

test('rename, delete, undo, redo, reopening and restored variants regenerate the whole summary without stale cards',()=> {
  let {project,layerId}=fixture();project=updateLabelComment(project,layerId,'Remove black bar.');project.prompt='Preserve the scene.';project=saveVariant(project,'Before change');
  const history=new History(project),before=editSummary(project);
  project=updateText(project,layerId,{content:'10'});project=updateLabelComment(project,layerId,'Only apply snow caps.');project.prompt='Keep the crop.';history.commit(project,'Revise area');
  assert.deepEqual(editSummary(history.undo()),before);assert.equal(editSummary(history.redo()).items[0].label,'10');
  assert.deepEqual(editSummary(parseProject(serializeProject(project))),editSummary(project));
  const restored=restoreVariant(project,project.variants[0].id);assert.deepEqual(editSummary(restored),before);
  const removed=removeLayer(project,layerId);history.commit(removed,'Remove area');assert.equal(editSummary(removed).counts.total,0);assert.equal(editSummary(history.undo()).items[0].comment,'Only apply snow caps.');assert.equal(editSummary(history.redo()).counts.total,0);
});

test('empty and older projects do not add metadata, and whitespace-only stored comments do not create instruction content',()=> {
  const project=newProject(),before=serializeProject(project);assert.deepEqual(editSummary(project).items,[]);assert.equal(editSummary(project).globalPrompt,'');assert.equal(editSummary(project).counts.total,0);assert.equal(serializeProject(project),before);
  const added=label(project,'1');added.project.layers.at(-1).referenceComment=' \n ';
  assert.equal(editSummary(added.project).items[0].pending,true);assert.equal(editSummary(added.project).counts.withComments,0);assert.equal(editSummary(added.project).counts.conflicts,0);
});
