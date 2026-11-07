// Synthetic browser benchmark: isolated local server, no provider calls or personal images.
import {chromium} from 'playwright';
import {createServer} from '../../server.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const inert={dispose(){}},server=createServer({images:inert,sheets:inert,detection:inert,imageSearch:inert,generationQueue:inert});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage(),base=`http://127.0.0.1:${server.address().port}`;
  await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await page.goto(base+'/health');
  const result=await page.evaluate(async()=>{
    const {createWorkflowSessionStore}=await import('/workflow-session-store.mjs');
    const {encodeWorkspaceSession}=await import('/workflow-session-codec.mjs');
    const {newProject}=await import('/core.mjs');
    const points=Array.from({length:1500},(_,i)=>[i%1000,(i*3)%800]);
    const history={entries:Array.from({length:60},(_,i)=>({label:'Stroke '+i,project:{layers:Array.from({length:4},(_,j)=>({id:'stroke-'+j,drawing:{points:points.map(p=>p.slice())}}))}})),index:59,limit:60};
    const live={project:newProject(),history,view:{x:0,y:0,zoom:1,angle:0}};
    const measure=async(action)=>{
      let peak=0,last=performance.now();const timer=setInterval(()=>{const now=performance.now();peak=Math.max(peak,now-last);last=now;},4);
      const started=performance.now(),pending=action(),captureMs=performance.now()-started;await pending;await new Promise(resolve=>setTimeout(resolve,20));clearInterval(timer);
      return {captureMs:+captureMs.toFixed(2),totalMs:+(performance.now()-started).toFixed(2),peakEventLoopGapMs:+peak.toFixed(2)};
    };
    const results={};
    for(const mode of ['baseline','optimized']){
      const optimized=mode==='optimized',options={detachedTabSessions:optimized},encode=()=>encodeWorkspaceSession(live,{reuseHistoryEntries:optimized});
      const store=createWorkflowSessionStore({name:'heavy-history-'+mode+'-'+crypto.randomUUID()});
      const data={tabs:[{id:'old',session:{workspace:encode()}},{id:'blank',session:{workspace:{project:newProject(),history:{entries:[],index:0,limit:60}}}}],activeId:'blank'};
      await store.save(data,options);
      const blank=[];for(let i=0;i<3;i++)blank.push(await measure(()=>{data.tabs[1].session={workspace:{project:{...newProject(),prompt:'Blank '+i},history:{entries:[],index:0,limit:60}}};return store.save(data,options);}));
      data.tabs.shift();data.tabs[0].session={workspace:encode()};await store.save(data,options);
      const cleared=[];for(let i=0;i<3;i++)cleared.push(await measure(()=>{live.view={...live.view,x:i};data.tabs[0].session={workspace:encode()};return store.save(data,options);}));
      const restored=await store.load();if(restored.tabs[0].session.workspace.history.entries.length!==60)throw new Error('History lost');
      await store.close();results[mode]={blankWithInactiveHistory:blank,clearedWithOwnHistory:cleared};
    }
    return {fixture:{undoEntries:60,strokesPerEntry:4,pointsPerStroke:1500,nativeHistoryPreserved:true},results};
  });
  const reports=new URL('../../qa/diagnostics/',import.meta.url);await mkdir(reports,{recursive:true});
  await writeFile(new URL('heavy-history-benchmark.json',reports),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
