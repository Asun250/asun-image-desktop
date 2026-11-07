// Large immutable image strings occur in every Undo snapshot. Keep one copy
// across the workspace instead of asking structuredClone/IndexedDB to copy it
// for every occurrence. Graph segments also let a tab switch write metadata
// without rewriting the other tabs. All values are captured synchronously.
const LONG_STRING=16*1024;
const bad=()=>Object.assign(new Error('The saved workspace graph is invalid. Your saved tabs have been kept.'),{code:'WORKFLOW_STORAGE_INVALID'});
const plain=value=>value!==null&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const own=(object,key,value)=>Object.defineProperty(object,key,{value,writable:true,enumerable:true,configurable:true});
const detachedSnapshots=new WeakSet();

// Only register detached immutable captures, never a live editable project.
// Weak ownership lets closed tabs and discarded Undo entries be collected.
export function registerDetachedWorkflowSnapshot(value){
  if(value!==null&&typeof value==='object')detachedSnapshots.add(value);
  return value;
}

export function captureWorkflowGraph(session,interns=new Map(),{detachedTabSessions=false,sessionCache=new WeakMap()}={}){
  const owners=new Map(),snapshots=new WeakSet();
  for(const tab of session.tabs){
    owners.set(tab,'tab:'+tab.id);
    if(detachedTabSessions&&tab.session!==null&&typeof tab.session==='object')snapshots.add(tab.session);
  }
  return captureGraph(session,interns,owners,'workspace',snapshots,sessionCache,detachedTabSessions);
}

// The desktop editor replaces detached tab.session snapshots rather than
// mutating them. Opting into that contract lets inactive Undo histories keep
// their encoded segment by identity. Generic callers still capture all mutable
// data at every save. Tab names, job links and other metadata are always fresh.
function captureGraph(rootValue,interns,owners,rootOwner,snapshots,sessionCache,cacheDetached=false){
  const segments=new Map(),strings=new Map(),seen=new Map();
  const segment=name=>{if(!segments.has(name))segments.set(name,{nodes:[]});return segments.get(name);};
  function capture(value,owner){
    if(typeof value==='string'&&value.length>=LONG_STRING){
      let id=interns.get(value);if(!id){id=crypto.randomUUID();interns.set(value,id);}strings.set(id,value);return {string:id};
    }
    if(typeof value==='function'||typeof value==='symbol')throw new DOMException('This value cannot be saved.','DataCloneError');
    if(value===null||typeof value!=='object')return value;
    if(seen.has(value))return seen.get(value);
    if(value!==rootValue&&(snapshots?.has(value)||cacheDetached&&detachedSnapshots.has(value))){
      let graph=sessionCache.get(value);
      if(!graph){
        graph=captureGraph(value,interns,new Map(),'session:'+crypto.randomUUID(),snapshots,sessionCache,cacheDetached);
        sessionCache.set(value,graph);
      }
      for(const [id,part] of graph.segments)segments.set(id,part);
      for(const [id,text] of graph.strings)strings.set(id,text);
      seen.set(value,graph.root);return graph.root;
    }
    owner=owners.get(value)||owner;
    const nodes=segment(owner).nodes,index=nodes.length,reference={node:[owner,index]};nodes.push(null);seen.set(value,reference);
    let node;
    if(Array.isArray(value))node={kind:'array',length:value.length,entries:Object.keys(value).map(key=>[key,capture(value[key],owner)])};
    else if(value instanceof Map)node={kind:'map',entries:Array.from(value,([key,item])=>[capture(key,owner),capture(item,owner)])};
    else if(value instanceof Set)node={kind:'set',entries:Array.from(value,item=>capture(item,owner))};
    else if(plain(value)||Object.prototype.toString.call(value)==='[object Object]')node={kind:'object',entries:Object.keys(value).map(key=>[key,capture(value[key],owner)])};
    else node={kind:'native',value:structuredClone(value)};
    nodes[index]=node;return reference;
  }
  const root=capture(rootValue,rootOwner);return {root,segments,strings};
}

export function restoreWorkflowGraph(root,segments,strings){
  const restored=new Map();
  const key=(owner,index)=>JSON.stringify([owner,index]);
  function allocate(owner,index,node){
    if(!node||typeof node!=='object')throw bad();
    let result;
    if(node.kind==='array'){if(!Number.isSafeInteger(node.length)||node.length<0||node.length>4294967295)throw bad();result=new Array(node.length);}
    else if(node.kind==='object')result={};
    else if(node.kind==='map')result=new Map();
    else if(node.kind==='set')result=new Set();
    else if(node.kind==='native')result=structuredClone(node.value);
    else throw bad();
    restored.set(key(owner,index),result);
  }
  for(const [owner,segment] of segments){if(typeof owner!=='string'||!segment||!Array.isArray(segment.nodes))throw bad();segment.nodes.forEach((node,index)=>allocate(owner,index,node));}
  function value(item){
    if(item===null||typeof item!=='object')return item;
    const keys=Object.keys(item);if(keys.length!==1)throw bad();
    if(keys[0]==='string'){if(typeof item.string!=='string'||!strings.has(item.string))throw bad();return strings.get(item.string);}
    if(keys[0]!=='node'||!Array.isArray(item.node)||item.node.length!==2||typeof item.node[0]!=='string'||!Number.isSafeInteger(item.node[1])||item.node[1]<0)throw bad();
    const id=key(...item.node);if(!restored.has(id))throw bad();return restored.get(id);
  }
  for(const [owner,segment] of segments)segment.nodes.forEach((node,index)=>{
    const target=restored.get(key(owner,index));if(node.kind==='native')return;
    if(!Array.isArray(node.entries))throw bad();
    if(node.kind==='set'){for(const entry of node.entries)target.add(value(entry));return;}
    const keys=new Set();
    for(const entry of node.entries){
      if(!Array.isArray(entry)||entry.length!==2)throw bad();
      if(node.kind==='map')target.set(value(entry[0]),value(entry[1]));
      else{
        if(typeof entry[0]!=='string'||keys.has(entry[0])||(node.kind==='array'&&entry[0]==='length'))throw bad();keys.add(entry[0]);
        own(target,entry[0],value(entry[1]));
      }
    }
  });
  return value(root);
}

// Graphs only contain small descriptors and short primitive values. Native
// objects are conservatively rewritten; comparing Blob contents would require
// async reads and could lose the exact caller snapshot.
export function sameWorkflowGraph(a,b){
  if(Object.is(a,b))return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  if(!(Array.isArray(a)||plain(a))||!(Array.isArray(b)||plain(b)))return false;
  const keys=Object.keys(a);if(keys.length!==Object.keys(b).length)return false;
  for(const key of keys)if(!Object.hasOwn(b,key)||!sameWorkflowGraph(a[key],b[key]))return false;
  return true;
}
