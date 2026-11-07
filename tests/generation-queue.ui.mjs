import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

const qa=path.resolve('qa','generation-queue'),report={suite:'Shared desktop generation queue UI',paidCalls:0,cases:[]};
const ids={running:'11111111-1111-4111-8111-111111111111',queued:'22222222-2222-4222-8222-222222222222',ready:'33333333-3333-4333-8333-333333333333',failed:'44444444-4444-4444-8444-444444444444'};
const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7fQAAAAASUVORK5CYII=','base64');
let server,browser,context,page,base,errors,requests,jobs,queueError,queueMessage,cancelRace,tokens,authRejections;
const record=(id,status,kind='image')=>({id,kind,mode:kind,status,sourceName:kind==='sheet'?'Tower references.png':'Bird scene.png',projectName:kind==='sheet'?'White background item sheet':'Four birds on the Strip',model:'gpt-image-2.5-sunburst',settings:{model:'gpt-image-2.5-sunburst',quality:'max',size:'1536x1024'},createdAt:'2026-10-23T20:00:00Z',queuedAt:'2026-10-23T20:00:00Z',queuePosition:status==='queued'?1:null,cancellable:status==='queued',sourceProjectAvailable:true,outputAvailable:status==='completed',output:status==='completed'?{name:'Result.png',width:1536,height:1024}:null,message:status==='failed'?'The selected quality is unsupported by this provider.':''});
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];requests=[];queueError=null;queueMessage='';cancelRace=false;tokens={image:'image-token',sheet:'sheet-token'};authRejections=[];jobs=[record(ids.running,'running'),record(ids.queued,'queued','sheet'),record(ids.ready,'completed'),record(ids.failed,'failed')];
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});await context.addInitScript(()=>localStorage.setItem('asun-image-appearance','dark'));page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());if(url.origin!==base){errors.push('External request blocked: '+url.origin);return route.abort();}
    if(!url.pathname.startsWith('/api/'))return route.continue();
    requests.push({path:url.pathname,method:req.method(),headers:req.headers()});const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    const rejectAuth=()=>{authRejections.push({path:url.pathname,headers:req.headers()});return json({code:'ASUN_LOCAL_TOKEN_EXPIRED',error:'Token expired.'},403);};
    if(url.pathname==='/api/images/status'||url.pathname==='/api/sheets/status')return json({token:tokens[url.pathname.includes('/sheets/')?'sheet':'image'],available:false,authenticated:false,configured:false,models:[],message:'Isolated queue UI verification; generation disabled.'});
    if(url.pathname==='/api/generation-queue/status'){
      // Workflow bridges may poll before their first status response. Model the
      // server's recoverable rejection rather than throwing outside the test.
      if(req.headers()['x-asun-image-token']!==tokens.image&&req.headers()['x-asun-sheet-token']!==tokens.sheet)return rejectAuth();
      if(queueError)return json({error:queueError},503);
      const counts=Object.fromEntries(['queued','running','completed','failed','cancelled'].map(status=>[status,jobs.filter(job=>job.status===status).length]));return json({items:jobs,counts,concurrency:1,message:queueMessage});
    }
    const match=url.pathname.match(/^\/api\/(images|sheets)\/jobs\/([^/]+)\/(cancel|output)$/);
    if(match){const kind=match[1]==='sheets'?'sheet':'image',job=jobs.find(item=>item.id===match[2]);if(req.headers()[`x-asun-${kind}-token`]!==tokens[kind])return rejectAuth();
      if(match[3]==='output'){assert.equal(req.method(),'GET');return route.fulfill({contentType:'image/png',body:imageBytes});}
      assert.equal(req.method(),'POST');if(cancelRace){job.status='running';job.cancellable=false;return json({error:'This job has already started and cannot be canceled.'},409);}assert.equal(job.status,'queued');job.status='cancelled';job.cancellable=false;return json(job);
    }
    if(req.method()!=='GET')errors.push('Unexpected API mutation: '+url.pathname);
    return json({available:false,models:[],items:[],message:'Isolated queue UI verification.'});
  });
  await boot();
});
afterEach(async info=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});report.cases.push({name:info.name,status:info.error?'failed':'passed',error:info.error?.message});assert.deepEqual(errors,[]);}finally{await context?.close();}});
async function boot(){await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();await page.evaluate(async()=>{const {mountGenerationQueue}=await import('./generation-queue.mjs');mountGenerationQueue().dispose();window.queueActions=[];window.queueErrors=[];window.queueUI=mountGenerationQueue({onOpenResult:value=>window.queueActions.push({action:'open',kind:value.kind,id:value.id}),onEditOutput:value=>window.queueActions.push({action:'edit',kind:value.kind,id:value.id}),onRedo:value=>window.queueActions.push({action:'redo',kind:value.kind,id:value.id}),onNewProject:()=>window.queueActions.push({action:'new'}),onError:error=>window.queueErrors.push(error.message)});await window.queueUI.refresh();});}
const card=id=>page.locator(`#generationQueueList [data-job-id="${id}"]`);
async function refresh(){await page.evaluate(()=>window.queueUI.refresh());}
async function open(){await page.locator('#generationQueueButton').click();await page.locator('#generationQueueDialog').waitFor({state:'visible'});await page.locator('#generationQueueRefresh').waitFor({state:'visible'});await page.waitForFunction(()=>!document.getElementById('generationQueueRefresh').disabled);}

test('metadata queue shows image and sheet jobs truthfully and stays usable at 1024 and 1440',{timeout:45000},async()=>{
  assert.equal(await page.locator('#generationQueueCount').textContent(),'2');assert.equal(await page.locator('#generationQueueDialog').isVisible(),false);await open();
  assert.equal(await card(ids.running).locator('.generation-queue-state').textContent(),'Generating');assert.equal(await card(ids.queued).locator('.generation-queue-state').textContent(),'Queued');assert.equal(await card(ids.ready).locator('.generation-queue-state').textContent(),'Ready');assert.equal(await card(ids.failed).locator('.generation-queue-state').textContent(),'Failed');
  assert.match(await card(ids.queued).textContent(),/Character \/ item sheet/);assert.match(await card(ids.queued).textContent(),/Position 1/);assert.match(await card(ids.failed).textContent(),/quality is unsupported/);assert.match(await card(ids.ready).textContent(),/gpt-image-2.5-sunburst/);assert.match(await card(ids.ready).textContent(),/max/);assert.match(await card(ids.ready).textContent(),/1536x1024/);
  assert.equal(await card(ids.running).locator('[data-queue-action=cancel]').count(),0);assert.equal(await card(ids.failed).locator('[data-queue-action=open]').count(),0);assert.equal(await page.locator('#generationQueueDialog [role=progressbar]').count(),0);assert(!requests.some(item=>/\/output$|\/input\//.test(item.path)),'Polling downloads no full images.');
  for(const width of [1440,1024]){await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(qa,`queue-${width}.png`)});await page.locator('#generationQueueClose').click();const layout=await page.evaluate(()=>{const b=document.getElementById('generationQueueButton').getBoundingClientRect(),header=document.querySelector('.header').getBoundingClientRect();return{scroll:document.documentElement.scrollWidth,width:innerWidth,button:{left:b.left,right:b.right,bottom:b.bottom},headerBottom:header.bottom,hit:document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)?.closest('#generationQueueButton')?.id};});assert(layout.scroll<=width+1,JSON.stringify(layout));assert(layout.button.left>=0&&layout.button.right<=width&&layout.button.bottom<=layout.headerBottom);assert.equal(layout.hit,'generationQueueButton');await page.screenshot({path:path.join(qa,`header-${width}.png`)});await open();}
});

test('completion in the background and browser reload retain the queue without opening results or altering the current canvas',{timeout:45000},async()=>{
  await page.locator('#prompt').fill('Keep this next project intact.');const before=await page.locator('#canvas').evaluate(canvas=>canvas.toDataURL());
  Object.assign(jobs[0],{status:'completed',outputAvailable:true,output:{name:'Birds finished.png',width:1536,height:1024}});Object.assign(jobs[1],{status:'running',cancellable:false});
  await page.waitForFunction(()=>document.getElementById('generationQueueCount').textContent==='1');assert.equal(await page.locator('#generationQueueDialog').isVisible(),false);assert.deepEqual(await page.evaluate(()=>window.queueActions),[]);assert.equal(await page.locator('#prompt').inputValue(),'Keep this next project intact.');assert.equal(await page.locator('#canvas').evaluate(canvas=>canvas.toDataURL()),before);
  await open();await page.locator('#generationQueueNewProject').click();assert.equal(await page.locator('#generationQueueDialog').isVisible(),false);assert.deepEqual(await page.evaluate(()=>window.queueActions),[{action:'new'}]);
  await boot();assert.equal(await page.locator('#generationQueueCount').textContent(),'1');await open();assert.equal(await card(ids.running).locator('.generation-queue-state').textContent(),'Ready');assert.equal(await card(ids.queued).locator('.generation-queue-state').textContent(),'Generating');assert(!requests.some(item=>item.method==='POST'));
});

test('ready actions use the matching saved job; download is authorized; queued cancellation cannot cancel a running job',{timeout:45000},async()=>{
  await open();const pending=page.waitForEvent('download');await card(ids.ready).locator('[data-queue-action=download]').click();const downloaded=await pending;assert.equal(downloaded.suggestedFilename(),'Result.png');const stream=await downloaded.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),imageBytes);
  for(const action of ['open','edit','redo']){await card(ids.ready).locator(`[data-queue-action=${action}]`).click();assert.equal(await page.locator('#generationQueueDialog').isVisible(),false);assert.deepEqual((await page.evaluate(()=>window.queueActions)).at(-1),{action,kind:'image',id:ids.ready});await open();}
  await card(ids.queued).locator('[data-queue-action=cancel]').click();await page.waitForFunction(id=>document.querySelector(`[data-job-id="${id}"] .generation-queue-state`)?.textContent==='Canceled',ids.queued);assert.equal(await card(ids.queued).locator('[data-queue-action=cancel]').count(),0);assert(requests.some(req=>req.path===`/api/sheets/jobs/${ids.queued}/cancel`&&req.headers['x-asun-sheet-token']==='sheet-token'));
  jobs[1]=record(ids.queued,'queued','sheet');await refresh();cancelRace=true;await card(ids.queued).locator('[data-queue-action=cancel]').click();await page.waitForFunction(()=>window.queueErrors.length===1);assert.match(await page.locator('#generationQueueStatus').textContent(),/already started/);assert.equal(await card(ids.queued).locator('.generation-queue-state').textContent(),'Generating');assert.equal(await card(ids.queued).locator('[data-queue-action=cancel]').count(),0);
});

test('token renewal, connection errors and recovery preserve prior jobs without claiming completion',{timeout:45000},async()=>{
  const statusRequestsBefore=requests.filter(req=>req.path==='/api/images/status').length,rejectionsBefore=authRejections.length;
  tokens={image:'image-token-renewed',sheet:'sheet-token-renewed'};await refresh();
  assert.equal(await page.locator('#generationQueueButton').getAttribute('data-error'),'false');assert(requests.filter(req=>req.path==='/api/images/status').length>statusRequestsBefore);
  assert(authRejections.slice(rejectionsBefore).some(req=>req.path==='/api/generation-queue/status'&&(req.headers['x-asun-image-token']==='image-token'||req.headers['x-asun-sheet-token']==='sheet-token')),'The server rejected an actual cached token before renewal.');
  assert(requests.some(req=>req.path==='/api/generation-queue/status'&&req.headers['x-asun-image-token']===tokens.image),'The queue retried with the renewed token.');
  await open();queueError='Local queue service is temporarily unavailable.';await refresh();assert.equal(await page.locator('#generationQueueCount').textContent(),'!');assert.match(await page.locator('#generationQueueStatus').textContent(),/Last known jobs/);assert.equal(await card(ids.running).locator('.generation-queue-state').textContent(),'Generating');assert.equal(await card(ids.running).locator('[data-queue-action=open]').count(),0);
  queueError=null;queueMessage='The queue lock needs recovery. No new request was sent.';await refresh();assert.equal(await page.locator('#generationQueueCount').textContent(),'!');assert.match(await page.locator('#generationQueueStatus').textContent(),/lock needs recovery/);assert.equal(await card(ids.queued).locator('.generation-queue-state').textContent(),'Queued');
  queueMessage='';await refresh();assert.equal(await page.locator('#generationQueueCount').textContent(),'2');assert.equal(await page.locator('#generationQueueButton').getAttribute('data-error'),'false');assert.equal(await page.locator('#generationQueueStatus').evaluate(node=>node.classList.contains('is-error')),false);await page.keyboard.press('Escape');assert.equal(await page.locator('#generationQueueDialog').isVisible(),false);
});
