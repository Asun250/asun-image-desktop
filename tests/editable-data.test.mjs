import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cloneEditableData,sameEditableData} from '../public/editable-data.mjs';
import {newProject,addRaster,addReference,updateLayer,addMaskStroke,History,serializeProject,parseProject,validateProject} from '../public/core.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
test('editable snapshots detach masks, metadata, references and sparse arrays',()=>{
  const data={source:png.repeat(20000),nested:[{points:[[1,2],[3,4]]}],sparse:new Array(3)};
  data.sparse[2]='last';data.alias=data.nested;data.self=data;
  Object.defineProperty(data,'__proto__',{value:{safe:true},enumerable:true});
  const result=cloneEditableData(data);
  assert.equal(result.source,data.source);assert.equal(result.alias,result.nested);assert.equal(result.self,result);
  assert.equal(result.sparse.length,3);assert.equal(0 in result.sparse,false);
  assert.equal(Object.getPrototypeOf(result),Object.prototype);assert.equal(result.__proto__.safe,true);
  result.nested[0].points[0][0]=999;assert.equal(data.nested[0].points[0][0],1);
  assert.throws(()=>cloneEditableData({callback:()=>{}}),{name:'DataCloneError'});
  assert.throws(()=>cloneEditableData({marker:Symbol('invalid')}),{name:'DataCloneError'});
});
test('state comparison detects edits without serializing image bytes',()=>{
  const data={image:png.repeat(20000),layers:[{x:1,mask:[{points:[[1,2]],size:5}]}]};
  const next=cloneEditableData(data);assert.equal(sameEditableData(data,next),true);
  next.layers[0].mask[0].points[0][1]=3;assert.equal(sameEditableData(data,next),false);
  assert.equal(sameEditableData({a:undefined},{}),false);
  assert.equal(sameEditableData(new Array(2),new Array(3)),false);
  assert.equal(sameEditableData({x:'A'},{x:'B'}),false);
});
test('history retains all originals and exact editable selections after reset, undo and later edits',()=>{
  let {project,layerId}=addRaster(newProject(),{name:'original.png',source:png,width:480,height:320});
  project=addReference(project,{name:'reference.png',source:png,width:100,height:100});
  project=addMaskStroke(project,layerId,{mode:'hide',size:20,points:[[10,10],[30,50]]});
  const history=new History(project);const moved=updateLayer(project,layerId,{x:40,rotation:15});
  assert.equal(history.commit(moved,'Move'),true);assert.equal(history.commit(cloneEditableData(moved),'No change'),false);
  history.commit(newProject(),'Fresh project');assert.equal(history.project.layers.length,0);
  const undo=history.undo();assert.deepEqual(undo,moved);
  undo.layers[0].mask[0].points[0][0]=444;undo.references[0].name='changed';
  assert.deepEqual(history.project,moved);assert.deepEqual(history.undo(),project);
  assert.deepEqual(parseProject(serializeProject(history.redo())),moved);
  const invalid=cloneEditableData(moved);invalid.references[0].source='not an image';
  assert.throws(()=>history.commit(invalid,'Invalid'),/reference/);
  assert.deepEqual(history.project,moved);validateProject(history.project);
});
