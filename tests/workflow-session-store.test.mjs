import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowSessionStore} from '../public/workflow-session-store.mjs';
const valid=()=>({tabs:[{id:'first',project:{name:'Untitled'}}],activeId:'first'});

test('unavailable IndexedDB reports an actionable error and never claims a successful save',async()=>{
  const errors=[],store=createWorkflowSessionStore({indexedDB:null,onError:error=>errors.push(error)});
  await assert.rejects(store.load(),error=>error.code==='WORKFLOW_STORAGE_UNAVAILABLE'&&/IndexedDB/.test(error.message));
  await assert.rejects(store.save(valid()),error=>error.code==='WORKFLOW_STORAGE_UNAVAILABLE');
  assert.equal(errors.length,2);await store.close();
});

test('invalid tabs, active selection and duplicate IDs fail before opening storage',async()=>{
  let opens=0;const store=createWorkflowSessionStore({indexedDB:{open(){opens++;throw new Error('Should not open');}}});
  const invalid=[null,{}, {tabs:[],activeId:'missing'},{tabs:[{id:'one'}],activeId:'other'}, {tabs:[{id:'one'},{id:'one'}],activeId:'one'},{tabs:[{id:''}],activeId:''}];
  for(const session of invalid)await assert.rejects(store.save(session),error=>error.code==='WORKFLOW_STORAGE_INVALID');
  assert.equal(opens,0);await store.close();
});

test('uncloneable data and error callbacks cannot damage operation outcomes',async()=>{
  const store=createWorkflowSessionStore({indexedDB:null,onError(){throw new Error('Broken toast');}}),session=valid();session.tabs[0].handler=()=>{};
  await assert.rejects(store.save(session),error=>error.code==='WORKFLOW_STORAGE_INVALID'&&/cannot be saved/.test(error.message));await store.close();
});

test('closed storage explicitly rejects subsequent reads and saves',async()=>{
  const store=createWorkflowSessionStore({indexedDB:null});await store.close();
  await assert.rejects(store.load(),error=>error.code==='WORKFLOW_STORAGE_CLOSED');await assert.rejects(store.save(valid()),error=>error.code==='WORKFLOW_STORAGE_CLOSED');
});
