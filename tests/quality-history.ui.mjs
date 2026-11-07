import {test as runTest,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';

const qa=path.resolve('qa','desktop-quality-history'),sunburst='gpt-image-2.5-sunburst',olderModel='gpt-image-1.5';
const qualities=['auto','low','medium','high','xhigh','max'];
const richId='11111111-1111-4111-8111-111111111111',legacyId='22222222-2222-4222-8222-222222222222',failedId='33333333-3333-4333-8333-333333333333',olderId='44444444-4444-4444-8444-444444444444';
let server,browser,context,page,base,errors,requests,records,fixture,historyReads,historyFailure,jobFailure,inputFailure,outputFailure,available;
const report=[];
before(async()=>{await mkdir(qa,{recursive:true});server=createServer({detection:{status:async()=>({available:false}),dispose(){}},sheets:{dispose(){}},images:{dispose(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});});
after(async()=>{await writeFile(path.join(qa,'report.json'),JSON.stringify({kind:'mocked-provider-quality-history-ui',paidCalls:0,cases:report},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
beforeEach(async()=>{
  errors=[];requests=[];records=new Map();historyReads=[];historyFailure=false;jobFailure=false;inputFailure=false;outputFailure=false;available=true;
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  fixture=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=160;c.height=120;const x=c.getContext('2d');x.fillStyle='#efe7da';x.fillRect(0,0,160,120);x.fillStyle='#447d8c';x.fillRect(30,20,100,80);return c.toDataURL('image/png');});
  records.set(richId,complete(richId,'image','max','Historical request exactly.\nUse the attached blue material. <img src=x onerror=alert(1)>'));
  records.set(legacyId,{id:legacyId,status:'completed',mode:'sheet',model:sunburst,sourceName:'Older sheet without recorded settings',createdAt:'2026-10-21T08:00:00.000Z',finishedAt:'2026-10-21T08:01:00.000Z',legacy:true,settings:null,availableInputs:[],outputAvailable:true,output:{width:160,height:120,name:'Legacy sheet.png'},image:{source:fixture,width:160,height:120,name:'Legacy sheet.png'},message:'Completed before settings history existed.'});
  records.set(failedId,{...complete(failedId,'image','high','Failed request'),status:'failed',sourceName:'Failed saved request',message:'QA provider rejected this request. No automatic retry was made.',outputAvailable:false,output:null,image:undefined});
  records.set(olderId,{...complete(olderId,'image','low','Older paginated request'),sourceName:'Older page result',createdAt:'2026-10-20T08:00:00.000Z'});
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());if(url.origin!==base)return route.abort();
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(url.pathname==='/api/generation-queue/status')return json({error:'Legacy mock route'},404);
    const api=/^\/api\/(images|sheets)\/(.+)$/.exec(url.pathname);
    if(!api)return route.continue();
    const kind=api[1]==='images'?'image':'sheet',action=api[2],token=`qa-${kind}-token`;
    if(action==='status')return json({configured:true,authenticated:true,token,defaultQuality:'high',models:[{id:sunburst,label:'GPT Image 2.5 · Sunburst',available,qualities},{id:olderModel,label:'GPT Image 1.5',available:true,qualities:qualities.slice(0,4)}],message:'Mock provider ready.'});
    assert.equal(request.headers()[`x-asun-${kind}-token`],token,`${action} uses the local authorization header.`);assert.equal(url.searchParams.has('token'),false);
    if(action==='generate'){
      assert.equal(request.method(),'POST');const body=request.postDataJSON();requests.push({kind,body});
      const result=complete(body.requestId,kind,body.quality,kind==='sheet'?'Seven views of the selected subject.':body.project.prompt);result.model=body.model;result.settings.model=body.model;result.settings.options.model=body.model;records.set(body.requestId,result);
      return json({id:body.requestId,status:'running'},202);
    }
    if(action==='history'){
      historyReads.push({kind,cursor:url.searchParams.get('cursor')});if(historyFailure)return json({error:'History temporarily unavailable. Please retry.'},503);
      const cursor=url.searchParams.get('cursor'),ids=kind==='sheet'?[legacyId]:cursor?[olderId]:[richId,failedId];
      return json({items:ids.map(id=>summary(records.get(id))),nextCursor:kind==='image'&&!cursor?'older-page':null});
    }
    const match=/^jobs\/([^/]+)(?:\/(output|input)(?:\/(\d+))?)?$/.exec(action);
    if(match){const [,id,asset,index]=match,record=records.get(id);if(!record)return json({error:'Saved job not found.'},404);
      if(asset){if((asset==='input'&&inputFailure)||(asset==='output'&&outputFailure))return json({error:'Saved image unavailable.'},404);if(asset==='input')assert.equal(index,'1');return route.fulfill({status:200,contentType:'image/png',body:Buffer.from(fixture.split(',')[1],'base64')});}
      if(jobFailure)return json({error:'Could not read that saved request. Retry from history.'},500);return json(record);
    }
    return json({error:'Unexpected QA API route'},404);
  });
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();
  await page.waitForFunction(()=>document.querySelector('#imageQuality')?.value==='high');
});
afterEach(async()=>{await context?.close();});
function test(name,run){return runTest(name,async context=>{let passed=false;try{await run(context);assert.deepEqual(errors,[]);passed=true;}finally{if(!passed)await page.screenshot({path:path.join(qa,'failure-'+name.replace(/\W+/g,'-')+'.png')});report.push({name,passed,providerRequestsIntercepted:requests.length,historyReads:historyReads.length});}});}
function complete(id,kind,quality,prompt){return{id,status:'completed',mode:kind,model:sunburst,sourceName:kind==='sheet'?'Saved sheet request':'Saved image request',createdAt:'2026-10-23T08:00:00.000Z',finishedAt:'2026-10-23T08:01:00.000Z',legacy:false,outputAvailable:true,availableInputs:[1],output:{width:160,height:120,name:'QA generated result.png'},image:{source:fixture,width:160,height:120,name:'QA generated result.png'},settings:{model:sunburst,quality,size:'1024x1024',endpoint:'/images/edits',inputCount:1,prompt,options:{model:sunburst,quality,size:'1024x1024',n:1,output_format:'png',background:'opaque'},inputs:[{index:1,role:'original reference photo',name:'Blue material.png',roles:[{role:'original reference photo'}],sha256:'a'.repeat(64),width:160,height:120,mimeType:'image/png',byteLength:Buffer.from(fixture.split(',')[1],'base64').length}]},returned:{},message:'Mocked generation completed.'};}
function summary(record){const result=structuredClone(record);delete result.image;if(result.settings)result.settings={model:result.settings.model,quality:result.settings.quality,size:result.settings.size,endpoint:result.settings.endpoint,inputCount:result.settings.inputCount};return result;}
async function prompt(value){await page.locator('#prompt').fill(value);await page.locator('#prompt').dispatchEvent('change');}
async function ready(){await page.waitForFunction(()=>!document.querySelector('#generate').disabled);}
async function openSheet(){await page.locator('#characterItemSheet').click();await page.locator('#asunSheetCreator').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('[data-sheet-quality]')?.value==='high');}
async function main(){await page.locator('#imageInput').setInputFiles({name:'Source photo.png',mimeType:'image/png',buffer:Buffer.from(fixture.split(',')[1],'base64')});await page.waitForFunction(()=>document.querySelectorAll('.layer-row').length===1&&!document.body.classList.contains('busy'));}
async function closeImage(){await page.locator('[data-image-result-close]').first().click();await page.locator('#desktopImageResultDialog').waitFor({state:'hidden'});}
async function generateImageAndView(){
  await page.locator('#generate').click();
  await page.waitForFunction(()=>document.querySelector('#imageGenerationStatus')?.textContent.includes('An image is ready in Job queue.'));
  assert.equal(await page.locator('#desktopImageResultDialog').isVisible(),false,'Background completion does not interrupt ongoing edits.');
  await page.locator('#imageGenerationResult').click();await page.locator('#desktopImageResultDialog').waitFor({state:'visible'});
}
async function generateSheetAndWait(){
  await page.locator('[data-sheet-action="generate"]').click();
  await page.waitForFunction(()=>document.querySelector('#asunSheetCreator').getAttribute('aria-busy')!=='true');
  const id=requests.at(-1).body.requestId;
  await page.waitForFunction(id=>document.querySelector('[data-sheet-result-image]')?.dataset.job===id,id);
}
async function downloaded(pending){const download=await pending,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);return{name:download.suggestedFilename(),bytes:Buffer.concat(chunks)};}
async function previewsFit(selector){const sizes=await page.locator(selector).evaluateAll(images=>images.map(image=>{const a=image.getBoundingClientRect(),b=image.parentElement.getBoundingClientRect();return{image:{x:a.x,y:a.y,width:a.width,height:a.height},frame:{x:b.x,y:b.y,width:b.width,height:b.height},fit:getComputedStyle(image).objectFit};}));assert.ok(sizes.length>0);for(const {image,frame,fit}of sizes){assert.equal(fit,'contain');assert.ok(image.x>=frame.x-1&&image.y>=frame.y-1&&image.x+image.width<=frame.x+frame.width+1&&image.y+image.height<=frame.y+frame.height+1,'Preview image stays inside its fixed frame without clipping.');}}
async function openHistory(){await page.goto(base+'/generation-history.html');await page.locator('#generationHistoryList .generation-history-card').first().waitFor();}
const card=id=>page.locator(`.generation-history-card[data-job-id="${id}"]`);
async function openRecord(id){await card(id).click();await page.locator('#generationHistoryDetail').waitFor({state:'visible'});await page.locator('#generationHistoryDetails .generation-details').waitFor({state:'visible'});}

test('main and sheet default to high and send all six Sunburst quality values unchanged',async()=>{
  assert.equal(await page.locator('#imageQuality').inputValue(),'high');assert.deepEqual(await page.locator('#imageQuality option').evaluateAll(options=>options.map(option=>option.value)),qualities);
  await prompt('A blue ceramic bird on a wooden shelf.');
  for(const quality of qualities){await page.locator('#imageQuality').selectOption(quality);await ready();await generateImageAndView();assert.equal(requests.at(-1).body.quality,quality);assert.equal(requests.at(-1).body.model,sunburst);await closeImage();}
  await main();await openSheet();assert.equal(await page.locator('[data-sheet-quality]').inputValue(),'high');assert.deepEqual(await page.locator('[data-sheet-quality] option').evaluateAll(options=>options.map(option=>option.value)),qualities);
  for(const quality of qualities){await page.locator('[data-sheet-quality]').selectOption(quality);await generateSheetAndWait();assert.equal(requests.at(-1).kind,'sheet');assert.equal(requests.at(-1).body.quality,quality);assert.equal(requests.at(-1).body.model,sunburst);}
  assert.equal(requests.length,12);
});

test('unsupported quality and unavailable saved models block submission without silent replacement',async()=>{
  await prompt('A ceramic bird.');await page.locator('#imageQuality').selectOption('max');await page.locator('#model').selectOption(olderModel);
  assert.equal(await page.locator('#imageQuality').inputValue(),'max');assert.equal(await page.locator('#generate').isDisabled(),true);assert.equal(await page.locator('#imageQualityMessage').isVisible(),true);assert.match(await page.locator('#imageQualityMessage').innerText(),/supported quality|unsupported|not supported|does not support/i);assert.equal(requests.length,0);
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');if(await page.locator('#skipStartup').isVisible())await page.locator('#skipStartup').click();await page.waitForFunction(()=>document.querySelector('#model')?.value==='gpt-image-1.5');assert.equal(await page.locator('#imageQuality').inputValue(),'max');await prompt('A ceramic bird.');assert.equal(await page.locator('#generate').isDisabled(),true);
  await page.locator('#imageQuality').selectOption('high');await page.locator('#imageOutputAspect').selectOption('3:2');await ready();await page.locator('#model').selectOption(sunburst);available=false;await page.locator('#imageGenerationRefresh').click();await page.waitForFunction(()=>document.querySelector('#model option:checked')?.textContent.includes('unavailable'));
  assert.equal(await page.locator('#model').inputValue(),sunburst);assert.equal(await page.locator('#generate').isDisabled(),true);assert.match(await page.locator('#imageQualityMessage').innerText(),/unavailable/i);assert.equal(requests.length,0);
});

test('completed image and sheet settings remain bound to the original request after controls change',async()=>{
  await prompt('Original immutable request.');await page.locator('#imageQuality').selectOption('max');await ready();await generateImageAndView();
  await closeImage();await prompt('Changed later; must not replace request metadata.');await page.locator('#imageQuality').selectOption('low');await page.locator('#model').selectOption(olderModel);await page.locator('#imageGenerationResult').click();
  const imageDetails=page.locator('[data-image-generation-details]');assert.match(await imageDetails.innerText(),/max/);assert.match(await imageDetails.innerText(),/gpt-image-2.5-sunburst/);assert.equal(await imageDetails.locator('.generation-detail-prompt').inputValue(),'Original immutable request.');await closeImage();
  await main();await openSheet();await page.locator('[data-sheet-quality]').selectOption('xhigh');await generateSheetAndWait();await page.locator('[data-sheet-quality]').selectOption('medium');
  const sheetDetails=page.locator('[data-sheet-generation-details]');assert.match(await sheetDetails.innerText(),/xhigh/);assert.doesNotMatch(await sheetDetails.locator('.generation-detail-prompt').inputValue(),/Changed later/);
  await page.screenshot({path:path.join(qa,'sheet-quality-result-settings.png')});
});

test('history lists old jobs and renders exact saved prompts, request images and honest legacy metadata',async()=>{
  await openHistory();assert.equal(await card(richId).count(),1);assert.equal(await card(legacyId).count(),1);assert.equal(await card(failedId).count(),1);
  await page.waitForFunction(()=>{const images=[...document.querySelectorAll('img.generation-history-thumbnail')];return images.length>=2&&images.every(image=>image.complete&&image.naturalWidth>0&&image.naturalWidth<=480);});
  await previewsFit('img.generation-history-thumbnail');await page.screenshot({path:path.join(qa,'history-list-light.png')});await page.evaluate(()=>{window.__revokedPreviewURLs=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.__revokedPreviewURLs.push(url);revoke(url);};});await openRecord(richId);
  assert.equal(await page.locator('#generationHistoryDetails .generation-detail-prompt').inputValue(),records.get(richId).settings.prompt);assert.match(await page.locator('#generationHistoryDetails').innerText(),/max/);
  await page.waitForFunction(()=>[...document.querySelectorAll('.generation-input-preview')].some(image=>image.tagName==='IMG'&&image.complete&&image.naturalWidth>0));assert.equal(await page.locator('img[src="x"]').count(),0);
  await previewsFit('img.generation-input-preview');
  await page.waitForFunction(()=>!document.querySelector('#generationHistorySave').disabled);const pending=page.waitForEvent('download');await page.locator('#generationHistorySave').click();const saved=await downloaded(pending);assert.match(saved.name,/\.png$/);assert.deepEqual(saved.bytes,Buffer.from(fixture.split(',')[1],'base64'));
  const inputBlobURL=await page.locator('.generation-input-preview').getAttribute('src');await page.locator('#generationHistoryDetails .generation-detail-inputs').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(qa,'history-saved-request.png')});await page.locator('#generationHistoryClose').click();await page.waitForFunction(url=>window.__revokedPreviewURLs.includes(url),inputBlobURL);await openRecord(legacyId);
  assert.match(await page.locator('.generation-detail-legacy').innerText(),/not recorded/i);assert.equal(await page.locator('#generationHistoryDetails .generation-detail-prompt').inputValue(),'Not recorded');
  await page.locator('#generationHistoryClose').click();await openRecord(failedId);assert.match(await page.locator('#generationHistoryDetail').innerText(),/rejected|No automatic retry/i);assert.equal(await page.locator('#generationHistorySave').isDisabled(),true);assert.equal(requests.length,0);
});

test('history survives reload, paginates and filters saved records without generation',async()=>{
  await openHistory();await page.locator('#generationHistoryMore').click();await card(olderId).waitFor();assert.ok(historyReads.some(read=>read.cursor==='older-page'));
  await page.reload();await card(legacyId).waitFor();await page.locator('#generationHistoryFilter').selectOption('sheet');await card(legacyId).waitFor();assert.equal(await page.locator('.generation-history-card[data-kind="image"]').count(),0);
  await page.locator('#generationHistoryFilter').selectOption('image');await card(richId).waitFor();assert.equal(await page.locator('.generation-history-card[data-kind="sheet"]').count(),0);assert.equal(requests.length,0);
});

test('history read failures remain visible and only an explicit refresh retries them',async()=>{
  historyFailure=true;await page.goto(base+'/generation-history.html');await page.waitForFunction(()=>document.querySelector('#generationHistoryStatus')?.textContent.includes('unavailable'));const count=historyReads.length;await page.waitForTimeout(500);assert.equal(historyReads.length,count);
  historyFailure=false;await page.locator('#generationHistoryRefresh').click();await card(richId).waitFor();jobFailure=true;await card(richId).click();await page.waitForFunction(()=>document.body.textContent.includes('Could not read that saved request'));assert.equal(requests.length,0);
  jobFailure=false;inputFailure=true;await page.locator('#generationHistoryDetailRefresh').click();await page.locator('#generationHistoryDetails .generation-details').waitFor();await page.waitForFunction(()=>document.querySelector('.generation-input-state')?.textContent.includes('no longer stored'));assert.equal(await page.locator('.generation-input-preview').count(),0);assert.match(await page.locator('#generationHistoryDetails .generation-detail-prompt').inputValue(),/Historical request exactly/);assert.equal(requests.length,0);
});

test('quality controls and history details fit light and dark compact desktop layouts',async()=>{
  await main();await prompt('A ceramic bird.');await ready();await page.locator('#toast').waitFor({state:'hidden'});
  for(const width of [1440,1024]){await page.setViewportSize({width,height:850});for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);for(const selector of ['#model','#imageQuality','#generate','#imageGenerationHistory','#imageGenerationRefresh']){const bounds=await page.locator(selector).boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width&&bounds.y>=0&&bounds.y+bounds.height<=850);}const a=await page.locator('#imageQuality').boundingBox(),b=await page.locator('#generate').boundingBox();assert.ok(a.x+a.width<=b.x||a.y+a.height<=b.y);await page.locator('.composer').screenshot({path:path.join(qa,`quality-controls-${theme}-${width}.png`)});}}
  await openHistory();await page.locator('#generationHistoryTheme').click();await openRecord(richId);await page.locator('#generationHistoryDetails .generation-detail-inputs').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(qa,'history-detail-compact.png')});const bounds=await page.locator('#generationHistoryDetail').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=1024);assert.equal(requests.length,0);
});
