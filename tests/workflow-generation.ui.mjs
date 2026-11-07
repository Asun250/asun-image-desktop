import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

const model='gpt-image-2.5-sunburst',other='gpt-image-1.5',qa=path.resolve('qa/workflow-generation');
let server,browser,context,page,base,jobs,posts,errors,fixture;
const report=[];
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify({paidCalls:0,cases:report},null,2));await browser?.close();await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  jobs=new Map();posts=[];errors=[];context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());if(url.origin!==base)return route.abort();const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(url.pathname==='/workflow-fixture.html')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><link rel="stylesheet" href="sheet-creator.css"><link rel="stylesheet" href="desktop-image-generation.css"><link rel="stylesheet" href="generation-details.css"><link rel="stylesheet" href="workflow-tabs.css"></head><body class="has-workflow-tabs"><main id="app"><header class="header">Fixture editor</header><div id="workflowTabStrip"><button id="tabFixture">Workflow tabs stay usable</button></div><div id="afterTabs"></div><select id="model"></select><select id="imageQuality"></select><textarea id="prompt"></textarea><button id="generate">Generate</button><p id="imageQualityMessage"></p><p id="imageGenerationStatus"></p><span id="imageConnectionState"></span><button id="imageGenerationRefresh">Check connection</button><button id="imageGenerationHistory">Generation history</button><button id="imageGenerationResult" hidden>View result</button></main></body></html>`});
    if(url.pathname==='/api/generation-queue/status')return json({items:[...jobs.values()].map(({image,...record})=>record)});
    const api=/^\/api\/(images|sheets)\/(.+)$/.exec(url.pathname);if(!api)return route.continue();const kind=api[1]==='images'?'image':'sheet',action=api[2];
    if(action==='status')return json({authenticated:true,token:'workflow-'+kind,models:[{id:model,available:true},{id:other,available:true}]});
    assert.equal(request.headers()['x-asun-'+kind+'-token'],'workflow-'+kind);
    if(action==='generate'){const body=request.postDataJSON();posts.push({kind,body});const record={id:body.requestId,kind,status:'queued',model:body.model,settings:{model:body.model,quality:body.quality,prompt:body.project.prompt||body.project.sheetPreset?.notes},createdAt:new Date().toISOString()};jobs.set(record.id,record);return json(record,202);}
    if(action.startsWith('jobs/'))return json(jobs.get(action.split('/')[1]));return json({error:'Unused fixture endpoint'},404);
  });
  await page.goto(base+'/workflow-fixture.html');
  fixture=await page.evaluate(async()=>{
    const {newProject,addRaster}=await import('/core.mjs');const c=document.createElement('canvas');c.width=64;c.height=48;const ctx=c.getContext('2d');ctx.fillStyle='#448899';ctx.fillRect(0,0,64,48);const source=c.toDataURL('image/png');
    let project=newProject(64,48,'Workflow fixture');const listeners=[];window.beforeCalls=0;window.snapshotCalls=0;window.tabClicks=0;document.querySelector('#tabFixture').onclick=()=>window.tabClicks++;
    window.harness={get project(){return project;},setPrompt(value){project.prompt=value;document.querySelector('#prompt').value=value;document.querySelector('#prompt').dispatchEvent(new Event('input'));},addSource(){project=addRaster(project,{name:'Original subject.png',source,width:64,height:48}).project;},editor:{state:()=>({busy:false,hasAreaGenerationInstructions:false}),peek:()=>project,snapshot:()=>{window.snapshotCalls++;return structuredClone(project);},subscribe(fn){listeners.push(fn);return()=>{};},apply(next){project=next;listeners.forEach(fn=>fn());}}};return source;
  });
});
afterEach(async info=>{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});report.push({name:info.name,passed:!info.error,providerRequestsIntercepted:posts.length});assert.deepEqual(errors,[]);await context.close();});
function complete(id){const record=jobs.get(id);jobs.set(id,{...record,status:'completed',finishedAt:new Date().toISOString(),outputAvailable:true,image:{source:fixture,width:64,height:48,name:id+'.png'},sourceName:id});}
async function requestCount(count){await assert.doesNotReject(async()=>{for(let n=0;n<100;n++){if(posts.length===count)return;await new Promise(resolve=>setTimeout(resolve,30));}assert.equal(posts.length,count);});}

test('main image controls show only the current workflow result and await the pre-snapshot callback',async()=>{
  await page.evaluate(async()=>{
    const {mountDesktopImageGeneration}=await import('/desktop-image-generation.mjs');
    const ui=mountDesktopImageGeneration({editor:harness.editor,download:async()=>{},beforeGenerate:async()=>{window.beforeCalls++;if(window.delayBefore)await new Promise(resolve=>window.resumeBefore=resolve);},onQueued:record=>{const state=ui.bridge.state();void ui.switchWorkflow({jobIds:[{id:record.id,kind:'image'}],settings:{model:state.model,quality:state.quality}});}});harness.ui=ui;
  });
  await page.waitForFunction(()=>harness.ui.bridge.state().connected);await page.evaluate(async({model})=>{await harness.ui.switchWorkflow({jobIds:[],settings:{model,quality:'max'}});harness.setPrompt('First exact prompt');window.delayBefore=true;},{model});
  await page.locator('#generate').click();await page.waitForFunction(()=>window.beforeCalls===1);assert.equal(await page.locator('#generate').isDisabled(),true);await page.locator('#generate').evaluate(button=>button.click());assert.equal(posts.length,0);assert.equal(await page.evaluate(()=>window.snapshotCalls),0);await page.evaluate(()=>{window.delayBefore=false;window.resumeBefore();});await requestCount(1);const first=posts[0].body.requestId;await page.waitForFunction(()=>!harness.ui.bridge.state().working);
  await page.evaluate(async({other})=>{await harness.ui.switchWorkflow({jobIds:[],settings:{model:other,quality:'low'}});harness.setPrompt('Second exact prompt');},{other});await page.locator('#generate').click();await requestCount(2);const second=posts[1].body.requestId;await page.waitForFunction(()=>!harness.ui.bridge.state().working);
  complete(first);await page.evaluate(()=>harness.ui.bridge.refreshJobs());assert.equal(await page.locator('#imageGenerationResult').isVisible(),false);assert.doesNotMatch(await page.locator('#imageGenerationStatus').innerText(),/An image is ready/);assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false);
  complete(second);await page.evaluate(()=>harness.ui.bridge.refreshJobs());await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});assert.match(await page.locator('[data-image-result-info]').innerText(),new RegExp(second));assert.equal(await page.locator('.generation-detail-prompt').inputValue(),'Second exact prompt');
  await page.evaluate(async({first,model})=>harness.ui.switchWorkflow({jobIds:[{id:first,kind:'image'}],settings:{model,quality:'max'}}),{first,model});assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false);assert.equal(await page.locator('#imageQuality').inputValue(),'max');await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});assert.match(await page.locator('[data-image-result-info]').innerText(),new RegExp(first));assert.equal(await page.locator('.generation-detail-prompt').inputValue(),'First exact prompt');assert.equal(await page.evaluate(()=>harness.project.prompt),'Second exact prompt');assert.equal(posts.length,2);assert.equal(await page.evaluate(()=>window.beforeCalls),2);
  await page.screenshot({path:path.join(qa,'scoped-image-result.png')});
});

test('sheet preview follows its workflow and leaves the hoisted tabs usable',async()=>{
  await page.evaluate(async({model})=>{
    const {createDesktopGeneration}=await import('/desktop-sheet-generation.mjs'),{mountSheetCreator}=await import('/sheet-creator.mjs');harness.addSource();
    const bridge=createDesktopGeneration({editor:harness.editor,autoPoll:false});await bridge.prepare();
    const ui=mountSheetCreator({editor:harness.editor,bridge,download:async()=>{},beforeGenerate:async()=>{window.beforeCalls++;window.notesAtCallback=harness.project.sheetPreset.notes;},onQueued:record=>{const state=bridge.state();void ui.switchWorkflow({jobIds:[{id:record.id,kind:'sheet'}],settings:{model:state.model,quality:state.quality}});}});harness.ui=ui;harness.bridge=bridge;await ui.switchWorkflow({jobIds:[],settings:{model,quality:'xhigh'}});ui.open();
  },{model});
  await page.locator('#asunSheetCreator').waitFor({state:'visible'});assert.equal(await page.locator('#workflowTabStrip').evaluate(element=>element.parentElement===document.body),true);await page.locator('#tabFixture').click();assert.equal(await page.evaluate(()=>window.tabClicks),1);assert.deepEqual(await page.evaluate(()=>harness.ui.state()),{opened:true,busy:false,photoEditing:false});
  await page.locator('[data-sheet-notes]').fill('Only use the central building');await page.locator('[data-sheet-action="generate"]').click();await requestCount(1);const first=posts[0].body.requestId;await page.waitForFunction(()=>!harness.ui.state().busy);assert.equal(await page.evaluate(()=>window.notesAtCallback),'Only use the central building');assert.equal(posts[0].body.quality,'xhigh');assert.equal(posts[0].body.project.sheetPreset.notes,'Only use the central building');
  complete(first);await page.evaluate(()=>harness.bridge.refreshJobs());await page.waitForFunction(id=>document.querySelector('[data-sheet-result-image]')?.dataset.job===id,first);
  await page.evaluate(async({other})=>harness.ui.switchWorkflow({jobIds:[],settings:{model:other,quality:'low'}}),{other});assert.equal(await page.locator('[data-sheet-result]').isVisible(),false);assert.equal(await page.locator('[data-sheet-result-image]').getAttribute('src'),null);assert.equal(await page.locator('[data-sheet-quality]').inputValue(),'low');assert.equal(await page.locator('[data-sheet-status]').innerText(),'');
  await page.evaluate(async({first,model})=>harness.ui.switchWorkflow({jobIds:[{id:first,kind:'sheet'}],settings:{model,quality:'xhigh'}}),{first,model});await page.waitForFunction(id=>document.querySelector('[data-sheet-result-image]')?.dataset.job===id,first);assert.match(await page.locator('[data-sheet-generation-details]').innerText(),/xhigh/);assert.equal(posts.length,1);assert.equal(await page.evaluate(()=>window.beforeCalls),1);
  await page.screenshot({path:path.join(qa,'scoped-sheet-result.png')});await page.evaluate(()=>harness.ui.close({preserveProject:true}));assert.equal(await page.locator('#workflowTabStrip').evaluate(element=>element.parentElement.id==='app'&&element.nextElementSibling.id==='afterTabs'),true);assert.equal(await page.locator('#app').evaluate(element=>element.inert),false);
});
