import {test} from 'node:test';
import assert from 'node:assert/strict';
import {History,newProject,addText} from '../public/core.mjs';
import {cloneWorkflowData,encodeWorkspaceSession,decodeWorkspaceSession} from '../public/workflow-session-codec.mjs';
import {captureWorkflowGraph,restoreWorkflowGraph} from '../public/workflow-storage-codec.mjs';

test('workflow snapshots retain independent current edits, undo and redo without copying immutable image text',()=>{
  let project=newProject(400,300,'Independent draft');const history=new History(project);
  project=addText(project,{content:'First',x:10,y:10,width:90,height:30,fontSize:24}).project;history.commit(project,'Text');
  project={...project,prompt:'Latest instruction'};history.commit(project,'Instruction');project=history.undo();
  const captured=encodeWorkspaceSession({project,history,view:{x:2,y:3,zoom:1.5,angle:20},brushSettings:{mask:8}});
  project.layers[0].text.content='Later mutation';history.commit({...project,prompt:'Later branch'},'Branch');
  const first=decodeWorkspaceSession(captured),second=decodeWorkspaceSession(captured);
  assert.equal(first.project.layers[0].text.content,'First');assert(first.history.canRedo);
  assert.equal(first.history.redo().prompt,'Latest instruction');assert.equal(second.history.index,1);
  first.project.layers[0].text.content='Another tab';first.brushSettings.mask=999;
  assert.equal(second.project.layers[0].text.content,'First');assert.equal(second.brushSettings.mask,8);
  assert.deepEqual(second.view,{x:2,y:3,zoom:1.5,angle:20});
});

test('loaded workspace data still rejects damaged project and history before restoration',()=>{
  const project=newProject(),valid=encodeWorkspaceSession({project,history:new History(project)});
  const damaged=structuredClone(valid);damaged.history.entries[0].project.width=-1;
  assert.throws(()=>decodeWorkspaceSession(damaged));
  const badIndex=structuredClone(valid);badIndex.history.index=5;assert.throws(()=>decodeWorkspaceSession(badIndex),/undo history/);
  const badView=structuredClone(valid);badView.view={zoom:0};assert.throws(()=>decodeWorkspaceSession(badView),/view/);
});

test('workflow graph copying preserves aliasing and safe own keys without mutating the caller',()=>{
  const source='data:image/png;base64,'+'a'.repeat(2_000_000),shared={source,notes:['original']};
  const input={first:shared,second:shared};Object.defineProperty(input,'__proto__',{value:{safe:true},enumerable:true});input.self=input;
  const clone=cloneWorkflowData(input);assert.notEqual(clone,input);assert.equal(clone.first,clone.second);assert.equal(clone.self,clone);
  assert.equal(clone.first.source,source);clone.first.notes.push('new');assert.deepEqual(shared.notes,['original']);
  assert.equal(Object.getPrototypeOf(clone),Object.prototype);assert.deepEqual(clone.__proto__,{safe:true});assert.equal({}.safe,undefined);
});

test('desktop snapshots reuse detached old undo entries after clearing a project while retaining exact recovery',()=>{
  let project=addText(newProject(),{content:'Keep my scene',x:5,y:5,width:200,height:60,fontSize:24}).project;
  const history=new History(project),options={reuseHistoryEntries:true};
  const first=encodeWorkspaceSession({project,history},options);
  history.commit({...project,prompt:'Use all references'},'Instruction');project=history.project;
  const second=encodeWorkspaceSession({project,history},options);
  assert.equal(first.history.entries[0],second.history.entries[0]);
  assert.notEqual(first.history.entries[0],history.entries[0]);
  history.commit(newProject(),'Fresh canvas');project=history.project;
  const cleared=encodeWorkspaceSession({project,history},options);
  assert.equal(cleared.history.entries[1],second.history.entries[1]);
  const sessionCache=new WeakMap(),interns=new Map(),pack=workspace=>captureWorkflowGraph({activeId:'a',tabs:[{id:'a',session:{workspace}}]},interns,{detachedTabSessions:true,sessionCache});
  const before=pack(second),after=pack(cleared);
  const reused=[...before.segments].filter(([id,part])=>after.segments.get(id)===part);
  assert.ok(reused.length>=2,'Both unchanged Undo entries bypass recapture');
  const restored=restoreWorkflowGraph(after.root,after.segments,after.strings);
  const decoded=decodeWorkspaceSession(restored.tabs[0].session.workspace);
  assert.equal(decoded.project.layers.length,0);
  assert.equal(decoded.history.undo().prompt,'Use all references');
  decoded.history.entries[0].project.layers[0].text.content='another tab';
  assert.equal(first.history.entries[0].project.layers[0].text.content,'Keep my scene');
});
