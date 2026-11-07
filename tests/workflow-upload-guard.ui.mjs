import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {newProject,addRaster,addReference,addText,linkReferences,updateLabelComment,attachObjectRegion,updateLayer,serializeProject} from '../public/core.mjs';

const qa=path.resolve('qa/workflow-upload-guard'),model='gpt-image-2.5-sunburst',report={paidCalls:0,cases:[]};
let server,browser,context,page,base,requests,jobs,releases,holdKind,errors,source,output;
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));await browser.close();await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  requests=[];jobs=new Map();releases=[];holdKind=null;errors=[];context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.type()==='beforeunload'?dialog.accept():dialog.dismiss());
  source=await image('#bc8555');output=await image('#448db9');
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());if(url.origin!==base){errors.push('Unexpected external request '+url.origin);return route.abort();}const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/api/generation-queue/status')return json({items:[...jobs.values()].map(({image,...record})=>record)});
    const api=/^\/api\/(images|sheets)\/(.+)$/.exec(url.pathname);if(!api)return route.continue();const kind=api[1]==='images'?'image':'sheet',action=api[2];
    if(action==='status')return json({configured:true,authenticated:true,token:'guard-'+kind,models:[{id:model,label:'GPT Image 2.5 Sunburst',available:true},{id:'gpt-image-1.5',available:true}]});
    assert.equal(request.headers()['x-asun-'+kind+'-token'],'guard-'+kind);
    if(action==='generate'){
      const body=request.postDataJSON();requests.push({kind,...body});if(kind===holdKind)await new Promise(resolve=>releases.push(resolve));
      const record={id:body.requestId,kind,status:'queued',model:body.model,sourceName:body.project.name,createdAt:new Date().toISOString(),settings:{model:body.model,quality:body.quality,prompt:body.project.prompt,inputs:[]}};jobs.set(record.id,record);return json(record,202);
    }
    if(action.startsWith('jobs/')){const id=action.split('/')[1];if(!jobs.has(id))return json({error:'Not found'},404);return json(jobs.get(id));}
    if(action==='history')return json({items:[],nextCursor:null});return json({error:'Unused fixture route'},404);
  });
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();await page.waitForFunction(model=>document.querySelector('#model')?.value===model,model);await page.locator('#newWorkflowTab').waitFor({state:'visible'});
});
afterEach(async info=>{try{if(info.error)await page.screenshot({path:path.join(qa,'failure-'+info.name.replace(/\W+/g,'-')+'.png')});report.cases.push({name:info.name,passed:!info.error,requests:requests.map(({kind,requestId,model,quality})=>({kind,requestId,model,quality}))});assert.deepEqual(errors,[]);}finally{releases.splice(0).forEach(release=>release());await context.close();}});
async function image(color){return page.evaluate(color=>{const c=document.createElement('canvas');c.width=160;c.height=120;const x=c.getContext('2d');x.fillStyle='#eee8dd';x.fillRect(0,0,160,120);x.fillStyle=color;x.fillRect(35,25,90,70);return c.toDataURL();},color);}
function richProject(){
  const added=addRaster(newProject(160,120,'Upload boundary original'),{name:'Original.png',source,width:160,height:120});let project=updateLayer(added.project,added.layerId,{rotation:12,mask:[{mode:'hide',size:5,points:[[10,10],[25,10]]}]});project=addReference(project,{name:'Reference.png',source:output,width:160,height:120});
  const label=addText(project,{content:'1',x:50,y:40,width:18,height:20,fontSize:16,color:'#ff0000'});project=linkReferences(label.project,label.layerId,[project.references[0].id]);project=updateLabelComment(project,label.layerId,'Use the reference only inside this selected area.');project=attachObjectRegion(project,label.layerId,{version:1,assetId:project.original.assetId,rasterLayerId:added.layerId,sourceWidth:160,sourceHeight:120,mask:{width:4,height:4,counts:[5,2,2,2,5]}});project.prompt='Keep all original masks, areas and references.';return project;
}
async function load(project){await page.locator('#projectInput').setInputFiles({name:'Guard source.asun',mimeType:'application/json',buffer:Buffer.from(serializeProject(project))});await page.waitForFunction(count=>document.querySelectorAll('.layer-row').length===count&&!document.body.classList.contains('busy'),project.layers.length);}
async function countRequests(count){for(let i=0;i<150;i++){if(requests.length===count)return;await new Promise(resolve=>setTimeout(resolve,20));}assert.equal(requests.length,count);}
async function save(){await page.waitForFunction(()=>!document.body.classList.contains('busy'));const pending=page.waitForEvent('download');await page.locator('#saveProject').click();const download=await pending,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);await page.waitForTimeout(725);return JSON.parse(Buffer.concat(chunks).toString());}
async function prompt(value){await page.locator('#prompt').fill(value);await page.locator('#prompt').dispatchEvent('change');}
const activeId=()=>page.locator('[data-workflow-tab][aria-selected=true]').getAttribute('data-workflow-tab');
const tabs=()=>page.locator('[data-workflow-tab]').count();
async function switchTo(id){await page.locator(`[data-workflow-tab="${id}"]`).click();await page.waitForFunction(id=>document.querySelector(`[data-workflow-tab="${id}"]`)?.getAttribute('aria-selected')==='true',id);}

test('a sheet cannot submit during an image upload, then submits once in its own workflow after upload finishes',{timeout:45000},async()=>{
  const original=richProject();await load(original);const firstTab=await activeId();await page.locator('#imageQuality').selectOption('max');holdKind='image';await page.locator('#generate').click();await countRequests(1);assert.equal(await page.locator('#generate').getAttribute('aria-busy'),'true');
  await page.locator('#characterItemSheet').click();await page.locator('#asunSheetCreator').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[data-sheet-model]').disabled);await page.locator('[data-sheet-quality]').selectOption('xhigh');await page.locator('[data-sheet-notes]').fill('Only the selected building on white.');await page.locator('[data-sheet-action="generate"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-sheet-status]')?.textContent.includes('other job to finish uploading'));assert.equal(requests.length,1,'The second provider submission is blocked before any POST.');assert.equal(await tabs(),1,'A refused submission does not create an empty fork.');assert.equal(await activeId(),firstTab);assert.equal(await page.locator('#newWorkflowTab').isDisabled(),true);assert.equal(await page.locator('[data-sheet-quality]').inputValue(),'xhigh');
  assert.deepEqual(requests[0].project,original,'The pending image upload keeps its original snapshot.');assert.equal(requests[0].quality,'max');holdKind=null;releases.splice(0).forEach(release=>release());await page.waitForFunction(()=>document.querySelector('#generate').getAttribute('aria-busy')!=='true');await page.waitForFunction(()=>!document.querySelector('[data-sheet-action="generate"]').disabled);
  await page.locator('[data-sheet-action="generate"]').click();await countRequests(2);await page.waitForFunction(()=>document.querySelector('#asunSheetCreator').getAttribute('aria-busy')!=='true');assert.equal(requests[1].kind,'sheet');assert.equal(requests[1].quality,'xhigh');assert.equal(requests[1].project.sheetPreset.notes,'Only the selected building on white.');assert.deepEqual(requests[1].project.references,original.references);assert.deepEqual(requests[1].project.layers,original.layers);assert.equal(await tabs(),2);assert.notEqual(await activeId(),firstTab);assert.equal(new Set(requests.map(request=>request.requestId)).size,2);
  await page.screenshot({path:path.join(qa,'guard-released-sheet-workflow.png')});
});

test('Edit output creates a new tab and switching back restores the entire later draft',{timeout:45000},async()=>{
  await load(richProject());const previousTab=await activeId();await page.locator('#imageQuality').selectOption('max');await page.locator('#generate').click();await countRequests(1);await page.waitForFunction(()=>document.querySelector('#generate').getAttribute('aria-busy')!=='true');
  await prompt('Later unsent changes must stay in the original workflow.');const later=await save(),id=requests[0].requestId;const record=jobs.get(id);jobs.set(id,{...record,status:'completed',finishedAt:new Date().toISOString(),outputAvailable:true,image:{name:'Generated output.png',source:output,width:160,height:120}});
  await page.locator('#imageGenerationResult').waitFor({state:'visible'});await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});await page.locator('[data-image-result-edit]').click();await page.locator('#desktopImageResultDialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelectorAll('[data-workflow-tab]').length===2&&!document.body.classList.contains('busy'));const outputTab=await activeId();assert.notEqual(outputTab,previousTab);assert.equal(await page.locator('#imageEditWorkspaceBar').isVisible(),true);const edited=await save();assert.equal(edited.layers.length,1);assert.equal(edited.assets[edited.layers[0].assetId].source,output);assert.deepEqual(edited.references,[]);assert.equal(edited.prompt,'');assert.match(await page.locator('#imageGenerationStatus').innerText(),/original workflow remains in its tab/);assert.equal(requests.length,1);
  await switchTo(previousTab);assert.deepEqual(await save(),later,'Original masks, detection regions, references, layers and later prompt survive.');assert.equal(await page.locator('#imageQuality').inputValue(),'max');await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});assert.equal(await page.locator('[data-image-result]').getAttribute('src'),output);await page.locator('[data-image-result-close]').first().click();await switchTo(outputTab);assert.deepEqual(await save(),edited);assert.equal(requests.length,1);await page.screenshot({path:path.join(qa,'output-edit-new-tab.png')});
});
