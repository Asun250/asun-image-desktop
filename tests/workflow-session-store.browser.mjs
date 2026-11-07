import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
let server,browser,base;
before(async()=>{
  const inert={dispose(){}};server=createServer({images:inert,sheets:inert,detection:inert,imageSearch:inert,generationQueue:inert});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t){
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();await page.goto(base+'/health');
  await page.evaluate(async()=>{
    window.createStore=(await import('/workflow-session-store.mjs')).createWorkflowSessionStore;window.core=await import('/core.mjs');
    window.name='workflow-test-'+crypto.randomUUID();window.session=marker=>({tabs:[{id:'first',name:marker,project:core.newProject()}],activeId:'first',jobMappings:{}});
    window.raw=async(operation)=>new Promise((resolve,reject)=>{
      const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{
        const db=request.result,tx=db.transaction('workspace',operation?'readwrite':'readonly'),store=tx.objectStore('workspace'),read=store.get('current');let value;
        read.onsuccess=()=>{value=read.result;if(operation)store.put(operation(value),'current');};tx.onabort=()=>{db.close();reject(tx.error);};tx.oncomplete=()=>{db.close();resolve(value);};
      };
    });
  });return page;
}

test('large native images, references, undo/redo, job mappings and all tabs survive close and page reload',async t=>{
  const page=await fixture(t);
  const expected=await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=900;canvas.height=600;const context=canvas.getContext('2d'),pixels=context.createImageData(canvas.width,canvas.height);
    let seed=17;for(let i=0;i<pixels.data.length;i++){seed=(seed*1664525+1013904223)>>>0;pixels.data[i]=i%4===3?255:seed>>>24;}context.putImageData(pixels,0,0);
    const original=canvas.toDataURL(),added=core.addRaster(core.newProject(900,600),{name:'Detailed original.png',source:original,width:900,height:600}),history=new core.History(added.project,100);
    history.commit({...history.project,prompt:'Keep the building'},'Add request');history.commit({...history.project,prompt:'Only change roof'},'Refine request');history.undo();
    const data=session('Large saved project');data.tabs[0].project=history.project;data.tabs[0].history={entries:history.entries,index:history.index,limit:history.limit};
    data.tabs[0].references=[{id:'reference-one',source:original,notes:'Only this building'}];data.tabs[0].view={zoom:2.25,pan:{x:11,y:-14},rotation:37};
    for(let i=2;i<=75;i++)data.tabs.push({id:'tab-'+i,name:'Project '+i,project:core.newProject()});data.activeId='tab-72';data.jobMappings={jobA:{tabId:'first',kind:'image'},jobB:{tabId:'tab-72',kind:'sheet'}};
    const store=createStore({name});await store.save(data);await store.close();
    return {name,bytes:original.length,serialized:JSON.stringify(data)};
  });
  assert.ok(expected.bytes>2*1024*1024);
  await page.reload();
  const actual=await page.evaluate(async name=>{const {createWorkflowSessionStore}=await import('/workflow-session-store.mjs');const store=createWorkflowSessionStore({name}),loaded=await store.load();await store.close();return JSON.stringify(loaded);},expected.name);
  assert.equal(actual,expected.serialized);
});

test('saves capture caller data immediately and serialize revisions so earlier work cannot overwrite the latest',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const store=createStore({name}),first=session('First'),a=store.save(first);first.tabs[0].name='Changed after submit';
    const second=session('Second'),b=store.save(second),third=session('Latest'),c=store.save(third);third.tabs[0].name='Changed after latest submit';
    const revisions=await Promise.all([a,b,c]);const loaded=await store.load(),record=await raw();await store.close();
    return {revisions:revisions.map(value=>value.revision),name:loaded.tabs[0].name,revision:record.revision};
  });assert.deepEqual(result,{revisions:[1,2,3],name:'Latest',revision:3});
});

test('detached tab sessions retain exact queued saves, replacement edits and cleanup across reload',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const options={detachedTabSessions:true},store=createStore({name}),source='data:image/png;base64,'+'a'.repeat(20000);
    const data={tabs:[{id:'old',name:'First',jobIds:[],session:{workspace:{project:{source},history:{entries:[{project:{source}}],index:0}}}},{id:'new',name:'Blank',session:{workspace:{project:{prompt:''}}}}],activeId:'new'};
    const first=store.save(data,options);data.tabs[0].name='Metadata captured now';data.tabs[0].jobIds.push({id:'queued',kind:'image'});data.tabs[1].session={workspace:{project:{prompt:'Second'}}};
    const second=store.save(data,options);data.tabs[1].session={workspace:{project:{prompt:'Third'}}};
    const third=store.save(data,options);data.tabs[1].session={workspace:{project:{prompt:'Not saved'}}};
    const revisions=await Promise.all([first,second,third]);const loaded=await store.load();
    data.tabs.shift();await store.save(data,options);const compact=await raw();await store.close();
    const reopened=createStore({name}),final=await reopened.load();await reopened.close();
    return {revisions:revisions.map(item=>item.revision),old:loaded.tabs[0],latest:loaded.tabs[1].session.workspace.project.prompt,final,strings:compact.strings.length};
  });
  assert.deepEqual(result.revisions,[1,2,3]);assert.equal(result.old.name,'Metadata captured now');assert.deepEqual(result.old.jobIds,[{id:'queued',kind:'image'}]);
  assert.equal(result.old.session.workspace.project.source,result.old.session.workspace.history.entries[0].project.source);assert.equal(result.latest,'Third');assert.equal(result.strings,0);
  assert.equal(result.final.tabs.length,1);assert.equal(result.final.tabs[0].session.workspace.project.prompt,'Not saved');
});

test('quota failure aborts the entire write and preserves the last saved session and revision',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const errors=[],store=createStore({name,onError:error=>errors.push(error.code)});await store.save(session('Kept'));
    const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){put.apply(this,args);throw new DOMException('Quota fixture','QuotaExceededError');};
    let failure;try{await store.save(session('Must not persist'));}catch(error){failure={code:error.code,message:error.message};}finally{IDBObjectStore.prototype.put=put;}
    const kept=await store.load(),record=await raw();await store.save(session('Next successful save'));const next=await raw();await store.close();
    return {failure,errors,kept:kept.tabs[0].name,revision:record.revision,next:next.revision};
  });assert.equal(result.failure.code,'WORKFLOW_STORAGE_QUOTA');assert.match(result.failure.message,/last saved workspace has been kept/);assert.deepEqual({...result,failure:undefined},{failure:undefined,errors:['WORKFLOW_STORAGE_QUOTA'],kept:'Kept',revision:1,next:2});
});

test('concurrent windows reject stale snapshots instead of silently overwriting newer tabs',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const a=createStore({name}),b=createStore({name});await a.save(session('Initial'));await b.load();await a.save(session('Newest window A'));
    let error;try{await b.save(session('Stale window B'));}catch(cause){error=cause.code;}const current=await a.load();await a.close();await b.close();return {error,name:current.tabs[0].name,revision:(await raw()).revision};
  });assert.deepEqual(result,{error:'WORKFLOW_STORAGE_CONFLICT',name:'Newest window A',revision:2});
});

test('unknown or invalid saved data is surfaced and remains unchanged after failed load and save',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const store=createStore({name});await store.save(session('Original'));await raw(value=>({...value,version:99}));const original=JSON.stringify(await raw()),errors=[];
    for(const operation of [()=>store.load(),()=>store.save(session('New'))])try{await operation();}catch(error){errors.push(error.code);}
    const preserved=original===JSON.stringify(await raw());await store.close();return {errors,preserved};
  });assert.deepEqual(result,{errors:['WORKFLOW_STORAGE_INVALID','WORKFLOW_STORAGE_INVALID'],preserved:true});
});

test('close flushes accepted writes and a new store must load saved tabs before replacing them',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const first=createStore({name}),saving=first.save(session('Flush me')),closing=first.close();await Promise.all([saving,closing]);
    const second=createStore({name});let conflict;try{await second.save(session('Unloaded replacement'));}catch(error){conflict=error.code;}const kept=await second.load();await second.save(session('Intentional edit after load'));const final=await second.load();await second.close();
    return {conflict,kept:kept.tabs[0].name,final:final.tabs[0].name};
  });assert.deepEqual(result,{conflict:'WORKFLOW_STORAGE_CONFLICT',kept:'Flush me',final:'Intentional edit after load'});
});

test('an aborted write never removes tabs and subsequent valid saves still work',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const store=createStore({name});await store.save(session('Before abort'));const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const request=put.apply(this,args);this.transaction.abort();return request;};
    let failed=false;try{await store.save({tabs:[],activeId:null});}catch{failed=true;}finally{IDBObjectStore.prototype.put=put;}
    const saved=await store.load();await store.save(session('After abort'));await store.close();return {failed,name:saved.tabs[0].name,revision:(await raw()).revision};
  });assert.deepEqual(result,{failed:true,name:'Before abort',revision:2});
});

test('newer database versions are reported without opening, downgrading or deleting saved projects',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const first=createStore({name});await first.save(session('Future version project'));await first.close();
    const before=JSON.stringify(await raw());
    await new Promise((resolve,reject)=>{const request=indexedDB.open(name,3);request.onerror=()=>reject(request.error);request.onsuccess=()=>{request.result.close();resolve();};});
    const old=createStore({name});let error;try{await old.load();}catch(cause){error={code:cause.code,message:cause.message};}await old.close();
    const saved=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('workspace','readonly'),read=tx.objectStore('workspace').get('current');read.onsuccess=()=>resolve({version:db.version,preserved:JSON.stringify(read.result)===before});tx.oncomplete=()=>db.close();};});
    return {error,saved};
  });assert.equal(result.error.code,'WORKFLOW_STORAGE_INVALID');assert.match(result.error.message,/newer storage version/);assert.deepEqual(result.saved,{version:3,preserved:true});
});

test('v1 workspaces migrate atomically with every image, history entry, tab and revision preserved',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const data=session('Legacy original'),source='data:image/png;base64,'+'a'.repeat(2000000);
    data.tabs[0].project.assets={photo:{source}};data.tabs[0].history={entries:Array.from({length:30},(_,i)=>({label:'Edit '+i,project:{source,prompt:'Request '+i}})),index:15};
    data.tabs.push({id:'second',references:[{source,notes:'Exact detail'}]});data.activeId='second';data.extra={unknown:'Preserve this'};
    const legacy={version:1,revision:9,savedAt:'2026-10-23T00:00:00.000Z',session:data};
    await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('workspace').put(legacy,'current');request.onerror=()=>reject(request.error);request.onsuccess=()=>{request.result.close();resolve();};});
    const store=createStore({name}),loaded=await store.load(),index=await raw();await store.save(loaded);await store.close();
    const details=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction(['workspace','workflow-graphs','workflow-strings'],'readonly'),count=tx.objectStore('workflow-strings').count();let countValue;count.onsuccess=()=>{countValue=count.result;};tx.oncomplete=()=>{resolve({version:db.version,count:countValue});db.close();};};});
    return {equal:JSON.stringify(data)===JSON.stringify(loaded),oldRevision:index.revision,nextRevision:(await raw()).revision,details};
  });assert.deepEqual(result,{equal:true,oldRevision:9,nextRevision:10,details:{version:2,count:1}});
});

test('invalid v1 data or failed migration retains the original database byte for byte',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const outcomes=[];
    for(const failKind of ['invalid','quota']){
      const dbName=name+'-'+failKind,legacy={version:failKind==='invalid'?99:1,revision:7,savedAt:'2026-10-23T00:00:00.000Z',session:session('Legacy kept')};
      await new Promise((resolve,reject)=>{const request=indexedDB.open(dbName,1);request.onupgradeneeded=()=>request.result.createObjectStore('workspace').put(legacy,'current');request.onerror=()=>reject(request.error);request.onsuccess=()=>{request.result.close();resolve();};});
      const put=IDBObjectStore.prototype.put;if(failKind==='quota')IDBObjectStore.prototype.put=function(...args){put.apply(this,args);throw new DOMException('Migration quota','QuotaExceededError');};
      const store=createStore({name:dbName});let code;try{await store.load();}catch(error){code=error.code;}finally{IDBObjectStore.prototype.put=put;await store.close();}
      const kept=await new Promise((resolve,reject)=>{const request=indexedDB.open(dbName);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('workspace','readonly'),read=tx.objectStore('workspace').get('current');let value;read.onsuccess=()=>{value=read.result;};tx.oncomplete=()=>{resolve({version:db.version,stores:[...db.objectStoreNames],same:JSON.stringify(value)===JSON.stringify(legacy)});db.close();};};});
      outcomes.push({code,...kept});
    }return outcomes;
  });assert.deepEqual(result,[{code:'WORKFLOW_STORAGE_INVALID',version:1,stores:['workspace'],same:true},{code:'WORKFLOW_STORAGE_QUOTA',version:1,stores:['workspace'],same:true}]);
});

test('tab switches and prompt edits read only the manifest and write only changed graphs, never unchanged images',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const source='data:image/png;base64,'+'x'.repeat(2000000),data={tabs:[{id:'a',source,history:[{source},{source}]},{id:'b',source}],activeId:'a'},store=createStore({name});
    await store.save(data);const put=IDBObjectStore.prototype.put,get=IDBObjectStore.prototype.get;let operations=[];
    IDBObjectStore.prototype.put=function(value,key){operations.push(['put',this.name,key]);return put.call(this,value,key);};
    IDBObjectStore.prototype.get=function(key){operations.push(['get',this.name,key]);return get.call(this,key);};
    try{
      data.activeId='b';await store.save(data);const switched=operations;operations=[];
      data.tabs[1].prompt='Change only this request';await store.save(data);const edited=operations;
      return {switched,edited};
    }finally{IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.get=get;await store.close();}
  });assert.deepEqual(result,{switched:[['get','workspace','current'],['put','workflow-graphs','workspace'],['put','workspace','current']],edited:[['get','workspace','current'],['put','workflow-graphs','tab:b'],['put','workspace','current']]});
});

test('queued mutable snapshots retain their own large images and closed-tab data removal is atomic',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const a='a'.repeat(20000),b='b'.repeat(20000),data={tabs:[{id:'a',source:a},{id:'b',source:b}],activeId:'a'},store=createStore({name});
    await store.save(data);const old=await store.load();
    const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const result=put.apply(this,args);if(this.name==='workspace')throw new DOMException('Final manifest quota','QuotaExceededError');return result;};
    let failed=false;try{await store.save({tabs:[data.tabs[0]],activeId:'a'});}catch{failed=true;}finally{IDBObjectStore.prototype.put=put;}
    const kept=await store.load();
    const first=store.save(data);data.tabs[0].source=b;const second=store.save(data);data.tabs[0].source='mutated';await Promise.all([first,second]);
    const final=await store.load();await store.save({tabs:[final.tabs[0]],activeId:'a'});const record=await raw();await store.close();
    const counts=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction(['workflow-graphs','workflow-strings'],'readonly'),graphs=tx.objectStore('workflow-graphs').count(),strings=tx.objectStore('workflow-strings').count();let values={};graphs.onsuccess=()=>{values.graphs=graphs.result;};strings.onsuccess=()=>{values.strings=strings.result;};tx.oncomplete=()=>{db.close();resolve(values);};};});
    return {failed,kept:JSON.stringify(kept)===JSON.stringify(old),captured:final.tabs[0].source===b,revision:record.revision,counts};
  });assert.deepEqual(result,{failed:true,kept:true,captured:true,revision:4,counts:{graphs:2,strings:1}});
});

test('corrupt graph records are reported without deleting valid saved images or replacing the workspace',async t=>{
  const page=await fixture(t),result=await page.evaluate(async()=>{
    const original=createStore({name});await original.save({...session('Kept'),source:'x'.repeat(20000)});await original.close();
    await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('workflow-graphs','readwrite');tx.objectStore('workflow-graphs').put({nodes:[{kind:'future'}]},'tab:first');tx.oncomplete=()=>{db.close();resolve();};};});
    const record=JSON.stringify(await raw()),store=createStore({name});let loadCode,saveCode;
    try{await store.load();}catch(error){loadCode=error.code;}try{await store.save(session('Replacement'));}catch(error){saveCode=error.code;}
    await store.close();return {loadCode,saveCode,preserved:JSON.stringify(await raw())===record};
  });assert.deepEqual(result,{loadCode:'WORKFLOW_STORAGE_INVALID',saveCode:'WORKFLOW_STORAGE_INVALID',preserved:true});
});
