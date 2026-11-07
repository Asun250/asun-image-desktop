import {captureWorkflowGraph,restoreWorkflowGraph,sameWorkflowGraph} from './workflow-storage-codec.mjs';

const VERSION=2,STORE='workspace',GRAPHS='workflow-graphs',STRINGS='workflow-strings',KEY='current',STORES=[STORE,GRAPHS,STRINGS];
const invalid=message=>Object.assign(new Error(message),{code:'WORKFLOW_STORAGE_INVALID'});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function validateSession(session){
  if(!object(session)||!Array.isArray(session.tabs))throw invalid('The workspace tabs are invalid. Your last saved workspace has been kept.');
  const ids=new Set();
  for(const tab of session.tabs){
    if(!object(tab)||typeof tab.id!=='string'||!tab.id.trim()||ids.has(tab.id))throw invalid('Each workspace tab must have a unique ID. Your last saved workspace has been kept.');
    ids.add(tab.id);
  }
  if(session.tabs.length?!ids.has(session.activeId):session.activeId!==null)throw invalid('The active workspace tab is invalid. Your last saved workspace has been kept.');
  return session;
}
function validateRecord(record,legacy=false){
  if(!object(record)||record.version!==(legacy?1:VERSION))throw invalid('These saved workspace tabs use an unknown storage format. They have been kept without changes.');
  if(!Number.isSafeInteger(record.revision)||record.revision<1||typeof record.savedAt!=='string'||!Number.isFinite(Date.parse(record.savedAt)))throw invalid('The saved workspace record is invalid. It has been kept without changes.');
  if(legacy){validateSession(record.session);return record;}
  for(const key of ['segments','strings'])if(!Array.isArray(record[key])||record[key].some(value=>typeof value!=='string'||!value)||new Set(record[key]).size!==record[key].length)throw invalid('The saved workspace index is invalid. It has been kept without changes.');
  if(!record.segments.includes('workspace'))throw invalid('The saved workspace index is missing its tabs. It has been kept without changes.');
  return record;
}
function manifest(graph,revision,savedAt=new Date().toISOString()){
  return {version:VERSION,revision,savedAt,root:graph.root,segments:[...graph.segments.keys()],strings:[...graph.strings.keys()]};
}
function storageError(cause,action){
  if(typeof cause?.code==='string'&&cause.code.startsWith('WORKFLOW_STORAGE_'))return cause;
  if(cause?.name==='VersionError')return invalid('These workspace tabs were saved by a newer storage version. They have been kept without changes.');
  const code=cause?.name==='QuotaExceededError'?'WORKFLOW_STORAGE_QUOTA':'WORKFLOW_STORAGE_UNAVAILABLE';
  const message=code==='WORKFLOW_STORAGE_QUOTA'
    ?'There is not enough browser storage to save these workspace tabs. Your last saved workspace has been kept. Save your projects as files to keep your latest edits.'
    :'Workspace tabs could not be '+action+'. Browser storage may be unavailable or blocked. Your saved workspace has not been replaced.';
  return Object.assign(new Error(message,{cause}),{code});
}

/** Captures the complete caller-owned session DTO without dropping projects,
 * images, undo/redo entries, job mappings or extra metadata. Only changed graph
 * segments and new immutable strings are written. All changes, including old
 * unused graph/string removal, commit together with one revision manifest.
 */
export function createWorkflowSessionStore({indexedDB=globalThis.indexedDB,name='asun-desktop-workflows-v1',onError}={}){
  let database=null,opening=null,tail=Promise.resolve(),closed=false,observedRevision=null,invalidLoad=null;
  let cachedSegments=new Map(),persistedStrings=new Set(),interns=new Map(),sessionCache=new WeakMap();
  const report=(cause,action)=>{const error=storageError(cause,action);try{onError?.(error);}catch{/* UI reporting cannot alter storage outcomes. */}return error;};
  function openDatabase(){
    if(database)return Promise.resolve(database);if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      if(!indexedDB||typeof indexedDB.open!=='function'){reject(Object.assign(new Error('Workspace tabs cannot be saved because IndexedDB storage is unavailable. Save your projects as files to keep them.'),{code:'WORKFLOW_STORAGE_UNAVAILABLE'}));return;}
      let request,settled=false,migrationError;
      const fail=error=>{if(settled)return;settled=true;reject(error);};
      try{request=indexedDB.open(name,VERSION);}catch(error){fail(error);return;}
      request.onupgradeneeded=event=>{
        const db=request.result,tx=request.transaction;
        if(settled){tx.abort();return;}
        try{
          if(event.oldVersion===0){for(const store of STORES)db.createObjectStore(store);return;}
          if(event.oldVersion!==1||!db.objectStoreNames.contains(STORE))throw invalid('The saved workspace database needs a supported migration. It has been kept without changes.');
          db.createObjectStore(GRAPHS);db.createObjectStore(STRINGS);
          const read=tx.objectStore(STORE).get(KEY);
          read.onsuccess=()=>{
            try{
              if(read.result===undefined)return;
              const legacy=validateRecord(read.result,true),graph=captureWorkflowGraph(legacy.session);
              for(const [id,segment] of graph.segments)tx.objectStore(GRAPHS).put(segment,id);
              for(const [id,value] of graph.strings)tx.objectStore(STRINGS).put(value,id);
              tx.objectStore(STORE).put(manifest(graph,legacy.revision,legacy.savedAt),KEY);
            }catch(error){migrationError=error;tx.abort();}
          };
        }catch(error){migrationError=error;tx.abort();}
      };
      request.onblocked=()=>fail(Object.assign(new Error('Another Asun IMG window is blocking workspace storage. Close that window and try saving again. Your saved tabs have been kept.'),{code:'WORKFLOW_STORAGE_BLOCKED'}));
      request.onerror=()=>fail(migrationError||request.error);
      request.onsuccess=()=>{
        const db=request.result;if(settled){db.close();return;}
        if(STORES.some(store=>!db.objectStoreNames.contains(store))){db.close();fail(invalid('The saved workspace database is missing its tabs. It has been kept without changes.'));return;}
        settled=true;database=db;db.onversionchange=()=>{db.close();if(database===db)database=null;};db.onclose=()=>{if(database===db)database=null;};resolve(db);
      };
    }).finally(()=>{opening=null;});return opening;
  }
  function enqueue(action,operation){
    if(closed)return Promise.reject(report(Object.assign(new Error('Workspace storage is closed. Reopen the editor before saving more tabs.'),{code:'WORKFLOW_STORAGE_CLOSED'}),action));
    const pending=tail.then(operation);tail=pending.catch(()=>{});return pending.catch(cause=>{throw report(cause,action);});
  }
  function adopt(graph,revision){
    observedRevision=revision;cachedSegments=graph?.segments||new Map();persistedStrings=new Set(graph?.strings.keys()||[]);
    interns=new Map(graph?[...graph.strings].map(([id,value])=>[value,id]):[]);
  }
  async function loadRecord(){
    const db=await openDatabase();
    return new Promise((resolve,reject)=>{
      let transaction,record,cause;const segments=new Map(),strings=new Map();
      const abort=error=>{cause=error;try{transaction.abort();}catch{/* Transaction already aborted. */}};
      try{
        transaction=db.transaction(STORES,'readonly');const request=transaction.objectStore(STORE).get(KEY);
        request.onerror=()=>{cause=request.error;};
        request.onsuccess=()=>{
          try{
            record=request.result;if(record===undefined)return;validateRecord(record);
            for(const id of record.segments){const read=transaction.objectStore(GRAPHS).get(id);read.onerror=()=>{cause=read.error;};read.onsuccess=()=>{if(!read.result)abort(invalid('A saved workspace tab is missing. Your saved data has been kept.'));else segments.set(id,read.result);};}
            for(const id of record.strings){const read=transaction.objectStore(STRINGS).get(id);read.onerror=()=>{cause=read.error;};read.onsuccess=()=>{if(typeof read.result!=='string')abort(invalid('A saved workspace image is missing. Your saved data has been kept.'));else strings.set(id,read.result);};}
          }catch(error){abort(error);}
        };
      }catch(error){reject(error);return;}
      transaction.onabort=()=>reject(cause||transaction.error||new Error('Workspace read was interrupted.'));
      transaction.onerror=()=>{cause ||= transaction.error;};
      transaction.oncomplete=()=>{
        try{
          if(record===undefined){adopt(null,0);resolve(null);return;}
          const session=validateSession(restoreWorkflowGraph(record.root,segments,strings));adopt({segments,strings},record.revision);resolve(session);
        }catch(error){reject(error);}
      };
    });
  }
  async function saveSnapshot(graph){
    if(invalidLoad)throw invalidLoad;
    const db=await openDatabase();
    return new Promise((resolve,reject)=>{
      let transaction,cause,saved;
      try{
        transaction=db.transaction(STORES,'readwrite',{durability:'strict'});
        const store=transaction.objectStore(STORE),request=store.get(KEY);request.onerror=()=>{cause=request.error;};
        request.onsuccess=()=>{
          try{
            const previous=request.result;if(previous!==undefined)validateRecord(previous);const revision=previous?.revision||0;
            if(observedRevision===null&&revision!==0)throw Object.assign(new Error('Load the saved workspace tabs before replacing them. Your existing tabs have been kept.'),{code:'WORKFLOW_STORAGE_CONFLICT'});
            if(observedRevision!==null&&observedRevision!==revision)throw Object.assign(new Error('Workspace tabs changed in another window. Reload the saved workspace before saving over it. Your saved tabs have been kept.'),{code:'WORKFLOW_STORAGE_CONFLICT'});
            if(revision===Number.MAX_SAFE_INTEGER)throw invalid('The workspace storage revision cannot advance. Your saved tabs have been kept.');
            const graphs=transaction.objectStore(GRAPHS),strings=transaction.objectStore(STRINGS);
            for(const [id,segment] of graph.segments)if(!sameWorkflowGraph(cachedSegments.get(id),segment)){const write=graphs.put(segment,id);write.onerror=()=>{cause=write.error;};}
            for(const id of previous?.segments||[])if(!graph.segments.has(id))graphs.delete(id);
            for(const [id,value] of graph.strings)if(!persistedStrings.has(id)){const write=strings.put(value,id);write.onerror=()=>{cause=write.error;};}
            for(const id of previous?.strings||[])if(!graph.strings.has(id))strings.delete(id);
            saved=manifest(graph,revision+1);const write=store.put(saved,KEY);write.onerror=()=>{cause=write.error;};
          }catch(error){cause=error;transaction.abort();}
        };
      }catch(error){reject(error);return;}
      transaction.onabort=()=>reject(cause||transaction.error||new Error('Workspace save was interrupted.'));
      transaction.onerror=()=>{cause ||= transaction.error;};
      transaction.oncomplete=()=>{adopt(graph,saved.revision);resolve({revision:saved.revision,savedAt:saved.savedAt});};
    });
  }
  return {
    load(){return enqueue('loaded',async()=>{try{const result=await loadRecord();invalidLoad=null;return result;}catch(error){if(error?.code==='WORKFLOW_STORAGE_INVALID')invalidLoad=error;throw error;}});},
    save(session,{detachedTabSessions=false}={}){
      // The graph is detached at invocation, before waiting for earlier writes.
      // Strings are immutable, so retaining each string once is an exact capture.
      let snapshot;try{validateSession(session);snapshot=captureWorkflowGraph(session,interns,{detachedTabSessions,sessionCache});}catch(cause){return Promise.reject(report(cause?.name==='DataCloneError'?invalid('The workspace contains data that cannot be saved. Your last saved tabs have been kept.'):cause,'saved'));}
      return enqueue('saved',()=>saveSnapshot(snapshot));
    },
    close(){closed=true;return tail.then(()=>{database?.close();database=null;cachedSegments.clear();persistedStrings.clear();interns.clear();sessionCache=new WeakMap();});},
  };
}

