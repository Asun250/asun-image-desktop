import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {writeFile} from 'node:fs/promises';
const inert={dispose(){}},server=createServer({images:inert,sheets:inert,detection:inert,imageSearch:inert,generationQueue:inert});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/health`);
  const result=await page.evaluate(async()=>{
    const {createWorkflowSessionStore}=await import('/workflow-session-store.mjs');
    const source='data:image/png;base64,'+'0123456789abcdef'.repeat(131072);
    const project=n=>({name:'Project '+n,prompt:'Keep original',assets:{one:{source,width:1000,height:1000}},references:[{id:'ref',source}],layers:[{id:'raster',assetId:'one'}]});
    const data={tabs:Array.from({length:3},(_,i)=>({id:'tab-'+i,project:project(i),history:{entries:Array.from({length:12},(_,j)=>({label:'Edit '+j,project:project(i)})),index:11,limit:60}})),activeId:'tab-0'};
    const store=createWorkflowSessionStore({name:'bench-'+crypto.randomUUID()});
    const measure=async(label,action)=>{
      let peakGap=0,last=performance.now();const interval=setInterval(()=>{const now=performance.now();peakGap=Math.max(peakGap,now-last);last=now;},4);
      const start=performance.now(),promise=action(),captureMs=performance.now()-start;await promise;await new Promise(resolve=>setTimeout(resolve,12));clearInterval(interval);
      return {label,captureMs:+captureMs.toFixed(1),totalMs:+(performance.now()-start).toFixed(1),peakEventLoopGapMs:+peakGap.toFixed(1)};
    };
    const samples=[];
    samples.push(await measure('initial',()=>store.save(data)));
    data.activeId='tab-1';samples.push(await measure('active-only',()=>store.save(data)));
    data.tabs[1].project.prompt='Edited request';samples.push(await measure('one-tab-prompt',()=>store.save(data)));
    samples.push(await measure('load',()=>store.load()));await store.close();
    return {sourceBytes:source.length,logicalImageCopies:78,logicalImageMiB:78*source.length/1024/1024,samples};
  });
  console.log(JSON.stringify(result,null,2));
  if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
