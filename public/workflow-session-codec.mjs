import {History,validateProject} from './core.mjs';
import {cloneEditableData} from './editable-data.mjs';
import {registerDetachedWorkflowSnapshot} from './workflow-storage-codec.mjs';

const trustedSessions=new WeakSet();
const historySnapshots=new WeakMap();
// Image data URLs are immutable strings. Copy the editable graph while sharing
// those values, instead of serializing their full bytes once per undo entry.
export const cloneWorkflowData=cloneEditableData;
export function encodeWorkspaceSession(session,{reuseHistoryEntries=false}={}){
  if(!session)return null;
  const {history,...rest}=session;
  let captured;
  if(reuseHistoryEntries){
    // The editor appends/replaces History entries, never mutates their stored
    // projects. Keep detached entry snapshots so old strokes need not be
    // copied and re-encoded on each view change or edit to a blank canvas.
    const entries=history.entries.map(entry=>{
      let saved=historySnapshots.get(entry);
      if(!saved){saved=cloneWorkflowData(entry);registerDetachedWorkflowSnapshot(saved);historySnapshots.set(entry,saved);}
      return saved;
    });
    captured={...cloneWorkflowData(rest),history:{entries,index:history.index,limit:history.limit}};
  }else captured=cloneWorkflowData({...rest,history:{entries:history.entries,index:history.index,limit:history.limit}});
  // Live projects/history have already passed the native editor's validation.
  trustedSessions.add(captured);return captured;
}
export function decodeWorkspaceSession(value){
  if(!value||!value.history||!Array.isArray(value.history.entries)||!value.history.entries.length)throw new Error('A saved workflow is missing its undo history. Your saved tabs have been kept.');
  const session=cloneWorkflowData(value),saved=session.history;
  if(!trustedSessions.has(value))validateProject(session.project);
  if(!Number.isInteger(saved.index)||saved.index<0||saved.index>=saved.entries.length||!Number.isInteger(saved.limit)||saved.limit<1)throw new Error('A saved workflow has invalid undo history. Your saved tabs have been kept.');
  if(!trustedSessions.has(value))for(const entry of saved.entries){if(typeof entry.label!=='string')throw new Error('A saved history label is invalid.');validateProject(entry.project);}
  // Validation above replaces the constructor's redundant initial project copy.
  const history=Object.create(History.prototype);history.limit=saved.limit;history.entries=saved.entries;history.index=saved.index;
  session.history=history;session.view={x:0,y:0,zoom:1,angle:0,...session.view};
  if(!Object.values(session.view).every(Number.isFinite)||session.view.zoom<=0)throw new Error('A saved workflow view is invalid.');
  trustedSessions.add(value);
  return session;
}
