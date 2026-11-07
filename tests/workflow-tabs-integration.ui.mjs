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
import {newProject,addRaster,addText,addDrawing,addReference,linkReferences,updateLabelComment,serializeProject,updateLayer,attachObjectRegion,referenceProject,updateReferenceAnnotations,updateReferenceNotes} from '../public/core.mjs';

const qa=path.resolve('qa','workflow-tabs-integration'),model='gpt-image-2.5-sunburst',report={suite:'Workflow tabs with real persisted queue and isolated fake provider',paidCalls:0,cases:[]};
let browser,context,page,server,base,queue,images,sheets,tempRoot,requests,providerCalls,errors,output,maxActive,activeCalls;
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
async function waitFor(check,label){for(let n=0;n<300;n++){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,30));}assert.fail(label||'Expected asynchronous state.');}
before(async()=>{await mkdir(qa,{recursive:true});browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));await browser?.close();});
beforeEach(async()=>{
  requests=[];providerCalls=[];errors=[];activeCalls=0;maxActive=0;tempRoot=await mkdtemp(path.join(os.tmpdir(),'asun-workflow-tabs-'));
  queue=createGenerationQueue({directory:path.join(tempRoot,'queue'),pollMs:25});
  const fakeProvider=async(url,options={})=>{
    if(url.endsWith('/models'))return json({data:[{id:model},{id:'gpt-image-1.5'}]});
    assert.equal(options.method,'POST');assert.match(url,/\/images\/(edits|generations)$/);
    const fields=typeof options.body==='string'?JSON.parse(options.body):Object.fromEntries([...options.body.entries()].filter(([key])=>key!=='image[]'));
    const inputImages=typeof options.body==='string'?[]:await Promise.all(options.body.getAll('image[]').map(async image=>Buffer.from(await image.arrayBuffer()).toString('base64')));
    let release;const gate=new Promise(resolve=>{release=resolve;});const call={url,fields,inputImages,release};providerCalls.push(call);activeCalls++;maxActive=Math.max(maxActive,activeCalls);
    const abort=()=>release();options.signal?.addEventListener('abort',abort,{once:true});
    try{await gate;if(options.signal?.aborted)throw new Error('Isolated test finished.');return json({data:[{b64_json:output.split(',')[1]}],model,quality:fields.quality,size:fields.size});}
    finally{activeCalls--;options.signal?.removeEventListener('abort',abort);}
  };
  const common={queue,getKey:()=> 'isolated-qa-key-never-sent',fetchImpl:fakeProvider,timeoutMs:120000};
  images=createDesktopSheetService({...common,directory:path.join(tempRoot,'images'),label:'image',prepareRequest:prepareImageRequest});
  sheets=createDesktopSheetService({...common,directory:path.join(tempRoot,'sheets')});
  server=createServer({generationQueue:queue,images,sheets,resumeQueue:true,detection:{token:'qa-detection',status:async()=>({available:false,message:'Manual selection remains available.'}),dispose(){}},imageSearch:{dispose(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});await context.addInitScript(()=>localStorage.setItem('asun-image-appearance','dark'));page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.type()==='beforeunload'?dialog.accept():dialog.dismiss());
  output=await image('#668aa3',640,480,'Simulated provider result');
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==base){errors.push('External request blocked: '+url.origin);return route.abort();}if(request.method()==='POST'&&/^\/api\/(images|sheets)\/generate$/.test(url.pathname))requests.push({kind:url.pathname.includes('/sheets/')?'sheet':'image',...request.postDataJSON()});return route.continue();});
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();await page.waitForFunction(model=>document.getElementById('model')?.value===model,model);await page.locator('#newWorkflowTab').waitFor({state:'visible'});
});
afterEach(async info=>{
  try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});report.cases.push({name:info.name,status:info.error?'failed':'passed',error:info.error?.message,queuedRequests:requests.length,providerPosts:providerCalls.length,maxConcurrentProviderPosts:maxActive});assert.deepEqual(errors,[]);}
  finally{await context?.close();queue.dispose();images.dispose();sheets.dispose();await waitFor(()=>activeCalls===0,'Fake provider stops.');if(server)await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>setTimeout(resolve,100));assert.equal(path.dirname(path.resolve(tempRoot)),path.resolve(os.tmpdir()));assert(path.basename(tempRoot).startsWith('asun-workflow-tabs-'));await rm(tempRoot,{recursive:true,force:true});}
});
async function image(color,width=480,height=320,label='Original source'){return page.evaluate(({color,width,height,label})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const x=c.getContext('2d');x.fillStyle='#e6dfd4';x.fillRect(0,0,width,height);x.fillStyle=color;x.fillRect(width*.2,height*.2,width*.6,height*.55);x.fillStyle='#263749';x.font='16px Arial';x.fillText(label,12,height-20);return c.toDataURL();},{color,width,height,label});}
const file=(source,name)=>({name,mimeType:'image/png',buffer:Buffer.from(source.split(',')[1],'base64')});
async function richProject(){
  const source=await image('#b98351'),ref=await image('#5c965f',240,180,'Green reference');
  const added=addRaster(newProject(480,320,'Project A — original setup'),{name:'Original scene A.png',source,width:480,height:320});let project=updateLayer(added.project,added.layerId,{rotation:17,brightness:93,mask:[{mode:'hide',size:8,points:[[20,20],[40,20]]}]});
  project=addReference(project,{name:'Appearance A.png',source:ref,width:240,height:180});project=updateReferenceNotes(project,project.references[0].id,'Use the green material only.');
  const marked=addDrawing(referenceProject(project.references[0]),{mode:'pencil',color:'#ff0000',size:5,points:[[30,40],[180,40],[180,120]]});project=updateReferenceAnnotations(project,project.references[0].id,marked.project.layers.slice(1));
  const label=addText(project,{content:'1',x:140,y:110,width:25,height:30,fontSize:24,color:'#ff0000'});project=label.project;project=linkReferences(project,label.layerId,[project.references[0].id]);project=updateLabelComment(project,label.layerId,'Replace all four selected birds with the green reference appearance.');project=attachObjectRegion(project,label.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:added.layerId,sourceWidth:480,sourceHeight:320,mask:{width:4,height:4,counts:[0,1,2,1,8,1,2,1]},group:{areaCount:4}});project.prompt='PROJECT_A: Keep all four areas, references and image rotation.';return project;
}
async function load(project){await page.locator('#projectInput').setInputFiles({name:'Queue source.asun',mimeType:'application/json',buffer:Buffer.from(serializeProject(project))});await page.waitForFunction(count=>document.querySelectorAll('.layer-row').length===count&&!document.body.classList.contains('busy'),project.layers.length);}
async function save(selector='#saveProject'){await page.waitForFunction(()=>!document.body.classList.contains('busy'));assert.equal(await page.locator(selector).evaluate(node=>Boolean(node.closest('[inert]'))),false,'The active workflow editor must not remain inert after closing a sheet.');const pending=page.waitForEvent('download',{timeout:5000});pending.catch(()=>{});await page.locator(selector).click({timeout:5000});let item;try{item=await pending;}catch(error){throw new Error(error.message+' | UI: '+await page.locator('#toast').innerText());}const stream=await item.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);await page.waitForTimeout(725);return JSON.parse(Buffer.concat(chunks).toString());}
async function prompt(text){await page.locator('#prompt').fill(text);await page.locator('#prompt').dispatchEvent('change');}
async function submit(kind='image'){const count=requests.length,selector=kind==='sheet'?'[data-sheet-action=generate]':'#generate';await page.locator(selector).waitFor({state:'visible'});await page.waitForFunction(selector=>!document.querySelector(selector).disabled,selector);await page.locator(selector).click();await waitFor(()=>requests.length===count+1,'Request accepted.');await page.waitForFunction(selector=>!document.querySelector(selector).disabled,selector);return requests.at(-1);}
async function newBlank(name){await page.locator('#newProject').click();await page.locator('#desktopCreateDialog .desktop-create-blank').click();await page.locator('#nameField').fill(name);await page.locator('#widthField').fill('480');await page.locator('#heightField').fill('320');await page.locator('#confirmDialog').click();await page.locator('#dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===0);}
async function openQueue(){await page.locator('#generationQueueButton').click();await page.locator('#generationQueueDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!document.getElementById('generationQueueRefresh').disabled);}
const jobCard=id=>page.locator(`#generationQueueList [data-job-id="${id}"]`);
async function complete(index,id,service=images){providerCalls[index].release();await waitFor(async()=>(await service.job(id)).status==='completed','Job completes.');}
async function closeResult(){await page.locator('[data-image-result-close]').first().click();await page.locator('#desktopImageResultDialog').waitFor({state:'hidden'});}

const activeId=()=>page.locator('[data-workflow-tab][aria-selected=true]').getAttribute('data-workflow-tab');
const tabIds=()=>page.locator('[data-workflow-tab]').evaluateAll(nodes=>nodes.map(node=>node.dataset.workflowTab));
const tab=id=>page.locator(`[data-workflow-tab="${id}"]`);
async function switchTab(id){await tab(id).click();await page.waitForFunction(id=>document.querySelector(`[data-workflow-tab="${id}"]`)?.getAttribute('aria-selected')==='true'&&!document.body.classList.contains('busy'),id);}
async function newTab(){const before=await tabIds();await page.locator('#newWorkflowTab').click();await page.waitForFunction(count=>document.querySelectorAll('[data-workflow-tab]').length===count,countPlus(before.length));await page.waitForFunction(()=>!document.body.classList.contains('busy'));const id=await activeId();assert(!before.includes(id));return id;}
const countPlus=count=>count+1;
async function savedTabs(ids,selected){await page.waitForFunction(async({ids,selected})=>{const {createWorkflowSessionStore}=await import('/workflow-session-store.mjs'),store=createWorkflowSessionStore();try{const session=await store.load();return session?.activeId===selected&&ids.every(id=>session.tabs.some(tab=>tab.id===id));}finally{await store.close();}},{ids,selected});}
async function readyAfterReload(){await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();await page.locator('[data-workflow-tab][aria-selected=true]').waitFor({state:'visible'});await page.waitForFunction(()=>!document.body.classList.contains('busy'));}
async function rotateView(degrees){await page.locator('#rotateView').click();await page.locator('#viewRotationValue').fill(String(degrees));await page.locator('#viewRotationValue').dispatchEvent('change');await page.locator('#closeViewRotation').click();}
async function openTabQueue(){await page.locator('#workflowTabsQueue').click();await page.locator('#generationQueueDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!document.getElementById('generationQueueRefresh').disabled);}

test('live workflow tabs isolate editable drafts, model settings and undo while queued jobs stay immutable and recover on reload',{timeout:120000},async()=>{
  const original=await richProject();await load(original);const a=await activeId();await page.locator('#imageQuality').selectOption('max');await rotateView(31);const viewA=await page.locator('#viewRotationReadout').innerText(),beforeA=await save();
  const invalidPixels=structuredClone(beforeA);invalidPixels.assets[invalidPixels.original.assetId].source='data:image/png;base64,AAAA';
  const wrongDimensions=structuredClone(beforeA);wrongDimensions.references[0].width++;
  for(const body of ['{broken project',JSON.stringify(invalidPixels),JSON.stringify(wrongDimensions)]){
    await page.locator('#projectInput').setInputFiles({name:'Invalid.asun',mimeType:'application/json',buffer:Buffer.from(body)});await page.waitForFunction(()=>!document.body.classList.contains('busy'));
    assert.equal(await page.locator('#toast').evaluate(node=>node.classList.contains('error')),true,'Invalid native files report the error.');assert.deepEqual(await tabIds(),[a],'A failed native import must not create a blank workflow.');assert.equal(await activeId(),a);assert.deepEqual(await save(),beforeA,'A failed native import keeps the current editable project unchanged.');assert.equal(await page.locator('#viewRotationReadout').innerText(),viewA);assert.equal(requests.length,0);
  }
  const first=await submit();await waitFor(()=>providerCalls.length===1);assert.equal(await activeId(),a);assert.deepEqual((await images.project(first.requestId)).project,beforeA);
  const b=await newTab();assert.equal(await page.locator('.layer-row').count(),0);const sourceB=await image('#5f76a6'),referenceB=await image('#c384c6',160,160,'Reference B');
  await page.locator('#imageInput').setInputFiles(file(sourceB,'Original B.png'));await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));
  await page.locator('#referenceInput').setInputFiles(file(referenceB,'Appearance B.png'));await page.waitForFunction(()=>document.querySelectorAll('#referenceList .reference-card').length===1&&!document.body.classList.contains('busy'));
  await prompt('PROJECT_B: Apply the purple reference.');await page.locator('#model').selectOption('gpt-image-1.5');await page.locator('#imageQuality').selectOption('low');const second=await submit();assert.equal(providerCalls.length,1);assert.equal((await images.job(second.requestId)).status,'queued');
  await prompt('PROJECT_B: Keep these later unsent edits.');const workingB=await save();
  await switchTab(a);assert.equal(await page.locator('#model').inputValue(),model);assert.equal(await page.locator('#imageQuality').inputValue(),'max');assert.equal(await page.locator('#viewRotationReadout').innerText(),viewA);assert.deepEqual(await save(),beforeA);
  const livePrompt='PROJECT_A: Unsent roof adjustment while the first image generates.';await prompt(livePrompt);await page.locator('#undo').click();assert.equal(await page.locator('#prompt').inputValue(),beforeA.prompt);await page.locator('#redo').click();assert.equal(await page.locator('#prompt').inputValue(),livePrompt);const liveA=await save();
  await switchTab(b);assert.deepEqual(await save(),workingB);assert.equal(await page.locator('#model').inputValue(),'gpt-image-1.5');assert.equal(await page.locator('#imageQuality').inputValue(),'low');
  await complete(0,first.requestId);await waitFor(()=>providerCalls.length===2);await page.waitForTimeout(1900);assert.deepEqual(await save(),workingB);assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false);assert.equal(await activeId(),b);
  await openTabQueue();await jobCard(first.requestId).locator('[data-queue-action=workflow]').click();await page.locator('#generationQueueDialog').waitFor({state:'hidden'});assert.equal(await activeId(),a);assert.deepEqual(await save(),liveA,'Open workflow restores the live draft, not the original submitted snapshot.');assert.deepEqual((await images.project(first.requestId)).project,beforeA);
  const third=await submit(),fork=await activeId();assert.notEqual(fork,a);assert.notEqual(fork,b);assert.equal((await tabIds()).length,3);assert.equal((await images.job(third.requestId)).status,'queued');assert.deepEqual(third.project,liveA);
  await prompt('FORK_ONLY: changes stay in the newly generated workflow.');const forkDraft=await save();await switchTab(a);assert.deepEqual(await save(),liveA);await switchTab(b);assert.deepEqual(await save(),workingB);
  await savedTabs([a,b,fork],b);await page.screenshot({path:path.join(qa,'three-workflows-ready-running-queued.png')});await page.reload();await readyAfterReload();assert.deepEqual(new Set(await tabIds()),new Set([a,b,fork]));assert.equal(await activeId(),b);assert.deepEqual(await save(),workingB);assert.equal(await page.locator('#model').inputValue(),'gpt-image-1.5');assert.equal(await page.locator('#imageQuality').inputValue(),'low');assert.equal(requests.length,3,'Reload never submits another generation.');
  await switchTab(a);assert.deepEqual(await save(),liveA);assert.equal(await page.locator('#viewRotationReadout').innerText(),viewA);await page.locator('#undo').click();assert.equal(await page.locator('#prompt').inputValue(),beforeA.prompt);await page.locator('#redo').click();assert.equal(await page.locator('#prompt').inputValue(),livePrompt);
  await switchTab(fork);assert.deepEqual(await save(),forkDraft);await switchTab(b);await complete(1,second.requestId);await waitFor(()=>providerCalls.length===3);await complete(2,third.requestId);await page.waitForTimeout(1800);assert.deepEqual(await save(),workingB);
  assert.equal(providerCalls[0].fields.quality,'max');assert.equal(providerCalls[1].fields.quality,'low');assert.equal(providerCalls[1].fields.model,'gpt-image-1.5');assert.equal(providerCalls[2].fields.quality,'max');assert(providerCalls[0].inputImages.includes(beforeA.references[0].source.split(',')[1]));assert(providerCalls[1].inputImages.includes(referenceB.split(',')[1]));assert.equal(maxActive,1);assert.equal(requests.length,3);
});

test('sheet workflows remain switchable above the sheet page and retain their own settings and references after reload',{timeout:90000},async()=>{
  await load(await richProject());const a=await activeId();await page.locator('#characterItemSheet').click();await page.locator('#asunSheetCreator').waitFor({state:'visible'});
  await page.locator('[data-sheet-subject=building]').click();await page.locator('[data-sheet-views="7"]').click();await page.locator('[data-sheet-notes]').fill('SHEET_A: Only the building, seven white-background angles.');await page.locator('[data-sheet-notes]').dispatchEvent('change');await page.waitForFunction(()=>!document.querySelector('[data-sheet-quality]').disabled);await page.locator('[data-sheet-quality]').selectOption('xhigh');const first=await submit('sheet');await waitFor(()=>providerCalls.length===1);
  const b=await newTab();await page.locator('#asunSheetCreator').waitFor({state:'hidden'});await prompt('IMAGE_B: A glass blue vase.');await page.locator('#imageQuality').selectOption('medium');const second=await submit();assert.equal((await images.job(second.requestId)).status,'queued');
  await switchTab(a);await page.locator('#asunSheetCreator').waitFor({state:'visible'});assert.equal(await page.locator('[data-sheet-quality]').inputValue(),'xhigh');assert.equal(await page.locator('[data-sheet-notes]').inputValue(),'SHEET_A: Only the building, seven white-background angles.');assert.equal(await page.locator('#newWorkflowTab').isVisible(),true);
  await page.locator('[data-sheet-notes]').fill('SHEET_A: Later live adjustment, preserve all references.');await page.locator('[data-sheet-notes]').dispatchEvent('change');await switchTab(b);assert.equal(await page.locator('#imageQuality').inputValue(),'medium');assert.equal(await page.locator('#prompt').inputValue(),'IMAGE_B: A glass blue vase.');await switchTab(a);
  await savedTabs([a,b],a);await page.reload();await readyAfterReload();assert.equal(await activeId(),a);await page.locator('#asunSheetCreator').waitFor({state:'visible'});assert.equal(await page.locator('[data-sheet-notes]').inputValue(),'SHEET_A: Later live adjustment, preserve all references.');assert.equal(await page.locator('[data-sheet-quality]').inputValue(),'xhigh');assert.equal(requests.length,2);
  await page.screenshot({path:path.join(qa,'sheet-workflow-tabs-above-page.png')});await switchTab(b);const working=await save();await complete(0,first.requestId,sheets);await waitFor(()=>providerCalls.length===2);await complete(1,second.requestId);await page.waitForTimeout(1800);assert.deepEqual(await save(),working);assert.equal(await page.locator('#asunSheetCreator').isVisible(),false);assert.equal(providerCalls[0].fields.quality,'xhigh');assert.equal(providerCalls[1].fields.quality,'medium');assert.equal(maxActive,1);
});

test('each workflow keeps independent main and sketch drafts plus sketch undo/redo through switching and reload',{timeout:90000},async()=>{
  const original=await richProject();await load(original);const a=await activeId();await page.locator('#drawSketchReference').click();await page.locator('#sketchWorkspaceBar').waitFor({state:'visible'});await page.locator('#sketchDraw').click();
  const board=await page.locator('#board').boundingBox();await page.mouse.move(board.x+board.width*.25,board.y+board.height*.25);await page.mouse.down();for(const [x,y]of [[.6,.25],[.6,.65],[.25,.65],[.25,.25]])await page.mouse.move(board.x+board.width*x,board.y+board.height*y,{steps:4});await page.mouse.up();const sketch=await save();assert.equal(sketch.layers.filter(layer=>layer.kind==='drawing').length,1);
  const b=await newTab();assert.equal(await page.locator('#sketchWorkspaceBar').isVisible(),false);await prompt('PROJECT_B: independent blank draft.');const workingB=await save();await switchTab(a);await page.locator('#sketchWorkspaceBar').waitFor({state:'visible'});assert.deepEqual(await save(),sketch);await page.locator('#undo').click();assert.equal((await save()).layers.filter(layer=>layer.kind==='drawing').length,0);await page.locator('#redo').click();assert.deepEqual(await save(),sketch);
  await page.locator('#sketchBack').click();await page.locator('#sketchWorkspaceBar').waitFor({state:'hidden'});assert.deepEqual(await save(),original);await switchTab(b);assert.deepEqual(await save(),workingB);await switchTab(a);await savedTabs([a,b],a);await page.reload();await readyAfterReload();assert.deepEqual(await save(),original);
  await page.locator('#drawSketchReference').click();await page.locator('#sketchWorkspaceBar').waitFor({state:'visible'});assert.deepEqual(await save(),sketch);await page.locator('#undo').click();assert.equal((await save()).layers.filter(layer=>layer.kind==='drawing').length,0);await page.locator('#redo').click();assert.deepEqual(await save(),sketch);await switchTab(b);assert.deepEqual(await save(),workingB);assert.equal(requests.length,0);assert.equal(providerCalls.length,0);
});

test('closing a dirty workflow requires confirmation, keeps its job running, and queue reopen recovers its submitted setup',{timeout:60000},async()=>{
  await load(await richProject());const a=await activeId();await prompt('CLOSE_A: submitted source stays with the job.');const first=await submit();await waitFor(()=>providerCalls.length===1);
  await prompt('CLOSE_A: later unsaved draft will be discarded only after confirmation.');const b=await newTab();await prompt('KEEP_B: another workflow stays intact.');
  await page.locator(`[data-workflow-close="${a}"]`).click();await page.locator('#dialog').waitFor({state:'visible'});assert.match(await page.locator('#dialog').innerText(),/Close this workflow tab/);await page.locator('#cancelDialog').click();assert.deepEqual(new Set(await tabIds()),new Set([a,b]));assert.equal(await activeId(),b);
  await page.locator(`[data-workflow-close="${a}"]`).click();await page.locator('#confirmDialog').click();await page.locator('#dialog').waitFor({state:'hidden'});assert.deepEqual(await tabIds(),[b]);assert.equal((await images.job(first.requestId)).status,'running');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_B: another workflow stays intact.');
  await openTabQueue();await jobCard(first.requestId).locator('[data-queue-action=workflow]').click();await page.locator('#generationQueueDialog').waitFor({state:'hidden'});await page.waitForFunction(id=>document.querySelector('[data-workflow-tab][aria-selected=true]')?.dataset.workflowTab!==id&&document.querySelectorAll('[data-workflow-tab]').length===2,b);const reopened=await activeId();assert.notEqual(reopened,b);assert.equal((await tabIds()).length,2);assert.deepEqual(await save(),first.project,'Reopening a deliberately closed workflow restores its saved submission.');assert.equal(requests.length,1);
  await complete(0,first.requestId);await switchTab(b);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_B: another workflow stays intact.');assert.equal(providerCalls.length,1);assert.equal(maxActive,1);
});





