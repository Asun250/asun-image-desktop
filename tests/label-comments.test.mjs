import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject,addRaster,addText,addDrawing,updateText,updateLayer,attachObjectRegion,removeLayer,addReference,linkReferences,removeReference,referenceLinks,updateReferenceAnnotations,labelComment,updateLabelComment,MAX_LABEL_COMMENT_LENGTH,serializeProject,parseProject,saveVariant,restoreVariant,duplicateLayer,History,VERSION} from '../public/core.mjs';
const source='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const image=(name='Scene.png')=>({name,source,width:800,height:600});
function fixture() {
  const {project,layerId:rasterId}=addRaster(newProject(),image());
  const added=addText(project,{content:'1',x:100,y:80,width:45,height:50,fontSize:32});
  return {project:added.project,labelId:added.layerId,rasterId};
}
test('a numbered label stores a comment without photos and preserves inner formatting and original bytes',()=> {
  const {project,labelId}=fixture(),snapshot=structuredClone(project);
  const commented=updateLabelComment(project,labelId,'  Only apply snow caps.\nKeep the mountain  shape.\n\nUse café colours.  '),label=commented.layers.at(-1);
  assert.equal(labelComment(label),'Only apply snow caps.\nKeep the mountain  shape.\n\nUse café colours.');assert.equal(commented.references.length,0);assert.deepEqual(referenceLinks(label),[]);
  assert.deepEqual(project,snapshot);assert.equal(commented.assets[commented.original.assetId].source,source);assert.equal(commented.version,3);
});
test('comment helper safely handles older absent fields and empty updates do not introduce metadata',()=> {
  const {project,labelId}=fixture();
  assert.equal(labelComment(undefined),'');assert.equal(labelComment(null),'');assert.equal(labelComment(project.layers.at(-1)),'');assert.equal(labelComment({referenceComment:12}),'');
  const empty=updateLabelComment(project,labelId,' \n\t ');assert.deepEqual(empty,project);assert.equal(Object.hasOwn(empty.layers.at(-1),'referenceComment'),false);
  const history=new History(project);assert.equal(history.commit(empty,'Empty comment'),false);
  const reopened=parseProject(serializeProject(project));assert.deepEqual(reopened,project);assert.equal(reopened.version,VERSION);assert.equal(Object.hasOwn(reopened.layers.at(-1),'referenceComment'),false);
});
test('comment input rejects invalid types and raw length before trimming, while exactly 2000 characters are allowed',()=> {
  const {project,labelId}=fixture();assert.equal(MAX_LABEL_COMMENT_LENGTH,2000);
  for(const value of [null,undefined,1,[],{},new String('text'),'x'.repeat(2001),' '.repeat(2001)])assert.throws(()=>updateLabelComment(project,labelId,value),/comments must be text up to 2000/);
  const accepted=updateLabelComment(project,labelId,'x'.repeat(2000));assert.equal(labelComment(accepted.layers.at(-1)).length,2000);assert.equal(Object.hasOwn(project.layers.at(-1),'referenceComment'),false);
});
test('clearing a comment keeps photo links and clearing or deleting photos keeps the label comment',()=> {
  let {project,labelId}=fixture();project=addReference(project,image('Snow.png'));project=addReference(project,image('Rock.png'));
  const ids=project.references.map(reference=>reference.id);project=linkReferences(project,labelId,ids);project=updateLabelComment(project,labelId,'Only apply snow caps.');
  const cleared=updateLabelComment(project,labelId,' \n ');assert.deepEqual(referenceLinks(cleared.layers.at(-1)),ids);assert.equal(Object.hasOwn(cleared.layers.at(-1),'referenceComment'),false);
  const unlinked=linkReferences(project,labelId,[]);assert.equal(labelComment(unlinked.layers.at(-1)),'Only apply snow caps.');assert.deepEqual(referenceLinks(unlinked.layers.at(-1)),[]);
  const removed=removeReference(project,ids[0]);assert.equal(labelComment(removed.layers.at(-1)),'Only apply snow caps.');assert.deepEqual(referenceLinks(removed.layers.at(-1)),[ids[1]]);assert.deepEqual(project.references.map(reference=>reference.id),ids);
});
test('history, duplicate, variants and save/reopen retain comments as independent editable label state',()=> {
  const {project:original,labelId}=fixture(),history=new History(original);
  let project=updateLabelComment(original,labelId,'Only apply snow caps.');project=saveVariant(project,'Snow instructions');history.commit(project,'Comment');
  const changed=updateLabelComment(project,labelId,'Make the grass realistic.');history.commit(changed,'Revise comment');assert.equal(labelComment(history.undo().layers.at(-1)),'Only apply snow caps.');assert.equal(labelComment(history.redo().layers.at(-1)),'Make the grass realistic.');
  const reopened=parseProject(serializeProject(changed));assert.deepEqual(reopened,changed);
  const restored=restoreVariant(reopened,reopened.variants[0].id);assert.equal(labelComment(restored.layers.at(-1)),'Only apply snow caps.');
  const duplicate=duplicateLayer(restored,labelId),edited=updateLabelComment(duplicate.project,duplicate.layerId,'Only adjust this copy.');assert.equal(labelComment(edited.layers.find(layer=>layer.id===labelId)),'Only apply snow caps.');assert.equal(labelComment(edited.layers.at(-1)),'Only adjust this copy.');assert.equal(edited.assets[edited.original.assetId].source,source);
});
test('auto-detected region, label styling and raster transforms coexist with comments without changing the source',()=> {
  let {project,labelId,rasterId}=fixture();
  const region={version:1,assetId:project.original.assetId,rasterLayerId:rasterId,sourceWidth:800,sourceHeight:600,mask:{width:8,height:6,counts:[0,48]}};
  project=attachObjectRegion(project,labelId,region);project=updateLabelComment(project,labelId,'Only change the laptop screen.');project=updateText(project,labelId,{content:'2',color:'#ff0000'});project=updateLayer(project,rasterId,{x:-50,y:-20,width:400,height:300});
  const reopened=parseProject(serializeProject(project));assert.deepEqual(reopened.layers.at(-1).objectRegion,region);assert.equal(labelComment(reopened.layers.at(-1)),'Only change the laptop screen.');assert.equal(reopened.layers.at(-1).text.content,'2');assert.equal(reopened.assets[reopened.original.assetId].source,source);
  const removed=removeLayer(reopened,rasterId);assert.equal(removed.layers.at(-1).objectRegion,undefined);assert.equal(labelComment(removed.layers.at(-1)),'Only change the laptop screen.');assert.equal(removed.assets[removed.original.assetId].source,source);
});
test('validation rejects comments on non-text layers, nested reference annotations and malformed current or variant comments',()=> {
  const {project,labelId,rasterId}=fixture();assert.throws(()=>updateLabelComment(project,rasterId,'No'),/main scene text label/);assert.throws(()=>updateLabelComment(project,'missing','No'),/main scene text label/);
  const drawing=addDrawing(project,{mode:'pencil',color:'#ff0000',size:4,points:[[10,10],[20,20]]});assert.throws(()=>updateLabelComment(drawing.project,drawing.layerId,'No'),/main scene text label/);
  for(const base of [project,drawing.project]) {const malformed=structuredClone(base);malformed.layers[base===project?0:2].referenceComment='No';assert.throws(()=>parseProject(JSON.stringify(malformed)),/main scene text labels/);}
  for(const value of [null,123,{},'x'.repeat(2001)]) {const malformed=structuredClone(project);malformed.layers.at(-1).referenceComment=value;assert.throws(()=>parseProject(JSON.stringify(malformed)),/comments must be text up to 2000/);}
  const withVariant=saveVariant(updateLabelComment(project,labelId,'Valid'),'With comments');withVariant.variants[0].layers.at(-1).referenceComment=[];assert.throws(()=>parseProject(JSON.stringify(withVariant)),/comments must be text up to 2000/);
  const reference=addReference(project,image('Reference.png'));const nested=structuredClone(project.layers.at(-1));nested.referenceComment='Do not embed this';assert.throws(()=>updateReferenceAnnotations(reference,reference.references[0].id,[nested]),/nested content/);
});
