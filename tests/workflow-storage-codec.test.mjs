import test from 'node:test';
import assert from 'node:assert/strict';
import {captureWorkflowGraph,restoreWorkflowGraph,sameWorkflowGraph,registerDetachedWorkflowSnapshot} from '../public/workflow-storage-codec.mjs';
const restore=graph=>restoreWorkflowGraph(graph.root,graph.segments,graph.strings);

test('graph capture interns repeated images once and keeps cross-tab aliases, cycles and arbitrary metadata',()=>{
  const source='data:image/png;base64,'+'a'.repeat(20000),shared={source};
  const session={tabs:[{id:'a',project:shared},{id:'b',project:shared}],activeId:'a',unknown:{big:2n,empty:undefined,number:NaN}};
  session.self=session;session.tabs[0].history=[shared,shared];
  const graph=captureWorkflowGraph(session);shared.source='mutated';session.tabs[0].history.push({});
  const saved=restore(graph);assert.equal(saved.tabs[0].project.source,source);assert.equal(saved.tabs[0].history.length,2);
  assert.equal(saved.tabs[0].project,saved.tabs[1].project);assert.equal(saved.self,saved);assert.equal(graph.strings.size,1);
  assert.deepEqual(saved.unknown,{big:2n,empty:undefined,number:NaN});assert.equal(graph.segments.size,3);
});

test('unsafe-looking object keys stay own properties without changing prototypes',()=>{
  const session=JSON.parse('{"tabs":[{"id":"__proto__","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}],"activeId":"__proto__"}');
  const saved=restore(captureWorkflowGraph(session));assert.equal(Object.getPrototypeOf(saved.tabs[0]),Object.prototype);
  assert.equal(Object.hasOwn(saved.tabs[0],'__proto__'),true);assert.equal(saved.tabs[0].__proto__.polluted,true);assert.equal({}.polluted,undefined);
  assert.deepEqual(saved,session);
});

test('map, set, native data and sparse arrays remain exact invocation snapshots',()=>{
  const object={value:1},sparse=new Array(3);sparse[2]='last';sparse.note='kept';
  const session={tabs:[{id:'a',map:new Map([[object,new Set([object])]]),date:new Date('2026-10-23'),bytes:new Uint8Array([1,2]),sparse}],activeId:'a'};
  const graph=captureWorkflowGraph(session);object.value=2;session.tabs[0].bytes[0]=9;session.tabs[0].date.setFullYear(2000);
  const saved=restore(graph).tabs[0],key=[...saved.map.keys()][0];assert.equal(key.value,1);assert.equal(saved.map.get(key).has(key),true);
  assert.deepEqual([...saved.bytes],[1,2]);assert.equal(saved.date.getFullYear(),2026);assert.equal(saved.sparse.length,3);assert.equal(0 in saved.sparse,false);assert.equal(saved.sparse.note,'kept');
});

test('only changed segments differ and special primitive values cannot compare equal by accident',()=>{
  const source='x'.repeat(20000),interns=new Map(),session={tabs:[{id:'a',source},{id:'b',source}],activeId:'a'};
  const before=captureWorkflowGraph(session,interns);session.activeId='b';const after=captureWorkflowGraph(session,interns);
  assert.equal(sameWorkflowGraph(before.segments.get('workspace'),after.segments.get('workspace')),false);
  for(const id of ['tab:a','tab:b'])assert.equal(sameWorkflowGraph(before.segments.get(id),after.segments.get(id)),true);
  assert.equal(sameWorkflowGraph({value:NaN},{value:null}),false);assert.equal(sameWorkflowGraph({value:undefined},{other:undefined}),false);
  assert.equal(sameWorkflowGraph({value:-0},{value:0}),false);
});

test('missing graph/string pointers and unknown node kinds reject instead of losing fields',()=>{
  const graph=captureWorkflowGraph({tabs:[{id:'a',source:'x'.repeat(20000)}],activeId:'a'});
  assert.throws(()=>restoreWorkflowGraph(graph.root,graph.segments,new Map()),{code:'WORKFLOW_STORAGE_INVALID'});
  graph.segments.get('tab:a').nodes[0].kind='future-kind';assert.throws(()=>restore(graph),{code:'WORKFLOW_STORAGE_INVALID'});
});

test('detached inactive sessions reuse encoded history while tab metadata stays current',()=>{
  const source='data:image/png;base64,'+'a'.repeat(20000),interns=new Map(),sessionCache=new WeakMap();
  const snapshot={workspace:{project:{source,prompt:'Original'},history:{entries:[{project:{source}}],index:0}}};
  const session={tabs:[{id:'old',session:snapshot,jobIds:[],name:'Old'},{id:'new',session:{workspace:{project:{prompt:''}}},jobIds:[]}],activeId:'new'};
  const options={detachedTabSessions:true,sessionCache},before=captureWorkflowGraph(session,interns,options);
  const oldSegment=[...before.segments.keys()].find(key=>key.startsWith('session:'));
  session.tabs[0].name='Renamed';session.tabs[0].jobIds.push({id:'job',kind:'image'});
  session.tabs[1].session={workspace:{project:{prompt:'New prompt'}}};
  const after=captureWorkflowGraph(session,interns,options),saved=restore(after);
  assert.equal(after.segments.get(oldSegment),before.segments.get(oldSegment),'the inactive history is not recaptured or deep-compared');
  assert.deepEqual(saved,session);assert.equal(saved.tabs[0].session.workspace.project.source,source);
  assert.equal(restore(before).tabs[0].name,'Old');assert.equal(restore(before).tabs[0].jobIds.length,0);
  assert.equal(restore(before).tabs[1].session.workspace.project.prompt,'');
});

test('removing a detached tab removes its encoded history and unused image strings',()=>{
  const interns=new Map(),sessionCache=new WeakMap(),options={detachedTabSessions:true,sessionCache};
  const session={tabs:[{id:'old',session:{source:'x'.repeat(20000),history:[{mask:[[1,2],[3,4]]}]}},{id:'blank',session:{project:{layers:[]}}}],activeId:'blank'};
  const before=captureWorkflowGraph(session,interns,options);assert.equal(before.strings.size,1);
  session.tabs.shift();const after=captureWorkflowGraph(session,interns,options);
  assert.equal(after.strings.size,0);assert.deepEqual(restore(after),session);
  assert(after.segments.size<before.segments.size);
});

test('default mutable captures remain fresh even when a detached cache is supplied',()=>{
  const interns=new Map(),sessionCache=new WeakMap(),session={tabs:[{id:'a',session:{prompt:'First'}}],activeId:'a'};
  const before=captureWorkflowGraph(session,interns,{sessionCache});session.tabs[0].session.prompt='Changed';
  const after=captureWorkflowGraph(session,interns,{sessionCache});assert.equal(restore(before).tabs[0].session.prompt,'First');assert.equal(restore(after).tabs[0].session.prompt,'Changed');
});

test('detached sessions preserve internal aliases, cycles and shared session roots',()=>{
  const item={mask:[[1,2],[3,4]]},snapshot={project:item,history:[item]};snapshot.self=snapshot;
  const session={tabs:[{id:'a',session:snapshot},{id:'b',session:snapshot}],activeId:'a'},options={detachedTabSessions:true,sessionCache:new WeakMap()};
  const before=captureWorkflowGraph(session,new Map(),options),saved=restore(before);
  assert.equal(saved.tabs[0].session,saved.tabs[1].session);assert.equal(saved.tabs[0].session.self,saved.tabs[0].session);assert.equal(saved.tabs[0].session.project,saved.tabs[0].session.history[0]);
  session.tabs.shift();session.activeId='b';assert.equal(restore(captureWorkflowGraph(session,new Map(),options)).tabs[0].id,'b');
});

test('replacing an active session reuses registered immutable Undo snapshots without scanning their points',()=>{
  let reads=0;
  const points=Array.from({length:500},(_,i)=>[i,i]);
  const entry=registerDetachedWorkflowSnapshot({label:'Old brush stroke',project:{layers:[{drawing:{get points(){reads++;return points;}}}]}});
  const session={tabs:[{id:'active',session:{workspace:{project:{layers:[]},history:{entries:[entry],index:0}}}}],activeId:'active'};
  const options={detachedTabSessions:true,sessionCache:new WeakMap()},interns=new Map();
  const before=captureWorkflowGraph(session,interns,options),beforeReads=reads;
  session.tabs[0].session={workspace:{project:{layers:[],prompt:'Blank project after delete'},history:{entries:[entry],index:0}}};
  const after=captureWorkflowGraph(session,interns,options);
  assert.equal(reads,beforeReads,'unchanged Undo points are not walked again');
  const reused=[...before.segments].filter(([id,segment])=>after.segments.get(id)===segment);assert.equal(reused.length,1);
  assert.deepEqual(restore(after).tabs[0].session.workspace.history.entries[0].project.layers[0].drawing.points,points);
  // Generic snapshots must still reflect caller mutation despite registration.
  points[0][0]=99;const mutable=captureWorkflowGraph(session,interns);assert.equal(restore(mutable).tabs[0].session.workspace.history.entries[0].project.layers[0].drawing.points[0][0],99);
});
