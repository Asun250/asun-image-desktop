import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {createGenerationQueue} from '../desktop-generation-queue.mjs';
import {createDesktopSheetService} from '../desktop-sheet-service.mjs';
import {prepareImageRequest} from '../desktop-image-request.mjs';
import {newProject,addRaster,addText,addDrawing,addReference,linkReferences,updateLabelComment,serializeProject,updateLayer,attachObjectRegion,referenceProject,updateReferenceAnnotations} from '../public/core.mjs';

const qa=path.resolve('qa','generation-auth-reconnect'),model='gpt-image-2.5-sunburst';
const report={suite:'Browser survives real local server restart and renews generation authorization',paidCalls:0,cases:[]};
let browser,context,page,server,base,queue,images,sheets,tempRoot,posts,responses,providerCalls,errors,output,held,epoch;
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
async function waitFor(check,label){for(let n=0;n<350;n++){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,30));}assert.fail(label||'Expected asynchronous state.');}
before(async()=>{await mkdir(qa,{recursive:true});browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));await browser?.close();});
async function startServer(port=0){
  epoch++;queue=createGenerationQueue({directory:path.join(tempRoot,'queue'),pollMs:25});
  const fakeProvider=async(url,options={})=>{
    if(url.endsWith('/models'))return json({data:[{id:model}]});
    assert.equal(options.method,'POST');assert.match(url,/\/images\/(edits|generations)$/);
    const fields=typeof options.body==='string'?JSON.parse(options.body):Object.fromEntries([...options.body.entries()].filter(([key])=>key!=='image[]'));
    const inputs=typeof options.body==='string'?[]:await Promise.all(options.body.getAll('image[]').map(async image=>Buffer.from(await image.arrayBuffer()).toString('base64')));
    let release;const gate=new Promise(resolve=>{release=resolve;});const call={epoch,fields,inputs,release};providerCalls.push(call);held.add(call);
    const abort=()=>release();options.signal?.addEventListener('abort',abort,{once:true});
    try{await gate;if(options.signal?.aborted)throw new Error('Isolated test finished.');return json({data:[{b64_json:output.split(',')[1]}],model,quality:fields.quality,size:fields.size});}
    finally{held.delete(call);options.signal?.removeEventListener('abort',abort);}
  };
  const common={queue,getKey:()=> 'isolated-auth-qa-never-sent',fetchImpl:fakeProvider,timeoutMs:90000};
  images=createDesktopSheetService({...common,directory:path.join(tempRoot,'images'),label:'image',prepareRequest:prepareImageRequest});sheets=createDesktopSheetService({...common,directory:path.join(tempRoot,'sheets')});
  server=createServer({generationQueue:queue,images,sheets,resumeQueue:true,detection:{token:'auth-qa-detection',status:async()=>({available:false}),dispose(){}},imageSearch:{dispose(){}}});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
}
async function stopServer(){if(!server)return;const current=server;server=null;queue.dispose();images.dispose();sheets.dispose();current.closeIdleConnections?.();const closed=new Promise(resolve=>current.close(resolve));current.closeAllConnections?.();await closed;await waitFor(()=>held.size===0,'Fake requests release.');await new Promise(resolve=>setTimeout(resolve,90));}
async function restart(){const port=server.address().port,old={image:images.token,sheet:sheets.token};await stopServer();await startServer(port);assert.notEqual(images.token,old.image);assert.notEqual(sheets.token,old.sheet);return old;}
beforeEach(async()=>{
  posts=[];responses=[];providerCalls=[];errors=[];held=new Set();epoch=0;tempRoot=await mkdtemp(path.join(os.tmpdir(),'asun-auth-reconnect-'));await startServer();
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});await context.addInitScript(()=>{localStorage.setItem('asun-image-appearance','dark');window.authReconnectDocumentMarker=crypto.randomUUID();});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  output=await fixture('#7898b4',640,480);
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==base){errors.push('External request blocked: '+url.origin);return route.abort();}if(request.method()==='POST'&&/^\/api\/(images|sheets)\/generate$/.test(url.pathname))posts.push({kind:url.pathname.includes('/sheets/')?'sheet':'image',body:request.postData(),input:request.postDataJSON(),epoch,token:request.headers()[url.pathname.includes('/sheets/')?'x-asun-sheet-token':'x-asun-image-token']});return route.continue();});
  page.on('response',response=>{const url=new URL(response.url());if(url.pathname.startsWith('/api/'))responses.push({path:url.pathname,status:response.status(),method:response.request().method(),epoch});});
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();await page.waitForFunction(model=>document.getElementById('model')?.value===model,model);
});
afterEach(async info=>{
  try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});report.cases.push({name:info.name,status:info.error?'failed':'passed',error:info.error?.message,localSubmitAttempts:posts.length,providerRequests:providerCalls.length,rejectedStaleTokens:responses.filter(item=>item.status===403).map(item=>item.path)});assert.deepEqual(errors,[]);}
  finally{await context?.close();await stopServer();assert.equal(path.dirname(path.resolve(tempRoot)),path.resolve(os.tmpdir()));assert(path.basename(tempRoot).startsWith('asun-auth-reconnect-'));await rm(tempRoot,{recursive:true,force:true});}
});
async function fixture(color,width=480,height=320){return page.evaluate(({color,width,height})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const x=c.getContext('2d');x.fillStyle='#e8dfd1';x.fillRect(0,0,width,height);x.fillStyle=color;x.fillRect(width*.2,height*.2,width*.6,height*.55);return c.toDataURL();},{color,width,height});}
async function richProject(){
  const source=await fixture('#ad7849'),ref=await fixture('#559458',240,180),raster=addRaster(newProject(480,320,'Keep my unsaved reference edits'),{name:'Original scene.png',source,width:480,height:320});let project=updateLayer(raster.project,raster.layerId,{rotation:12,mask:[{mode:'hide',size:12,points:[[20,20],[50,20]]}]});
  project=addReference(project,{name:'Material reference.png',source:ref,width:240,height:180});const drawing=addDrawing(referenceProject(project.references[0]),{mode:'pencil',size:5,color:'#ff0000',points:[[40,40],[180,40],[180,130]]});project=updateReferenceAnnotations(project,project.references[0].id,drawing.project.layers.slice(1));
  const label=addText(project,{content:'1',x:150,y:100,width:28,height:32,fontSize:26,color:'#ff0000'});project=linkReferences(label.project,label.layerId,[project.references[0].id]);project=updateLabelComment(project,label.layerId,'Apply this reference to all four selected birds.');project=attachObjectRegion(project,label.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:raster.layerId,sourceWidth:480,sourceHeight:320,mask:{width:4,height:4,counts:[0,1,2,1,8,1,2,1]},group:{areaCount:4}});project.prompt='Keep the scene framing.';return project;
}
async function load(project){await page.locator('#projectInput').setInputFiles({name:'Auth reconnect source.asun',mimeType:'application/json',buffer:Buffer.from(serializeProject(project))});await page.waitForFunction(count=>document.querySelectorAll('.layer-row').length===count&&!document.body.classList.contains('busy'),project.layers.length);}
async function save(){const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const item=await pending,stream=await item.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);await page.waitForTimeout(725);return JSON.parse(Buffer.concat(chunks).toString());}
async function openQueue(){await page.locator('#generationQueueButton').click();await page.locator('#generationQueueDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!document.getElementById('generationQueueRefresh').disabled);}
async function verifyRetry(kind,expected,quality,oldToken){
  const selector=kind==='image'?'#generate':'[data-sheet-action=generate]';await page.locator(selector).click();await waitFor(()=>providerCalls.length===1,'One request reaches the fake provider after renewal.');await page.waitForFunction(selector=>!document.querySelector(selector).disabled,selector);
  const attempts=posts.filter(item=>item.kind===kind);assert.equal(attempts.length,2,'One stale local POST and one authorized retry.');assert.equal(attempts[0].token,oldToken);assert.notEqual(attempts[1].token,oldToken);assert.equal(attempts[0].body,attempts[1].body,'Renewal retries the exact body and request ID.');assert.deepEqual(attempts[1].input.project,expected);assert.equal(attempts[1].input.model,model);assert.equal(attempts[1].input.quality,quality);
  const service=kind==='image'?images:sheets,id=attempts[1].input.requestId;assert.deepEqual((await service.project(id)).project,expected);assert.equal((await queue.status()).items.length,1,'The rejected stale request is never admitted.');assert.equal(providerCalls[0].fields.model,model);assert.equal(providerCalls[0].fields.quality,quality);assert(providerCalls[0].inputs.includes(expected.references[0].source.split(',')[1]),'The original reference image survives renewal into the actual provider payload.');assert.equal(responses.filter(item=>item.path===`/api/${kind==='image'?'images':'sheets'}/generate`&&item.status===403).length,1);return id;
}

test('Generate renews image authorization across a real same-port server restart without reloading or losing unsaved edits',{timeout:60000},async()=>{
  const project=await richProject();await load(project);await page.locator('#imageQuality').selectOption('max');const baseline=await save();await page.locator('#prompt').fill('UNSAVED IMAGE: Replace the four birds using my annotated reference.');await page.locator('#prompt').dispatchEvent('change');const expected={...baseline,prompt:await page.locator('#prompt').inputValue()};await page.locator('.layer-row').last().click();const selected=await page.locator('.layer-row.selected').getAttribute('data-id'),canvas=await page.locator('#canvas').evaluate(canvas=>canvas.toDataURL()),marker=await page.evaluate(()=>window.authReconnectDocumentMarker);
  assert.match(await page.locator('#savedState').textContent(),/Unsaved/);const old=await restart();const id=await verifyRetry('image',expected,'max',old.image);
  assert.equal(await page.evaluate(()=>window.authReconnectDocumentMarker),marker);assert.equal(await page.locator('#canvas').evaluate(canvas=>canvas.toDataURL()),canvas);assert.equal(await page.locator('.layer-row.selected').getAttribute('data-id'),selected);assert.equal(await page.locator('#model').inputValue(),model);assert.equal(await page.locator('#imageQuality').inputValue(),'max');assert.match(await page.locator('#savedState').textContent(),/Unsaved/);assert.deepEqual(await save(),expected);assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false);
  await openQueue();assert.equal(await page.locator('#generationQueueButton').getAttribute('data-error'),'false');assert.equal(await page.locator(`#generationQueueList [data-job-id="${id}"] .generation-queue-state`).textContent(),'Generating');assert(responses.some(item=>item.path==='/api/generation-queue/status'&&item.status===403),'The independently cached queue token is renewed too.');await page.screenshot({path:path.join(qa,'image-reconnected-unsaved-source-kept.png')});await page.locator('#generationQueueClose').click();providerCalls[0].release();await waitFor(async()=>(await images.job(id)).status==='completed');await page.waitForTimeout(1800);assert.equal(providerCalls.length,1);assert.deepEqual(await save(),expected);assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false);
});

test('an open sheet creator renews its own authorization while retaining all subject photos, marked references and settings',{timeout:60000},async()=>{
  await load(await richProject());await page.locator('#characterItemSheet').click();await page.locator('#asunSheetCreator').waitFor({state:'visible'});await page.locator('[data-sheet-subject=building]').click();await page.locator('[data-sheet-views="7"]').click();await page.locator('[data-sheet-reference]').first().check();await page.locator('[data-sheet-notes]').fill('UNSAVED SHEET: Only use the marked building and annotated material.');await page.locator('[data-sheet-notes]').dispatchEvent('change');await page.waitForFunction(()=>!document.querySelector('[data-sheet-quality]').disabled);await page.locator('[data-sheet-quality]').selectOption('xhigh');
  // The available queue route closes the sheet without changing its active preset.
  await page.locator('[data-sheet-action=queue]').click();await page.locator('#generationQueueDialog').waitFor({state:'visible'});await page.locator('#generationQueueClose').click();const expected=await save();await page.locator('#characterItemSheet').click();await page.locator('#asunSheetCreator').waitFor({state:'visible'});await page.locator('[data-sheet-notes]').fill(expected.sheetPreset.notes+' Keep the white background.');await page.locator('[data-sheet-notes]').dispatchEvent('change');expected.sheetPreset.notes+=' Keep the white background.';const marker=await page.evaluate(()=>window.authReconnectDocumentMarker);const old=await restart();const id=await verifyRetry('sheet',expected,'xhigh',old.sheet);
  assert.equal(await page.evaluate(()=>window.authReconnectDocumentMarker),marker);assert.equal(await page.locator('#asunSheetCreator').isVisible(),true);assert.equal(await page.locator('[data-sheet-notes]').inputValue(),expected.sheetPreset.notes);assert.equal(await page.locator('[data-sheet-quality]').inputValue(),'xhigh');assert.equal(await page.locator('[data-sheet-model]').inputValue(),model);assert.equal(await page.locator('[data-sheet-action=close]').isEnabled(),true);assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false);await page.screenshot({path:path.join(qa,'sheet-reconnected-settings-kept.png')});
  await page.locator('[data-sheet-action=queue]').click();await page.locator('#generationQueueDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!document.getElementById('generationQueueRefresh').disabled);assert.equal(await page.locator('#generationQueueButton').getAttribute('data-error'),'false');await page.locator('#generationQueueClose').click();assert.deepEqual(await save(),expected);providerCalls[0].release();await waitFor(async()=>(await sheets.job(id)).status==='completed');await page.waitForTimeout(1800);assert.equal(providerCalls.length,1);assert.equal(await page.locator('#asunSheetCreator').isVisible(),false);assert.deepEqual(await save(),expected);
});
